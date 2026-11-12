import { defaultTreeAdapter, html as spec, Parser, Tokenizer, type DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type ChildNode = DefaultTreeAdapterMap['childNode'];
type Fragment = DefaultTreeAdapterMap['documentFragment'];

class TreeBudgetExceeded extends Error {}
// createElement is too late: parse5 searches all preceding attribute names before
// emitting a tag. Count at the tokenizer boundary (duplicates and end tags too).
class BoundedTokenizer extends Tokenizer {
  private lastTag: typeof this.currentToken = null;
  private attrs = 0;
  protected override _createAttr(first: string) {
    if (this.lastTag !== this.currentToken) { this.lastTag = this.currentToken; this.attrs = 0; }
    if (++this.attrs > 256) throw new TreeBudgetExceeded();
    super._createAttr(first);
  }
}

// Outlook reads the inside of <!--[if mso]>…<![endif]--> (any condition) as part of the message.
const CONDITIONAL = /^\[if\b[^\]<>]*\]>([\s\S]*)<!\[endif\]$/i;
// Their content is text to this parser, and markup to a client that does not load frames or plugins.
const FALLBACK = new Set(['iframe', 'noembed', 'noframes']);

/**
 * Bound tree construction, not a traversal of an already expensive parse. Null when the budget is exceeded.
 * Mail is read without scripting (so is the dashboard's preview): <noscript> content is markup like any other.
 *
 * `clients` asks for the tree as mail clients may build it, not only as this parser does, for whoever validates or
 * screens what a message shows. Where the parser keeps data that a client may read as markup, that markup is parsed
 * under the same budget and hangs under its node:
 *  - as `childNodes` of a conditional comment, which Outlook shows: a walker that follows childNodes reads it in place;
 *  - as `content`, like a <template>'s, for what only a lenient client reads: any other comment, the fallback text of
 *    <iframe>, <noembed> and <noframes>, and an iframe's srcdoc. A walker that validates follows `content` too; one
 *    that reads what is shown does not.
 * A serializer writes these nodes as they came.
 */
export function boundedHtmlFragment(html: string, mode: 'fragment' | 'document' = 'fragment', { clients = false } = {}) {
  const started = performance.now(), depth = new WeakMap<object, number>();
  // base: the tree depth of the node whose data is being parsed, so markup inside it counts from there.
  let nodes = 0, open = 0, attributeBytes = 0, base = 0;
  const late = () => performance.now() - started > 250;
  const tick = () => {
    if (++nodes > 20_000 || ((nodes & 255) === 0 && late())) throw new TreeBudgetExceeded();
  };
  const place = (parent: object, child: object) => {
    const level = (depth.get(parent) ?? base) + 1;
    if (level > 256) throw new TreeBudgetExceeded();
    depth.set(child, level);
  };
  const treeAdapter: typeof defaultTreeAdapter = {
    ...defaultTreeAdapter,
    createElement: (tag, ns, attrs) => {
      tick();
      for (const a of attrs) {
        attributeBytes += Buffer.byteLength(a.name) + Buffer.byteLength(a.value);
        if (attributeBytes > 512 * 1024) throw new TreeBudgetExceeded();
      }
      return defaultTreeAdapter.createElement(tag, ns, attrs);
    },
    createCommentNode: data => { tick(); return defaultTreeAdapter.createCommentNode(data); },
    appendChild: (parent, child) => { place(parent, child); defaultTreeAdapter.appendChild(parent, child); },
    insertBefore: (parent, child, ref) => { place(parent, child); defaultTreeAdapter.insertBefore(parent, child, ref); },
    // Templates and table foster parenting can separate parser stack depth from tree depth.
    onItemPush: () => { if (++open > 256) throw new TreeBudgetExceeded(); },
    onItemPop: () => { open--; },
  };
  function parse(source: string, as: 'document'): DefaultTreeAdapterMap['document'];
  function parse(source: string, as: 'fragment'): Fragment;
  function parse(source: string, as: 'fragment' | 'document') {
    open = 0;
    const options = { treeAdapter, scriptingEnabled: false };
    const parser = as === 'document' ? new Parser(options) : Parser.getFragmentParser(null, options);
    const tokenizer = new BoundedTokenizer(parser.options, parser);
    tokenizer.state = parser.tokenizer.state;
    tokenizer.inForeignNode = parser.tokenizer.inForeignNode;
    parser.tokenizer = tokenizer;
    tokenizer.write(source, true);
    return as === 'document' ? parser.document : parser.getFragment();
  }
  try {
    // Direct sends may be full documents. Fragment mode alone would discard
    // attributes on html/body and silently skip their URL validation.
    const root = mode === 'document' ? parse(html, 'document') : parse(html, 'fragment');
    // A worklist, not recursion: markup read from a comment can hold comments of its own.
    const pending: Node[] = clients ? [root] : [];
    while (pending.length) {
      const node = pending.pop()!;
      const comment = 'data' in node && node.nodeName === '#comment' ? node : undefined;
      const shown = comment ? CONDITIONAL.exec(comment.data.trim())?.[1] : undefined;
      // The comment's end may have cut a tag short: close it, as a reader that does not honour the comment would.
      const sources = shown !== undefined ? [shown] : comment ? [comment.data + '>']
        : 'tagName' in node && node.namespaceURI === spec.NS.HTML && FALLBACK.has(node.tagName)
          ? [node.childNodes.map(child => 'value' in child ? child.value : '').join(''), node.attrs.find(a => a.name === 'srcdoc')?.value ?? '']
          : [];
      // Each source is parsed on its own, so an unclosed construct in one cannot swallow the other. Text alone is
      // only worth a parse where it is shown.
      const read = sources.filter(source => shown !== undefined ? source.trim() : source.includes('<')).map(source => {
        if (late()) throw new TreeBudgetExceeded();
        base = depth.get(node) ?? 0;
        return parse(source, 'fragment');
      });
      if (read.length) {
        const [first, ...rest] = read as [Fragment, ...Fragment[]];
        for (const other of rest) for (const child of other.childNodes) { child.parentNode = first; first.childNodes.push(child); }
        if (shown !== undefined) {
          (node as unknown as { childNodes: ChildNode[] }).childNodes = first.childNodes;
          for (const child of first.childNodes) child.parentNode = node as unknown as ChildNode['parentNode'];
        } else (node as unknown as { content: Fragment }).content = first;
      }
      if ('childNodes' in node) for (const child of node.childNodes) pending.push(child);
      if ('content' in node) pending.push((node as unknown as { content: Fragment }).content);
    }
    return root;
  }
  catch (e) { if (e instanceof TreeBudgetExceeded) return null; throw e; }
}
