/** Offline layout emulation, not a security sanitizer for use outside a sandboxed iframe. */
import { html as spec, type DefaultTreeAdapterMap } from 'parse5';
import { boundedHtmlFragment } from '../bounded-html.js';
import { collectCss, color, declarations, namePrefix, stylesheet, wrapperClass, type CssContext } from './css.js';
import { clients, features, support, type Client } from './support.js';

export { clients, type Client };
export type PreviewOptions = { client: Client; theme: 'light' | 'dark'; device?: 'desktop' | 'mobile' };
export type Issue = { feature: string; clients: Client[]; severity: 'warning' | 'error' };
export class PreviewLimitError extends Error {}

type Node = DefaultTreeAdapterMap['childNode'];
type Element = DefaultTreeAdapterMap['element'];
type Document = NonNullable<ReturnType<typeof boundedHtmlFragment>>;
const featureKeys = new Set<string>(features);
const words = (s: string) => new Set(s.split(' '));
const semantic = words('article aside details figcaption figure footer header main mark nav section summary time');
const lists = words('ol ul li dl dt dd');
const attrFeatures = words('align aria-describedby aria-hidden aria-label aria-labelledby aria-live background cellpadding cellspacing dir height hidden lang popover required role srcset target valign width');
const layoutTags = words('a abbr acronym address article aside b bdi bdo big blockquote br button caption center cite code col colgroup dd del details dfn div dl dt em fieldset figcaption figure font footer form h1 h2 h3 h4 h5 h6 header hr i img input ins kbd label legend li main mark meter nav ol optgroup option p picture pre progress q rp rt ruby s samp section select small span strike strong sub summary sup table tbody td textarea tfoot th thead time tr tt u ul var wbr');
const voidTags = words('br col hr img input wbr');
const omitSubtree = words('base embed frame frameset head iframe link meta noembed noframes noscript object plaintext script style template title xmp');
const plainAttrs = words('abbr align alt aria-describedby aria-hidden aria-label aria-labelledby aria-live bgcolor border cellpadding cellspacing char charoff checked class clear color cols colspan compact dir disabled face for frame headers height hidden hspace id label lang multiple nowrap open placeholder reversed role rows rowspan rules scope selected size span start style summary title valign value vspace width');
const encoder = new TextEncoder();
const clipBytes = 102_400; // Gmail web, measured on decoded HTML; not a MIME or mobile guarantee.
const maxBytes = 256 * 1024;
const maxResultBytes = 4 * 1024 * 1024;
const escapeText = (v: string) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
// Gmail web makes visible URLs (even in <pre>) and bare domains look like links. Never emit a
// destination, including Gmail's redirect URL. Match whole, bounded words; ordinary text stays escaped.
function gmailText(value: string): string {
  return value.replace(/\S+/g, word => {
    if (word.length > 2048 || !word.includes('.')) return escapeText(word);
    const parts = /^([("']*)((?:https?:\/\/)?(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,24}(?:[/?#][^\s<>"']*)?)([),.!?:;'"\]]*)$/i.exec(word);
    if (!parts) return escapeText(word);
    const [, before, url, after] = parts;
    // Observed soft wrap points follow separators near 30 characters in long auto-linked URLs.
    let col = 0, label = '';
    for (const segment of url!.split(/(?<=[/?&])/)) {
      if (col && col + segment.length > 30) { label += '<wbr>'; col = 0; }
      label += escapeText(segment); col += segment.length;
    }
    return `${escapeText(before!)}<a role="link">${label}</a>${escapeText(after!)}`;
  });
}
const attr = (name: string, v: string) => ` ${name}="${escapeText(v).replaceAll('"', '&quot;')}"`;
const attrValue = (el: Element, name: string) => el.attrs.find(a => a.name === name)?.value ?? '';
const text = (el: Element) => el.childNodes.map(node => 'value' in node ? node.value : '').join('');
const isMetaScheme = (el: Element) => el.tagName === 'meta' && /^(?:supported-)?color-scheme$/i.test(attrValue(el, 'name'));

function tagFeature(el: Element): string {
  const tag = el.tagName;
  if (semantic.has(tag)) return 'html-semantics';
  if (lists.has(tag)) return 'html-lists';
  if (/^h[1-6]$/.test(tag)) return 'html-h1-h6';
  if (tag === 'map' || tag === 'area') return 'html-image-maps';
  if (tag === 'input' || tag === 'button') return `html-${tag}-${attrValue(el, 'type').toLowerCase() || (tag === 'input' ? 'text' : 'submit')}`;
  if (isMetaScheme(el)) return 'html-meta-color-scheme';
  return `html-${tag}`;
}

function parse(html: string, onParseError?: (error: {code: string}) => void) {
  const doc = boundedHtmlFragment(html, 'document', {onParseError});
  if (!doc) throw new PreviewLimitError('HTML exceeds the preview complexity budget.');
  return doc;
}

function inspect(doc: Document, conditional?: string[]) {
  const found = new Set<string>();
  function visit(node: Node) {
    if ('data' in node && node.nodeName === '#comment') {
      found.add('html-comments');
      // Only positive Word conditions: other clients see an ordinary comment. Parse them once as a
      // single bounded fragment for lint, never copy VML, scripts or conditional text into a render.
      const mso = /^\s*\[if\s+(?:(?:gte?|lte?)\s+)?mso(?:\s+\d+)?\s*\]>([\s\S]*)<!\[endif\]\s*$/i.exec(node.data);
      if (mso) conditional?.push(mso[1]!);
    }
    if (node.nodeName === '#documentType') found.add('html-doctype');
    if (!('tagName' in node)) return;
    const tag = node.tagName;
    // parse5 supplies an implicit body even to fragments. Don't diagnose it on every snippet.
    if (tag !== 'body' || node.attrs.length) found.add(tagFeature(node));
    if (tag === 'style') collectCss(text(node), false, found);
    for (const { name, value } of node.attrs) {
      if (attrFeatures.has(name)) found.add(`html-${name}`);
      if (name === 'style') collectCss(value, true, found);
      if (name === 'inert') found.add('css-inert-attribute');
      if (name === 'loading' || name === 'command') found.add(`html-${name}-attribute`);
      if (tag === 'a' && name === 'href') {
        if (value.trim().startsWith('#')) found.add('html-anchor-links');
        if (/^mailto:/i.test(value.trim())) found.add('html-mailto-links');
      }
      if ((tag === 'img' && name === 'src') || name === 'background') {
        const image = /^data:image\/([^;,]+)/i.exec(value)?.[1];
        if (image && /^data:[^,]*;base64,/i.test(value)) found.add('image-base64');
        const format = image || /\.([a-z\d]+)(?:[?#].*)?$/i.exec(value)?.[1];
        if (format) found.add(`image-${format.toLowerCase().replace(/^jpeg$/, 'jpg').replace(/^svg\+xml$/, 'svg')}`);
      }
    }
    for (const child of node.childNodes) visit(child);
  }
  for (const child of doc.childNodes) visit(child);
  return [...found].filter(key => featureKeys.has(key)).sort();
}

function analyze(doc: Document, classic: boolean) {
  const mso: string[] = [], keys = inspect(doc, classic ? mso : undefined);
  const classicKeys = mso.length ? [...new Set([...keys, ...inspect(parse(mso.join('\n')))])].sort() : keys;
  return { keys, classicKeys };
}

function findings(keys: string[], targets: readonly Client[]) {
  const issues: Issue[] = [];
  for (const feature of keys) {
    const error: Client[] = [], warning: Client[] = [];
    for (const client of targets) {
      const status = support(feature, client);
      // Unknown is not affirmative support (notably new Outlook for Windows). Warnings are advisory.
      if (status === 'no') error.push(client);
      else if (status !== 'yes') warning.push(client);
    }
    if (error.length) issues.push({ feature, clients: error, severity: 'error' });
    if (warning.length) issues.push({ feature, clients: warning, severity: 'warning' });
  }
  return issues;
}

function size(html: string) {
  if (html.length > maxBytes) throw new PreviewLimitError('HTML exceeds 256 KiB.');
  const bytes = encoder.encode(html);
  if (bytes.length > maxBytes) throw new PreviewLimitError('HTML exceeds 256 KiB.');
  return bytes;
}

export function lint(html: string, onParseError?: (error: {code: string}) => void): Issue[] {
  size(html);
  const {keys, classicKeys} = analyze(parse(html, onParseError), true), common = new Set(keys);
  return [...findings(keys, clients), ...findings(classicKeys.filter(key => !common.has(key)), ['outlook-classic-windows'])];
}

// Fixed first meta, before any sender-controlled markup. Links never carry the destination or submit data;
// only inline raster images can load. An iframe's sandbox alone does NOT prevent remote tracking requests.
const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'; base-uri 'none'; connect-src 'none'">`;
const childElement = (parent: {childNodes: Node[]}, tag: string) => parent.childNodes.find((n): n is Element => 'tagName' in n && n.tagName === tag);
function render(doc: Document, options: PreviewOptions, clipped: boolean): string {
  const client = options.client === 'outlook-new-windows' ? 'outlook-web' : options.client;
  const gmail = client.startsWith('gmail-'), outlook = client.startsWith('outlook-'), yahoo = client === 'yahoo-web' || client === 'aol-web';
  const webmail = gmail || outlook || yahoo;
  const html = childElement(doc, 'html')!, head = childElement(html, 'head')!, body = childElement(html, 'body');
  const metas = head.childNodes.filter((n): n is Element => 'tagName' in n && isMetaScheme(n));
  const schemes = metas.map(n => attrValue(n, 'content').toLowerCase().trim());
  const device = options.device ?? (/ios|android|samsung/.test(client) ? 'mobile' : 'desktop');
  const ctx: CssContext = { client, theme: options.theme, width: device === 'mobile' ? 390 : 800,
    lightOnly: schemes.some(s => /^(?:light only|only light)$/.test(s)), appleColorScheme: schemes.some(s => s.split(/\s+/).includes('dark')) };
  const viewport = ctx.width;
  if (client === 'samsung-email' && device === 'mobile' && body) {
    // Samsung's default auto-fit follows HTML width attributes, not CSS widths. Approximate its
    // layout viewport and zoom separately; the native app also enlarges selected text (not modeled).
    // https://customer.io/learn/mobile-marketing/fix-samsung-email-autofit
    function scan(el: Element) {
      const width = attrValue(el, 'width').trim();
      if (/^\d{1,4}$/.test(width) && layoutTags.has(el.tagName)) ctx.width = Math.max(ctx.width, Math.min(4096, Number(width)));
      for (const child of el.childNodes) if ('tagName' in child) scan(child);
    }
    scan(body);
  }
  const prefix = namePrefix(client), wrapper = wrapperClass(client);
  const styles: string[] = [];
  function attrs(el: Element, bodyClass = '') {
    let result = '', className = bodyClass;
    const linked = el.tagName === 'a' && el.attrs.some(a => a.name === 'href');
    for (const { name, value, namespace } of el.attrs) {
      if (namespace || (attrFeatures.has(name) && support(`html-${name}`, client) === 'no')) continue;
      if (name === 'class') className += ' ' + value.split(/\s+/).filter(Boolean).map(v => prefix + v).join(' ');
      else if (name === 'id') result += attr(name, prefix + value);
      else if (name === 'style') {
        const inline = declarations(value, ctx);
        if (inline) result += attr('style', inline);
        // Outlook exposes the original colors on recolored nodes. Only emit markers for simple
        // color declarations we actually changed (stylesheet cascade/inheritance isn't computed).
        if (outlook && ctx.theme === 'dark') {
          const originals = new Map<string, string>();
          for (const m of value.matchAll(/(?:^|;)\s*(color|background-color)\s*:\s*(#[\da-f]{3,8}|[a-z]+|rgba?\([\d.,%\s]+\))\s*(?:!important\s*)?(?=;|$)/gi)) originals.set(m[1]!.toLowerCase(), m[2]!);
          for (const [property, original] of originals) if (color(original, property, ctx) !== original) result += attr(property === 'color' ? 'data-ogsc' : 'data-ogsb', original);
        }
      } else if (linked && name === 'role') {
        continue;
      } else if (name === 'src' && el.tagName === 'img') {
        if (support('image-base64', client) !== 'no' && /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[\da-z+/=\s]+$/i.test(value)) result += attr(name, value);
      } else if (el.tagName === 'input' && name === 'type') {
        if (/^(?:text|checkbox|radio|submit|reset|hidden|button)$/i.test(value)) result += attr(name, value);
      } else if (name === 'bgcolor' || name === 'color') {
        const mapped = color(value, name === 'bgcolor' ? 'background-color' : 'color', ctx);
        result += attr(name, mapped);
        if (outlook && ctx.theme === 'dark' && mapped !== value) result += attr(name === 'bgcolor' ? 'data-ogab' : 'data-ogac', value);
      } else if (plainAttrs.has(name) || (!webmail && /^data-[a-z][\w-]*$/.test(name))) result += attr(name, /^(?:aria-labelledby|aria-describedby|headers|for)$/.test(name) ? value.split(/\s+/).map(v => prefix + v).join(' ') : value);
    }
    // A fragment-only destination in srcdoc can resolve against the embedding page. Style as a link, but never navigate.
    return result + (linked ? ' role="link"' : '') + (className.trim() ? attr('class', className.trim()) : '');
  }
  function style(el: Element, inHead: boolean) {
    if ((gmail && !inHead) || support('html-style', client) === 'no' || client.endsWith('-non-google')) return;
    let css = text(el);
    if (gmail && encoder.encode(css).length > 16_384) return; // caniemail html-style #6
    const media = attrValue(el, 'media');
    if (media) {
      if (!/^[\w\s():.,/-]+$/.test(media)) return;
      css = `@media ${media}{${css}}`;
    }
    const filtered = stylesheet(css, ctx);
    if (filtered) styles.push(filtered.replaceAll('<', '\\3c '));
  }
  function node(n: Node, canLink = client === 'gmail-web'): string {
    if ('value' in n && n.nodeName === '#text') return canLink ? gmailText(n.value) : escapeText(n.value);
    if (!('tagName' in n) || n.namespaceURI !== spec.NS.HTML) return '';
    const tag = n.tagName;
    if (tag === 'style') { style(n, false); return ''; }
    if (omitSubtree.has(tag)) return '';
    const content = n.childNodes.map(child => node(child, canLink && tag !== 'a' && tag !== 'textarea' && tag !== 'option')).join('');
    if (!layoutTags.has(tag)) return content;
    const feature = tagFeature(n);
    if (gmail && ['details', 'main', 'nav', 'summary', 'picture'].includes(tag)) return `<u></u>${content}<u></u>`;
    if (outlook && semantic.has(tag) && tag !== 'time') return content;
    if (support(feature, client) === 'no') return content;
    // Only explicit quote wrappers. A bare blockquote can be new content. Thread similarity needs history.
    if (gmail || yahoo) {
      const quotes = gmail ? 'gmail_quote' : 'yahoo_quoted';
      if (attrValue(n, 'class').split(/\s+/).includes(quotes)) return `<details><summary>${gmail ? 'Show trimmed content' : 'Show original message'}</summary>${content}</details>`;
    }
    const a = attrs(n);
    if (voidTags.has(tag)) return `<${tag}${a}>`;
    // No navigable form exists (including implicit submissions from Enter). Keep layout and controls, not an action.
    const renderedTag = tag === 'form' ? 'div' : tag;
    return `<${renderedTag}${a}>${content}</${renderedTag}>`;
  }
  for (const n of head.childNodes) if ('tagName' in n && n.tagName === 'style') style(n, true);
  const content = body?.childNodes.map(child => node(child)).join('') ?? '';
  const after = clipped ? '<div>[Message clipped] &nbsp; View entire message</div>' : '';
  // Measured in a desktop Gmail message body, not the fonts of the surrounding inbox UI.
  const inherited = client === 'gmail-web' ? 'font:13px/1.5 Arial,Helvetica,sans-serif;' : gmail ? 'font:14px Arial,Helvetica,sans-serif;' : client === 'outlook-web' ? 'font:15px "Segoe UI","Segoe UI Web (West European)",-apple-system,system-ui,Roboto,"Helvetica Neue",sans-serif;' : outlook ? 'font:15px "Segoe UI",Arial,sans-serif;' : yahoo ? 'font:16px Arial,sans-serif;' : '';
  const ink = client === 'gmail-web' ? '#222222' : client === 'outlook-web' && ctx.theme === 'light' ? '#242424' : '#000000';
  const canvas = `background-color:${color('#ffffff', 'background-color', ctx)};color:${color(ink, 'color', ctx)};`;
  const fit = ctx.width > viewport ? `html{width:${ctx.width}px;zoom:${viewport / ctx.width}}` : '';
  const wrap = client.startsWith('apple-mail') || client === 'samsung-email' ? 'overflow-wrap:break-word;' : '';
  const pane = client === 'gmail-web' ? `.${wrapper}{position:relative;overflow:auto hidden}` : '';
  const linkColor = client === 'outlook-web' && ctx.theme === 'light' ? '#0000ee' : '#1155cc';
  const defaults = `${fit}body{margin:${webmail ? 0 : '8px'};${wrap}${inherited}${canvas}}${pane}:where(a[role=link]){color:${linkColor};text-decoration:underline}`;
  const docType = doc.childNodes.some(n => n.nodeName === '#documentType');
  const inner = webmail ? `<div${attr('class', wrapper)}>${gmail && docType ? '<u></u>' : ''}<div${body && client !== 'outlook-mac' ? attrs(body, 'bane-mail-body') : ' class="bane-mail-body"'}>${content}</div>${after}</div>` : content + after;
  return `<!doctype html><html${webmail ? '' : attrs(html, wrapper)}><head>${csp}<meta name="referrer" content="no-referrer"><meta name="viewport" content="width=${viewport},initial-scale=1"><style>${defaults}\n${styles.join('\n')}</style></head><body${!webmail && body ? attrs(body) : ''}>${inner}</body></html>`;
}

/** Parse and lint once for all requested profiles. Classic Word's layout has no browser equivalent. */
export function emulateMany(html: string, options: Omit<PreviewOptions, 'client'> & { clients: readonly Client[] }) {
  const bytes = size(html), doc = parse(html), { keys, classicKeys } = analyze(doc, options.clients.includes('outlook-classic-windows'));
  let truncated: Document | undefined, total = 0;
  return options.clients.map(client => {
    const clipped = client.startsWith('gmail-') && bytes.length > clipBytes;
    if (clipped && !truncated) truncated = parse(new TextDecoder().decode(bytes.subarray(0, clipBytes), { stream: true }));
    const result = client === 'outlook-classic-windows' ? '' : render(clipped ? truncated! : doc, { ...options, client }, clipped);
    total += encoder.encode(result).length;
    if (total > maxResultBytes) throw new PreviewLimitError('Rendered HTML exceeds 4 MiB. Request fewer clients.');
    return { client, html: result, issues: findings(client === 'outlook-classic-windows' ? classicKeys : keys, [client]) };
  });
}

export function emulate(html: string, options: PreviewOptions): { html: string; issues: Issue[] } {
  const [preview] = emulateMany(html, { ...options, clients: [options.client] });
  return { html: preview!.html, issues: preview!.issues };
}
