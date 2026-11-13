// The HTML a probation sender's message is delivered as: the copy the content screen read. Style sheet rules are
// first inlined onto the elements they select (specificity and source order, like a mail inliner; at-rules and
// pseudo-elements are left out), then the markup is reduced to the elements and inline styles a mail client shows as
// text. Nothing that hides, moves, shrinks, recolors or generates text survives: no style sheets, scripts, comments,
// conditional comments, templates, noscript, foreign content or form controls; no visibility, opacity, position,
// float, clip, transform, overflow, filter, blend mode, generated content, bidi override, negative spacing, type under
// 8 px, background images, or text in its background color. An element the light-scheme rendering does not display
// (display:none, the hidden attribute) is left out with its content, so a dark-mode image swap resolves to the light
// image and a mobile-only block to its desktop state. What a recipient can read is then exactly the text the screen
// reads. One hidden block is kept: the preheader, the first text of the message when its own style hides it, at most
// 300 characters of plain text, which is screened like the rest. Text the markup would draw without screened words
// (list markers with letters or chosen numbers, list items without text) is left out, images count by their declared
// size against the words beside them, and the bidi controls, directions and layout properties that reorder what a
// client draws are removed from every textual field and element. Trusted senders keep their markup.
import { defaultTreeAdapter, html as spec, serializeOuter, type DefaultTreeAdapterMap } from 'parse5';
import { boundedHtmlFragment } from './bounded-html.js';
import { ApiError } from './core.js';

type Node = DefaultTreeAdapterMap['childNode'];
type Element = DefaultTreeAdapterMap['element'];
type Parent = DefaultTreeAdapterMap['parentNode'];
const HTML = spec.NS.HTML;
const isElement = (node: Node): node is Element => 'tagName' in node;
const isText = (node: Node): node is DefaultTreeAdapterMap['textNode'] => node.nodeName === '#text';
const tooLarge = () => new ApiError(422, 'CONTENT_TOO_LARGE_TO_SCREEN', 'Shorten the message so Hosted sending can screen it.');
// Embeddings, overrides and isolates reorder what a client draws, so a probation message's text is delivered without
// them in every field; the weak marks that only place punctuation stay.
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;
export const screenedText = (value: string) => value.replace(BIDI_CONTROLS, '');
/** A file name as a client shows it: no format characters or other default-ignorable code points at all. */
export const screenedName = (value: string) => value.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '');
/** Words made of characters a client draws: letters and digits that are not default-ignorable (Hangul fillers and
 *  the like render as blanks). The one definition of a word wherever the screen counts text. */
export const VISIBLE_WORDS = /(?:(?!\p{Default_Ignorable_Code_Point})[\p{L}\p{N}])+/gu;
export const visibleWords = (text: string) => text.match(VISIBLE_WORDS)?.length ?? 0;
// Pictures carry words the screen cannot read: a probation message is refused when its images, by the size a client
// draws them at, outweigh the words beside them. A 200 x 200 logo needs none; every further 600 x 300 needs 25 words.
const IMAGE_FREE_PIXELS = 200 * 200, IMAGE_PIXELS_PER_WORD = 600 * 300 / 25;
const imageOnly = () => new ApiError(422, 'CONTENT_IMAGE_ONLY', 'Add body text beside the images so Hosted sending can screen the message.');

// ----- Attachments --------------------------------------------------------------------------------------------------

// What a probation sender may attach: a standard extension whose declared type and bytes agree with it. Inline
// attachments must be raster images. Anything a client renders as a document of text the screen never read (markup,
// mail) is refused whatever it is called.
type Family = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'tiff' | 'pdf' | 'zip' | 'ole' | 'gzip' | '7z' | 'rar' | 'mp3' | 'mp4' | 'wav' | 'ogg' | 'webm' | 'rtf';
const ATTACHMENT_TYPES: Record<string, { types: string[]; family?: Family }> = {
  png: { types: ['image/png'], family: 'png' }, jpg: { types: ['image/jpeg'], family: 'jpeg' }, jpeg: { types: ['image/jpeg'], family: 'jpeg' }, gif: { types: ['image/gif'], family: 'gif' },
  webp: { types: ['image/webp'], family: 'webp' }, bmp: { types: ['image/bmp', 'image/x-ms-bmp'], family: 'bmp' }, tif: { types: ['image/tiff'], family: 'tiff' }, tiff: { types: ['image/tiff'], family: 'tiff' },
  pdf: { types: ['application/pdf'], family: 'pdf' }, zip: { types: ['application/zip', 'application/x-zip-compressed'], family: 'zip' }, gz: { types: ['application/gzip', 'application/x-gzip'], family: 'gzip' },
  '7z': { types: ['application/x-7z-compressed'], family: '7z' }, rar: { types: ['application/vnd.rar', 'application/x-rar-compressed'], family: 'rar' },
  docx: { types: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], family: 'zip' }, xlsx: { types: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], family: 'zip' },
  pptx: { types: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'], family: 'zip' }, odt: { types: ['application/vnd.oasis.opendocument.text'], family: 'zip' },
  ods: { types: ['application/vnd.oasis.opendocument.spreadsheet'], family: 'zip' }, odp: { types: ['application/vnd.oasis.opendocument.presentation'], family: 'zip' },
  doc: { types: ['application/msword'], family: 'ole' }, xls: { types: ['application/vnd.ms-excel'], family: 'ole' }, ppt: { types: ['application/vnd.ms-powerpoint'], family: 'ole' },
  mp3: { types: ['audio/mpeg'], family: 'mp3' }, mp4: { types: ['video/mp4'], family: 'mp4' }, m4a: { types: ['audio/mp4', 'audio/x-m4a'], family: 'mp4' }, wav: { types: ['audio/wav', 'audio/x-wav', 'audio/wave'], family: 'wav' },
  ogg: { types: ['audio/ogg', 'video/ogg', 'application/ogg'], family: 'ogg' }, webm: { types: ['video/webm', 'audio/webm'], family: 'webm' }, rtf: { types: ['application/rtf', 'text/rtf'], family: 'rtf' },
  txt: { types: ['text/plain'] }, csv: { types: ['text/csv'] }, tsv: { types: ['text/tab-separated-values'] }, json: { types: ['application/json'] }, ics: { types: ['text/calendar'] }, vcf: { types: ['text/vcard', 'text/x-vcard'] }, md: { types: ['text/markdown'] },
};
const RASTER = new Set<Family>(['png', 'jpeg', 'gif', 'webp', 'bmp']);
const DOCUMENT_TYPES = new Set(['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml', 'message/rfc822', 'multipart/related', 'application/x-mimearchive']);
const DOCUMENT_EXTENSIONS = new Set(['svg', 'svgz', 'html', 'htm', 'xhtml', 'xht', 'xml', 'mht', 'mhtml', 'eml']);
/** The family the first bytes announce, if this reader knows it. */
function signature(bytes: Uint8Array): Family | undefined {
  const at = (offset: number, hex: string) => hex.split(' ').every((byte, i) => bytes[offset + i] === parseInt(byte, 16));
  const ascii = (offset: number, text: string) => [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (at(0, '89 50 4e 47 0d 0a 1a 0a')) return 'png';
  if (at(0, 'ff d8 ff')) return 'jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp';
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'wav';
  if (ascii(0, 'BM')) return 'bmp';
  if (at(0, '49 49 2a 00') || at(0, '4d 4d 00 2a')) return 'tiff';
  if (ascii(0, '%PDF-')) return 'pdf';
  if (at(0, '50 4b 03 04') || at(0, '50 4b 05 06')) return 'zip';
  if (at(0, 'd0 cf 11 e0 a1 b1 1a e1')) return 'ole';
  if (at(0, '1f 8b')) return 'gzip';
  if (at(0, '37 7a bc af 27 1c')) return '7z';
  if (ascii(0, 'Rar!')) return 'rar';
  if (ascii(0, 'ID3') || at(0, 'ff fb') || at(0, 'ff f3') || at(0, 'ff f2')) return 'mp3';
  if (ascii(4, 'ftyp')) return 'mp4';
  if (ascii(0, 'OggS')) return 'ogg';
  if (at(0, '1a 45 df a3')) return 'webm';
  if (ascii(0, '{\\rtf')) return 'rtf';
  return undefined;
}
/** Bytes a client would render as markup or as a mail message. */
function document(bytes: Uint8Array) {
  let head = ''; for (const byte of bytes.subarray(0, 4096)) head += String.fromCharCode(byte);
  const text = head.replace(/^(?:\xef\xbb\xbf|\xff\xfe|\xfe\xff)?\s*/, '').toLowerCase();
  return text.startsWith('<') || (/^[a-z][\w-]*:\s/.test(text) && /\n(?:mime-version|content-type):/.test(text));
}
/** The name and type a probation sender's attachment is delivered under, or the reason it is not: its declared type
 *  (application/octet-stream meaning unspecified), normalized extension and bytes must agree. */
export function screenedAttachment(filename: string, contentType: string, bytes: Uint8Array, inline: boolean): { filename: string; contentType: string } {
  const name = screenedName(filename).replace(/[. ]+$/, ''), extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '', type = contentType.split(';')[0]!.trim().toLowerCase();
  const unscreenable = (why: string) => new ApiError(422, 'ATTACHMENT_TYPE_UNSCREENABLE', `Hosted sending cannot screen ${name}: ${why} while the sender is on probation.`);
  const mismatch = (why: string) => new ApiError(422, 'ATTACHMENT_CONTENT_MISMATCH', `Hosted sending cannot deliver ${name}: ${why} while the sender is on probation.`);
  if (DOCUMENT_TYPES.has(type) || DOCUMENT_EXTENSIONS.has(extension) || document(bytes)) throw unscreenable('markup, SVG and mail archives are not delivered');
  const expected = own(ATTACHMENT_TYPES, extension);
  if (!expected) throw mismatch('attachments need a standard extension (images, PDF, office documents, archives, audio, video or plain text)');
  if (type !== 'application/octet-stream' && !expected.types.includes(type)) throw mismatch(`a .${extension} file must be sent as ${expected.types[0]}, not ${type}`);
  const found = signature(bytes);
  if (expected.family ? found !== expected.family : found !== undefined) throw mismatch(`the content is not a ${extension} file`);
  if (inline && !RASTER.has(expected.family!)) throw unscreenable('inline attachments must be PNG, JPEG, GIF, WebP or BMP images');
  return { filename: screenedName(filename), contentType: type === 'application/octet-stream' ? expected.types[0]! : contentType };
}
/** A record's own entry, never an inherited one: tag, attribute and property names come from the message. */
const own = <T>(record: Record<string, T>, key: string): T | undefined => Object.hasOwn(record, key) ? record[key] : undefined;

// ----- Values ------------------------------------------------------------------------------------------------------

type Rgb = [number, number, number];
const NAMED = new Map<string, Rgb>(('aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32')
  .split(' ').map(entry => { const [name, hex] = entry.split(':') as [string, string]; return [name, [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)) as Rgb]; }));
/** A plain color (hex, rgb(), rgba(), named) as RGB and alpha; anything else, transparent and currentcolor included, is not one. */
function colorOf(token: string): { rgb: Rgb; alpha: number } | undefined {
  const v = token.toLowerCase();
  const named = NAMED.get(v);
  if (named) return { rgb: named, alpha: 1 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const long = hex.length <= 4 ? [...hex].map(c => c + c).join('') : hex, at = (i: number) => parseInt(long.slice(i, i + 2), 16);
    return { rgb: [at(0), at(2), at(4)], alpha: long.length === 8 ? at(6) / 255 : 1 };
  }
  const rgb = /^rgba?\((\d{1,3}%?),(\d{1,3}%?),(\d{1,3}%?)(?:,(\d*\.?\d+%?))?\)$/.exec(v);
  if (!rgb) return undefined;
  const channel = (s: string) => Math.min(255, s.endsWith('%') ? Math.round(parseFloat(s) * 2.55) : Number(s));
  const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
  return { rgb: [channel(rgb[1]!), channel(rgb[2]!), channel(rgb[3]!)], alpha: Math.min(1, Math.max(0, alpha)) };
}
const blend = (over: Rgb, alpha: number, under: Rgb): Rgb => over.map((c, i) => Math.round(c * alpha + under[i]! * (1 - alpha))) as Rgb;
const luminance = (c: Rgb) => { const lin = (n: number) => { const s = n / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); };
const contrast = (a: Rgb, b: Rgb) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]; return (high + 0.05) / (low + 0.05); };
const READABLE = 1.6, MIN_FONT_PX = 8;

/** A length in px; em and rem at the given size, pt at 4/3, % of the given base. Undefined for anything else. */
function px(token: string, em = 16, base = em): number | undefined {
  const m = /^(-?\d*\.?\d+)(px|pt|em|rem|%)?$/.exec(token);
  if (!m) return undefined;
  const n = parseFloat(m[1]!);
  switch (m[2]) { case 'px': return n; case 'pt': return n * 4 / 3; case 'em': return n * em; case 'rem': return n * 16; case '%': return n * base / 100; default: return n === 0 ? 0 : undefined; }
}
const KEYWORD_PX: Record<string, number> = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };
const fontPx = (token: string, parent: number) => own(KEYWORD_PX, token) ?? (token === 'larger' ? parent * 1.2 : token === 'smaller' ? parent / 1.2 : px(token, parent, parent));
const family = (v: string) => /^[\w\s,'"-]+$/.test(v) ? v : undefined;
const lineHeight = (v: string) => v === 'normal' || /^\d*\.?\d+$/.test(v) && parseFloat(v) >= 0.8 || (px(v, 16, 16) ?? 0) >= 10 ? v : undefined;
const within = (token: string, max: number) => { const n = px(token, 16, 300); return n !== undefined && n >= 0 && n <= max; };
const keywords = (...words: string[]) => (v: string) => words.includes(v) ? v : undefined;
const each = (ok: (token: string) => boolean, max = 4) => (v: string) => { const tokens = v.split(' '); return tokens.length <= max && tokens.every(ok) ? v : undefined; };
const BORDER_STYLE = ['none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'];
const borderToken = (t: string) => ['thin', 'medium', 'thick', ...BORDER_STYLE].includes(t) || within(t, 50) || !!colorOf(t);
// Markers that spell nothing: bullets, or the item's own count.
const LIST_TYPES = ['none', 'disc', 'circle', 'square', 'decimal'];
/** Inline properties a client may apply, each with the values it may take. Colors and sizes are handled with the element's state. */
const PROPERTIES: Record<string, (value: string) => string | undefined> = {
  'font-family': family, 'font-weight': keywords('normal', 'bold', 'bolder', 'lighter', '100', '200', '300', '400', '500', '600', '700', '800', '900'),
  'font-style': keywords('normal', 'italic', 'oblique'), 'font-variant': keywords('normal', 'small-caps'), 'line-height': lineHeight,
  'letter-spacing': v => v === 'normal' || within(v, 20) ? v : undefined, 'word-spacing': v => v === 'normal' || within(v, 40) ? v : undefined,
  'text-align': keywords('left', 'right', 'center', 'justify', 'start', 'end'), 'text-transform': keywords('none', 'uppercase', 'lowercase', 'capitalize'),
  'vertical-align': v => ['baseline', 'sub', 'super', 'top', 'text-top', 'middle', 'bottom', 'text-bottom'].includes(v) || Math.abs(px(v) ?? Infinity) <= 50 ? v : undefined,
  'text-decoration': each(t => ['none', 'underline', 'overline', 'line-through', 'solid', 'double', 'dotted', 'dashed', 'wavy'].includes(t) || !!colorOf(t)),
  'text-decoration-line': each(t => ['none', 'underline', 'overline', 'line-through'].includes(t)), 'text-decoration-style': keywords('solid', 'double', 'dotted', 'dashed', 'wavy'), 'text-decoration-color': v => colorOf(v) ? v : undefined,
  'white-space': keywords('normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line'), 'word-break': keywords('normal', 'break-all', 'keep-all', 'break-word'),
  'overflow-wrap': keywords('normal', 'break-word', 'anywhere'), 'word-wrap': keywords('normal', 'break-word'),
  display: keywords('block', 'inline', 'inline-block', 'list-item'), 'box-sizing': keywords('border-box', 'content-box'), 'table-layout': keywords('auto', 'fixed'),
  'list-style-type': keywords(...LIST_TYPES), 'list-style-position': keywords('inside', 'outside'), 'list-style': each(t => LIST_TYPES.includes(t) || t === 'inside' || t === 'outside', 2),
  'border-collapse': keywords('collapse', 'separate'), 'border-spacing': each(t => within(t, 50), 2), 'border-radius': each(t => within(t, 300)),
  '-webkit-text-size-adjust': keywords('100%', 'none', 'auto'), '-ms-text-size-adjust': keywords('100%', 'none', 'auto'),
};
for (const side of ['', '-top', '-right', '-bottom', '-left']) {
  PROPERTIES[`margin${side}`] = each(t => t === 'auto' || within(t, 300), side ? 1 : 4);
  PROPERTIES[`padding${side}`] = each(t => within(t, 300), side ? 1 : 4);
  PROPERTIES[`border${side}`] = each(borderToken, 3);
  for (const part of ['width', 'style', 'color']) PROPERTIES[`border${side}-${part}`] = each(borderToken, side ? 1 : 4);
}
for (const p of ['width', 'min-width', 'max-width', 'height', 'min-height', 'max-height']) PROPERTIES[p] = v => v === 'auto' || v === 'none' || within(v, Infinity) ? v : undefined;

// ----- Style sheets, inlined -----------------------------------------------------------------------------------------

type Declaration = { property: string; value: string; important: boolean };
type Compound = { tag?: string; ids: string[]; classes: string[]; attributes: { name: string; op?: string; value?: string }[]; pseudo: { name: string; argument?: string }[]; not: Compound[] };
type Selector = { compounds: Compound[]; combinators: string[]; specificity: number };
type Rule = { selector: Selector; declarations: Declaration[]; order: number };
type Facts = { id: number; tag: string; attrs: Map<string, string>; classes: Set<string>; chain: Set<string>; parent: Facts | null; index: number; typeIndex: number; siblings: number; typeSiblings: number; previous: Facts | null };
const MAX_SHEET_BYTES = 256 * 1024, MAX_RULES = 4000, MAX_STEPS = 2_000_000;
const PSEUDO = new Set(['first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type', 'only-of-type', 'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type']);
/** Comments removed, outside string literals. */
function stripComments(css: string) {
  let out = '', quote = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (quote) { out += c; if (c === '\\' && i + 1 < css.length) out += css[++i]; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === '/' && css[i + 1] === '*') { const end = css.indexOf('*/', i + 2); i = end < 0 ? css.length : end + 1; out += ' '; continue; }
    out += c;
  }
  return out;
}
function declarations(body: string): Declaration[] {
  const out: Declaration[] = [];
  for (const item of body.split(';')) {
    const colon = item.indexOf(':');
    if (colon < 1) continue;
    const property = item.slice(0, colon).trim().toLowerCase(), important = /!\s*important\s*$/i.test(item), value = item.slice(colon + 1).replace(/!\s*important\s*$/i, '').trim();
    if (property && value) out.push({ property, value, important });
  }
  return out;
}
/** The qualified rules of a sheet in source order; at-rules (media, supports, font-face, import) are left out. */
function rules(sheet: string, out: Rule[]) {
  const css = sheet.replace(/@(?:import|charset|namespace|layer)\b(?:url\([^)]*\)|"[^"]*"|'[^']*'|[^;{])*;/gi, ' ');
  for (let i = 0; i < css.length && out.length < MAX_RULES;) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let level = 1, j = open + 1;
    for (; j < css.length && level; j++) { if (css[j] === '{') level++; else if (css[j] === '}') level--; }
    const body = css.slice(open + 1, level ? css.length : j - 1);
    i = j;
    if (!prelude || prelude.startsWith('@')) continue;
    const parsed = declarations(body);
    if (!parsed.length) continue;
    for (const text of prelude.split(',')) {
      const selector = parseSelector(text.replace(/\s+/g, ' ').trim());
      if (selector) out.push({ selector, declarations: parsed, order: out.length });
    }
  }
  return out;
}
/** One compound: type, classes, ids, attribute tests, structural pseudo-classes and :not(). Anything else makes the selector one this inliner never applies. */
function parseCompound(text: string): Compound | null {
  const compound: Compound = { ids: [], classes: [], attributes: [], pseudo: [], not: [] };
  let i = 0;
  const ident = () => { const m = /^[-\w\u00a0-\uffff]+/.exec(text.slice(i)); if (!m) return null; i += m[0].length; return m[0].toLowerCase(); };
  while (i < text.length) {
    const c = text[i]!;
    if (c === '*') i++;
    else if (c === '.') { i++; const name = ident(); if (!name) return null; compound.classes.push(name); }
    else if (c === '#') { i++; const name = ident(); if (!name) return null; compound.ids.push(name); }
    else if (c === '[') {
      const end = text.indexOf(']', i); if (end < 0) return null;
      const m = /^\s*([-\w]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?\s*$/.exec(text.slice(i + 1, end)); if (!m) return null;
      compound.attributes.push({ name: m[1]!.toLowerCase(), op: m[2], value: m[3] ?? m[4] ?? m[5] });
      i = end + 1;
    }
    else if (c === ':') {
      if (text[i + 1] === ':') return null;
      i++; const name = ident(); if (!name) return null;
      let argument: string | undefined;
      if (text[i] === '(') { const end = text.indexOf(')', i); if (end < 0) return null; argument = text.slice(i + 1, end); i = end + 1; }
      if (name === 'not') { const inner = argument && parseCompound(argument.trim()); if (!inner) return null; compound.not.push(inner); continue; }
      if (!PSEUDO.has(name)) return null;
      compound.pseudo.push({ name, argument });
    }
    else if (/[-\w]/.test(c)) { const name = ident(); if (!name) return null; compound.tag = name; }
    else return null;
  }
  return compound;
}
function parseSelector(text: string): Selector | null {
  const tokens = text.match(/\[[^\]]*\]|\([^)]*\)|[>+~]|\s+|[^\s>+~[(]+/g) ?? [];
  const compounds: Compound[] = [], combinators: string[] = [];
  let buffer = '', pending: string | null = null;
  const flush = () => { if (!buffer) return true; const compound = parseCompound(buffer); buffer = ''; if (!compound) return false; if (compounds.length) combinators.push(pending ?? ' '); compounds.push(compound); pending = null; return true; };
  for (const token of tokens) {
    if (/^\s+$/.test(token)) { if (!flush()) return null; if (pending === null && compounds.length) pending = ' '; }
    else if (token === '>' || token === '+' || token === '~') { if (!flush()) return null; pending = token; }
    else buffer += token;
  }
  if (!flush() || !compounds.length || pending) return null;
  const weight = (c: Compound): number => c.ids.length * 10000 + (c.classes.length + c.attributes.length + c.pseudo.length) * 100 + (c.tag ? 1 : 0) + c.not.reduce((n, inner) => n + weight(inner), 0);
  return { compounds, combinators, specificity: compounds.reduce((n, c) => n + weight(c), 0) };
}
function nth(argument: string | undefined, position: number) {
  const a = (argument ?? '').replace(/\s+/g, '').toLowerCase();
  if (a === 'odd') return position % 2 === 1;
  if (a === 'even') return position % 2 === 0;
  const m = /^([+-]?\d*)n([+-]\d+)?$|^([+-]?\d+)$/.exec(a);
  if (!m) return false;
  if (m[3] !== undefined) return position === Number(m[3]);
  const step = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : Number(m[1]), offset = Number(m[2] ?? 0);
  if (step === 0) return position === offset;
  const k = (position - offset) / step;
  return Number.isInteger(k) && k >= 0;
}
function matchesCompound(facts: Facts, compound: Compound): boolean {
  if (compound.tag && compound.tag !== facts.tag) return false;
  for (const id of compound.ids) if (facts.attrs.get('id')?.toLowerCase() !== id) return false;
  for (const name of compound.classes) if (!facts.classes.has(name)) return false;
  for (const { name, op, value } of compound.attributes) {
    const actual = facts.attrs.get(name);
    if (actual === undefined) return false;
    if (op === undefined) continue;
    const expected = value ?? '';
    const ok = op === '=' ? actual === expected : op === '~=' ? actual.split(/\s+/).includes(expected) : op === '|=' ? actual === expected || actual.startsWith(expected + '-')
      : op === '^=' ? actual.startsWith(expected) : op === '$=' ? actual.endsWith(expected) : op === '*=' ? actual.includes(expected) : false;
    if (!ok) return false;
  }
  for (const inner of compound.not) if (matchesCompound(facts, inner)) return false;
  for (const { name, argument } of compound.pseudo) {
    switch (name) {
      case 'first-child': if (facts.index !== 1) return false; break;
      case 'last-child': if (facts.index !== facts.siblings) return false; break;
      case 'only-child': if (facts.siblings !== 1) return false; break;
      case 'first-of-type': if (facts.typeIndex !== 1) return false; break;
      case 'last-of-type': if (facts.typeIndex !== facts.typeSiblings) return false; break;
      case 'only-of-type': if (facts.typeSiblings !== 1) return false; break;
      case 'nth-child': if (!nth(argument, facts.index)) return false; break;
      case 'nth-last-child': if (!nth(argument, facts.siblings - facts.index + 1)) return false; break;
      case 'nth-of-type': if (!nth(argument, facts.typeIndex)) return false; break;
      case 'nth-last-of-type': if (!nth(argument, facts.typeSiblings - facts.typeIndex + 1)) return false; break;
    }
  }
  return true;
}
/** The sheets of a message as a function from an element to the declarations its rules give it, in cascade order
 *  (least to most authoritative), with the element's own style attribute last. Bounded by sheet size, rule count and
 *  matching steps; a message past the step budget is too large to screen. */
function inliner(sheets: string[], tree: Map<Element, Facts>) {
  const parsed: Rule[] = [];
  const text = sheets.join('\n');
  if (text.length <= MAX_SHEET_BYTES) rules(stripComments(text), parsed);
  // Indexed by the subject compound's first class, id or type, with the classes and ids a selector needs anywhere.
  const index = new Map<string, { rule: Rule; needs: string[] }[]>();
  for (const rule of parsed) {
    const last = rule.selector.compounds[rule.selector.compounds.length - 1]!;
    const key = last.classes.length ? `.${last.classes[0]}` : last.ids.length ? `#${last.ids[0]}` : last.tag ?? '*';
    const entry = { rule, needs: rule.selector.compounds.flatMap(c => [...c.classes.map(n => `.${n}`), ...c.ids.map(n => `#${n}`)]) };
    const list = index.get(key); if (list) list.push(entry); else index.set(key, [entry]);
  }
  let steps = 0;
  const matches = (facts: Facts, selector: Selector): boolean => {
    const { compounds, combinators } = selector;
    const walk = (at: number, subject: Facts | null): boolean => {
      if (!subject) return false;
      if (++steps > MAX_STEPS) throw tooLarge();
      if (!matchesCompound(subject, compounds[at]!)) return false;
      if (at === 0) return true;
      const combinator = combinators[at - 1];
      if (combinator === '>') return walk(at - 1, subject.parent);
      if (combinator === '+') return walk(at - 1, subject.previous);
      if (combinator === '~') { for (let p = subject.previous; p; p = p.previous) if (walk(at - 1, p)) return true; return false; }
      for (let p = subject.parent; p; p = p.parent) if (walk(at - 1, p)) return true;
      return false;
    };
    return walk(compounds.length - 1, facts);
  };
  return (element: Element): Declaration[] => {
    const facts = tree.get(element), inline = declarations(stripComments(element.attrs.find(a => a.name === 'style')?.value ?? ''));
    if (!facts || !parsed.length) return inline;
    const candidates = [...(index.get('*') ?? []), ...(index.get(facts.tag) ?? [])];
    const id = facts.attrs.get('id')?.toLowerCase(); if (id) candidates.push(...index.get(`#${id}`) ?? []);
    for (const name of facts.classes) candidates.push(...index.get(`.${name}`) ?? []);
    type Candidate = Declaration & { specificity: number; order: number };
    const all: Candidate[] = [];
    for (const { rule, needs } of candidates) if (needs.every(need => facts.chain.has(need)) && matches(facts, rule.selector)) for (const d of rule.declarations) all.push({ ...d, specificity: rule.selector.specificity, order: rule.order });
    inline.forEach((d, i) => all.push({ ...d, specificity: 1e6, order: 1e9 + i }));
    const rank = (c: Candidate) => (c.important ? 1e12 : 0) + c.specificity * 1e5 + c.order;
    const winners = new Map<string, Candidate>();
    for (const c of all) { const current = winners.get(c.property); if (!current || rank(c) >= rank(current)) winners.set(c.property, c); }
    return [...winners.values()].sort((a, b) => rank(a) - rank(b)).map(({ property, value, important }) => ({ property, value, important }));
  };
}
/** Element facts for selector matching, over the tree as submitted. */
function survey(root: Element): Map<Element, Facts> {
  const tree = new Map<Element, Facts>();
  let count = 0;
  const visit = (parent: Element, facts: Facts | null) => {
    const elements = parent.childNodes.filter((node): node is Element => isElement(node) && node.namespaceURI === HTML);
    const types = new Map<string, number>();
    let previous: Facts | null = null;
    for (const [i, element] of elements.entries()) {
      const attrs = new Map(element.attrs.map(a => [a.name, a.value])), classes = new Set((attrs.get('class') ?? '').toLowerCase().split(/\s+/).filter(Boolean));
      const chain = new Set(facts?.chain ?? []); for (const name of classes) chain.add(`.${name}`); const id = attrs.get('id'); if (id) chain.add(`#${id.toLowerCase()}`);
      const typeIndex = (types.get(element.tagName) ?? 0) + 1; types.set(element.tagName, typeIndex);
      const own: Facts = { id: ++count, tag: element.tagName, attrs, classes, chain, parent: facts, index: i + 1, typeIndex, siblings: elements.length, typeSiblings: 0, previous };
      tree.set(element, own); previous = own;
      visit(element, own);
    }
    for (const element of elements) tree.get(element)!.typeSiblings = types.get(element.tagName)!;
  };
  visit(root, null);
  return tree;
}

// ----- Elements and attributes -------------------------------------------------------------------------------------

/** Elements that stay, with the attributes they keep besides style, dir and lang. Any other element is unwrapped, its
 *  text staying in the flow, except those a client never shows as text, which go with their content. */
const KEPT: Record<string, string[]> = {
  a: ['href'], abbr: [], address: [], article: [], aside: [], b: [], bdi: [], big: [], blockquote: [], br: [], caption: ['align'], center: [], cite: [], code: [],
  col: ['span', 'width', 'align', 'valign'], colgroup: ['span', 'width', 'align', 'valign'], dd: [], del: [], dfn: [], div: ['align'], dl: [], dt: [], em: [], figcaption: [], figure: [],
  font: ['color', 'face', 'size'], footer: [], h1: ['align'], h2: ['align'], h3: ['align'], h4: ['align'], h5: ['align'], h6: ['align'], header: [], hr: ['align', 'width', 'size', 'noshade'], i: [],
  img: ['src', 'alt', 'width', 'height', 'border', 'align', 'hspace', 'vspace'], ins: [], kbd: [], li: [], main: [], mark: [], nav: [], ol: [], p: ['align'], pre: [], q: [], s: [],
  samp: [], section: [], small: [], span: [], strike: [], strong: [], sub: [], sup: [], table: ['role', 'width', 'height', 'align', 'bgcolor', 'border', 'cellpadding', 'cellspacing'],
  tbody: ['align', 'valign'], td: ['width', 'height', 'align', 'valign', 'bgcolor', 'colspan', 'rowspan', 'nowrap'], tfoot: ['align', 'valign'], th: ['width', 'height', 'align', 'valign', 'bgcolor', 'colspan', 'rowspan', 'nowrap'],
  thead: ['align', 'valign'], time: [], tr: ['align', 'valign', 'bgcolor', 'height'], tt: [], u: [], ul: [], var: [], wbr: [],
};
const DROPPED = new Set(['script', 'style', 'template', 'noscript', 'noembed', 'noframes', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'title', 'xml', 'canvas', 'audio', 'video', 'source', 'track', 'map', 'area',
  'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'datalist', 'output', 'progress', 'meter', 'dialog', 'slot']);
const digits = (v: string) => /^\d{1,4}$/.test(v) ? v : undefined;
const ATTRIBUTES: Record<string, (value: string) => string | undefined> = {
  href: v => /^(?:https?:|mailto:|tel:)/i.test(v.trim()) ? v.trim() : undefined, src: v => /^(?:https?:|cid:|data:image\/)/i.test(v.trim()) ? v.trim() : undefined, alt: v => screenedText(v),
  lang: v => /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(v) ? v : undefined, role: keywords('presentation', 'none'),
  align: keywords('left', 'center', 'right', 'justify', 'top', 'middle', 'bottom'), valign: keywords('top', 'middle', 'bottom', 'baseline'),
  width: v => /^\d{1,4}%?$/.test(v) ? v : undefined, height: v => /^\d{1,4}%?$/.test(v) ? v : undefined, border: digits, cellpadding: digits, cellspacing: digits, colspan: digits, rowspan: digits, span: digits,
  start: digits, value: digits, hspace: v => digits(v) && Number(v) <= 300 ? v : undefined, vspace: v => digits(v) && Number(v) <= 300 ? v : undefined, size: v => /^[1-7]$/.test(v) ? v : undefined,
  bgcolor: v => colorOf(v) ? v : undefined, color: v => colorOf(v) ? v : undefined, face: family, type: keywords('1', 'a', 'A', 'i', 'I', 'disc', 'circle', 'square'), nowrap: () => '', noshade: () => '',
};
const META = { charset: () => 'utf-8', name: keywords('viewport', 'color-scheme', 'supported-color-schemes', 'x-apple-disable-message-reformatting', 'format-detection'), 'http-equiv': keywords('content-type', 'x-ua-compatible'), content: (v: string) => /^[\w\s,;=:./-]{0,200}$/.test(v) ? v : undefined };
const FONT_SIZE_ATTRIBUTE: Record<string, number> = { 1: 10, 2: 13, 3: 16, 4: 18, 5: 24, 6: 32, 7: 48 };
const UA_SCALE: Record<string, number> = { small: 1 / 1.2, sub: 1 / 1.2, sup: 1 / 1.2, big: 1.2, h5: 0.83, h6: 0.67 };
const PREHEADER_STYLE = 'display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all';
const hides = (style: string) => /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?|max-height\s*:\s*0(?:px)?|font-size\s*:\s*[01](?:\.\d+)?(?:px|pt)?)\s*(?:;|$)/i.test(style);

type State = { fontPx: number; color: Rgb; background: Rgb };
export function screenedHtml(html: string, previewText?: string): string {
  let copy = pass(html, previewText);
  // Misnested formatting elements can make a parser read the serialized tree back differently; the copy is read again
  // until it reads as itself, so a client parses exactly what was screened.
  for (let i = 0; i < 2; i++) { const again = pass(copy, previewText); if (again === copy) break; copy = again; }
  return copy;
}
/** What the probation pass read of an HTML body, for the support lint (src/deliverability.ts). */
export type HtmlStats = { words: number; imageArea: number; images: number; hiddenWords: number; recoloredWords: number };
/**
 * The probation pass's own reading of an HTML body, without refusing it: visible words, images by the area a client
 * draws them at, words hidden by markup (not displayed, invisible, zero-sized) and words drawn in their background
 * color, and how many more words the image rule (a 200 x 200 picture free, 25 words per further 600 x 300) asks for.
 */
export function screenedHtmlStats(html: string) {
  const stats: HtmlStats = { words: 0, imageArea: 0, images: 0, hiddenWords: 0, recoloredWords: 0 };
  pass(html, undefined, stats);
  const required = Math.max(0, Math.ceil((stats.imageArea - IMAGE_FREE_PIXELS) / IMAGE_PIXELS_PER_WORD));
  return { ...stats, wordsRequiredByImages: required, imageRulePasses: stats.words >= required };
}
function pass(html: string, previewText?: string, stats?: HtmlStats): string {
  if (html.length > 512 * 1024) throw tooLarge();
  const document = boundedHtmlFragment(html, 'document');
  if (!document) throw tooLarge();
  const root = document.childNodes.find((node): node is Element => isElement(node) && node.tagName === 'html')!;
  const part = (tag: 'head' | 'body') => {
    let found = root.childNodes.find((node): node is Element => isElement(node) && node.tagName === tag);
    // A frameset document has no body; the copy gets an empty one.
    if (!found) { found = defaultTreeAdapter.createElement(tag, HTML, []); defaultTreeAdapter.appendChild(root, found); }
    return found;
  };
  const head = part('head'), body = part('body');
  const sheets: string[] = [];
  const collect = (parent: Parent) => { for (const node of parent.childNodes) if (isElement(node) && node.namespaceURI === HTML) { if (node.tagName === 'style') sheets.push(node.childNodes.map(child => isText(child) ? child.value : '').join('')); else collect(node); } };
  collect(root);
  const styles = inliner(sheets, survey(root));
  let seenText = false, words = 0, imageArea = 0;
  const wordsIn = (node: Node): number => isText(node) ? visibleWords(node.value) : isElement(node) ? node.childNodes.reduce((n, child) => n + wordsIn(child), 0) : 0;
  const detach = (node: Node) => defaultTreeAdapter.detachNode(node);
  const attributes = (element: Element, allowed: Record<string, (value: string) => string | undefined>) => {
    element.attrs = element.attrs.flatMap(a => { const value = own(allowed, a.name)?.(a.value); return value === undefined ? [] : [{ name: a.name, value }]; });
  };
  /** The declarations a client may apply from the element's merged style, and the state its text inherits. */
  const styled = (element: Element, inherited: State, merged: Declaration[]) => {
    const state = { ...inherited }, kept = new Map<string, string>();
    const bgcolor = element.attrs.find(a => a.name === 'bgcolor')?.value, fontColor = element.tagName === 'font' ? element.attrs.find(a => a.name === 'color')?.value : undefined;
    const fontSize = element.tagName === 'font' ? own(FONT_SIZE_ATTRIBUTE, element.attrs.find(a => a.name === 'size')?.value ?? '') : undefined;
    const paint = (token: string) => { const c = colorOf(token); if (c) state.background = blend(c.rgb, c.alpha, state.background); };
    if (bgcolor) paint(bgcolor);
    if (fontColor) { const c = colorOf(fontColor)!; state.color = blend(c.rgb, c.alpha, state.background); }
    if (fontSize) state.fontPx = fontSize;
    const scale = own(UA_SCALE, element.tagName);
    if (scale) state.fontPx *= scale;
    for (const { property, value: raw } of merged) {
      // One space between tokens, none inside parentheses; a value with anything but rgb()/rgba() in parentheses, an
      // escape or a comment is not one this reader applies.
      const value = raw.toLowerCase().replace(/\s*\(\s*([^)]*?)\s*\)/g, (_, inner: string) => `(${inner.replace(/\s*,\s*/g, ',').replace(/\s+/g, ',')})`).replace(/\s+/g, ' ');
      if (!value || /\\|\/\*|[{}]/.test(value)) continue;
      // A background keeps its color and loses its image.
      if (property === 'background-color' || property === 'background') {
        const color = value.split(' ').find(token => colorOf(token));
        if (!color) continue;
        paint(color); kept.set('background-color', color);
      }
      else if (/(?<!rgba?)\(/.test(value)) continue;
      else if (property === 'color') { const c = colorOf(value); if (!c) continue; state.color = blend(c.rgb, c.alpha, state.background); kept.set(property, value); }
      else if (property === 'font-size') { const size = fontPx(value, state.fontPx); if (size === undefined || size < MIN_FONT_PX) continue; state.fontPx = size; kept.set(property, value); }
      else if (property === 'font') {
        const m = /^(?:(?:normal|italic|oblique|small-caps|bold|bolder|lighter|[1-9]00) )*([\w.%-]+)(?:\/([\w.%]+))? ([\w\s,'"-]+)$/.exec(value);
        const size = m ? fontPx(m[1]!, state.fontPx) : undefined;
        if (!m || size === undefined || size < MIN_FONT_PX || (m[2] && !lineHeight(m[2])) || !family(m[3]!)) continue;
        state.fontPx = size; kept.set(property, value);
      }
      else { const checked = own(PROPERTIES, property)?.(value); if (checked !== undefined) kept.set(property, checked); }
    }
    if (state.fontPx < MIN_FONT_PX) { state.fontPx = MIN_FONT_PX; kept.set('font-size', `${MIN_FONT_PX}px`); }
    return { state, kept, style: [...kept].map(([property, value]) => `${property}:${value}`).join(';') };
  };
  const clean = (parent: Parent, inherited: State) => {
    for (let i = 0; i < parent.childNodes.length;) {
      const node = parent.childNodes[i]!;
      if (isText(node)) {
        node.value = screenedText(node.value);
        if (node.value.trim()) {
          seenText = true; words += wordsIn(node);
          // Text drawn in its background color is recolored so it reads as the screen read it.
          if (contrast(inherited.color, inherited.background) < READABLE) {
            if (stats) stats.recoloredWords += wordsIn(node);
            const ink = contrast([0, 0, 0], inherited.background) >= contrast([255, 255, 255], inherited.background) ? '#000000' : '#ffffff';
            const span = defaultTreeAdapter.createElement('span', HTML, [{ name: 'style', value: `color:${ink}` }]);
            defaultTreeAdapter.insertBefore(parent, span, node); detach(node); defaultTreeAdapter.appendChild(span, node);
          }
        }
        i++; continue;
      }
      if (!isElement(node) || node.namespaceURI !== HTML || DROPPED.has(node.tagName) || node.attrs.some(a => a.name === 'data-bane-preview' || a.name === 'data-opensend-preview')) { detach(node); continue; }
      const merged = styles(node), style = merged.map(d => `${d.property}:${d.value}`).join(';');
      const text = node.childNodes.every(isText) ? node.childNodes.map(child => (child as DefaultTreeAdapterMap['textNode']).value).join('') : undefined;
      if (!seenText && (node.tagName === 'div' || node.tagName === 'p') && hides(style) && text?.trim() && text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim().length <= 300) {
        node.attrs = [{ name: 'style', value: PREHEADER_STYLE }];
        for (const child of node.childNodes) if (isText(child)) child.value = screenedText(child.value);
        seenText = true; i++; continue;
      }
      // Not displayed in the light scheme: left out with its content, as a client would.
      if (node.attrs.some(a => a.name === 'hidden') || merged.find(d => d.property === 'display')?.value.trim().toLowerCase() === 'none') { if (stats) stats.hiddenWords += wordsIn(node); detach(node); continue; }
      if (stats && hides(style)) stats.hiddenWords += wordsIn(node);
      const allowed = own(KEPT, node.tagName);
      if (!allowed) {
        // Unwrap: the children take the element's place and are read in turn.
        for (const child of node.childNodes.slice()) { detach(child); defaultTreeAdapter.insertBefore(parent, child, node); }
        detach(node); continue;
      }
      attributes(node, Object.fromEntries([...allowed, 'lang'].map(name => [name, ATTRIBUTES[name]!])));
      const { state, kept: declared } = styled(node, inherited, merged);
      node.attrs = node.attrs.filter(a => a.name !== 'style');
      if (node.tagName === 'img') {
        // The size a client draws it at: the larger of the attribute and the style (a minimum could only enlarge it,
        // so none is kept), a full-width picture when neither is declared.
        for (const property of ['min-width', 'min-height']) declared.delete(property);
        const length = (v: string | undefined) => v === undefined ? undefined : /%$/.test(v) ? Math.round(parseFloat(v) * 6) : /^\d+$/.test(v) ? Number(v) : px(v);
        const side = (name: 'width' | 'height') => { const sizes = [length(declared.get(name)), length(node.attrs.find(a => a.name === name)?.value)].filter((n): n is number => n !== undefined); return sizes.length ? Math.max(...sizes) : undefined; };
        const width = side('width'), height = side('height');
        imageArea += (width ?? 600) * (height ?? (width === undefined ? 400 : Math.round(width * 2 / 3)));
        if (stats) stats.images++;
      }
      const applied = [...declared].map(([property, value]) => `${property}:${value}`).join(';');
      if (applied) node.attrs.push({ name: 'style', value: applied });
      clean(node, state);
      // A list item without text would draw a marker the screen never read.
      if (node.tagName === 'li' && !wordsIn(node)) { detach(node); continue; }
      i++;
    }
  };
  for (const node of document.childNodes.slice()) if (node !== root) detach(node);
  attributes(root, { lang: ATTRIBUTES.lang! });
  for (const node of root.childNodes.slice()) if (node !== head && node !== body) detach(node);
  for (const node of head.childNodes.slice()) {
    if (!isElement(node) || node.tagName !== 'meta') { detach(node); continue; }
    attributes(node, META);
    if (!node.attrs.length || (node.attrs.length === 1 && node.attrs[0]!.name === 'content')) detach(node);
  }
  if (!head.childNodes.some(node => isElement(node) && node.attrs.some(a => a.name === 'charset'))) {
    const charset = defaultTreeAdapter.createElement('meta', HTML, [{ name: 'charset', value: 'utf-8' }]);
    if (head.childNodes.length) defaultTreeAdapter.insertBefore(head, charset, head.childNodes[0]!); else defaultTreeAdapter.appendChild(head, charset);
  }
  const merged = styles(body);
  attributes(body, { bgcolor: ATTRIBUTES.bgcolor!, lang: ATTRIBUTES.lang! });
  const { state, style } = styled(body, { fontPx: 16, color: [0, 0, 0], background: [255, 255, 255] }, merged);
  if (style) body.attrs.push({ name: 'style', value: style });
  clean(body, state);
  if (stats) Object.assign(stats, { words, imageArea });
  else if (imageArea > IMAGE_FREE_PIXELS + words * IMAGE_PIXELS_PER_WORD) throw imageOnly();
  if (previewText) {
    const preheader = defaultTreeAdapter.createElement('div', HTML, [{ name: 'data-bane-preview', value: 'true' }, { name: 'data-skip-in-text', value: 'true' }, { name: 'style', value: PREHEADER_STYLE }]);
    defaultTreeAdapter.appendChild(preheader, defaultTreeAdapter.createTextNode(previewText));
    if (body.childNodes.length) defaultTreeAdapter.insertBefore(body, preheader, body.childNodes[0]!); else defaultTreeAdapter.appendChild(body, preheader);
  }
  return '<!DOCTYPE html>' + serializeOuter(root);
}
