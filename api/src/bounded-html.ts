import { defaultTreeAdapter, Parser, Tokenizer } from 'parse5';

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

/** Bound tree construction, not a traversal of an already expensive parse. */
export function boundedHtmlFragment(html: string, mode: 'fragment' | 'document' = 'fragment') {
  const started = performance.now(), depth = new WeakMap<object, number>();
  let nodes = 0, open = 0, attributeBytes = 0;
  const tick = () => {
    if (++nodes > 20_000 || ((nodes & 255) === 0 && performance.now() - started > 250)) throw new TreeBudgetExceeded();
  };
  const place = (parent: object, child: object) => {
    const level = (depth.get(parent) ?? 0) + 1;
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
  try {
    // Direct sends may be full documents. Fragment mode alone would discard
    // attributes on html/body and silently skip their URL validation.
    // Mail is read without scripting (so is the dashboard's preview): <noscript> content is markup like
    // any other, not text, and is counted, validated and projected with the rest of the tree.
    const options = { treeAdapter, scriptingEnabled: false };
    const parser = mode === 'document' ? new Parser(options) : Parser.getFragmentParser(null, options);
    const tokenizer = new BoundedTokenizer(parser.options, parser);
    tokenizer.state = parser.tokenizer.state;
    tokenizer.inForeignNode = parser.tokenizer.inForeignNode;
    parser.tokenizer = tokenizer;
    tokenizer.write(html, true);
    return mode === 'document' ? parser.document : parser.getFragment();
  }
  catch (e) { if (e instanceof TreeBudgetExceeded) return null; throw e; }
}
