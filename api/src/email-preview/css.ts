/** Client CSS emulation for previews. A bounded CSS Syntax 3 tokenizer and parser feed per-client rewriting: caniemail
 *  support data, documented sanitizer behavior (selector prefixing and scoping, whole-block drops, value rewrites),
 *  media queries evaluated against the emulated device rather than the host, and per-client dark-mode color transforms.
 *  Output is re-serialized from tokens, never copied text: it never contains `<`, and it only references data: images.
 *  Anything that fails to parse within the budgets is omitted. */
import { type Client, support } from './support.js';

export type CssContext = { client: Client; theme: 'light' | 'dark'; lightOnly: boolean; appleColorScheme: boolean; width: number };

const MAX_SHEET = 256 * 1024, MAX_INLINE = 32 * 1024, MAX_TOKENS = 60_000, MAX_DEPTH = 24, MAX_OUTPUT = 512 * 1024, MAX_DATA_URL = 256 * 1024, MAX_SELECTORS = 64;
class Limit extends Error {}
class MediaDrop extends Error {}

// ----- Tokens ------------------------------------------------------------------------------------------------------

type Kind = 'ident' | 'function' | 'at' | 'hash' | 'string' | 'url' | 'delim' | 'number' | 'percentage' | 'dimension'
  | 'ws' | ':' | ';' | ',' | '[' | ']' | '(' | ')' | '{' | '}' | 'cdo' | 'cdc' | 'bad';
type Token = { kind: Kind; value: string; unit: string; num: number; escaped: boolean; id: boolean; at: number };
type Block = { kind: 'block'; open: '{' | '[' | '('; items: Node[] };
type Func = { kind: 'fn'; name: string; items: Node[] };
type Node = Token | Block | Func;

const isWs = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n';
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isNameStart = (c: string | undefined) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c.charCodeAt(0) >= 0x80);
const isName = (c: string | undefined) => isNameStart(c) || isDigit(c) || c === '-';

function tokenize(input: string, comments?: { found: boolean }): Token[] {
  const s = input.replace(/\r\n?|\f/g, '\n').replace(/\0/g, '\uFFFD');
  const out: Token[] = [];
  let i = 0;
  const push = (kind: Kind, at: number, value = '', extra?: Partial<Token>) => {
    if (out.length >= MAX_TOKENS) throw new Limit();
    out.push({ kind, value, unit: '', num: 0, escaped: false, id: false, at, ...extra });
  };
  const validEscape = (j: number) => s[j] === '\\' && s[j + 1] !== undefined && s[j + 1] !== '\n';
  const startsIdent = (j: number) => s[j] === '-' ? isNameStart(s[j + 1]) || s[j + 1] === '-' || validEscape(j + 1) : isNameStart(s[j]) || validEscape(j);
  const startsNumber = (j: number) => {
    const c = s[j];
    if (c === '+' || c === '-') return isDigit(s[j + 1]) || (s[j + 1] === '.' && isDigit(s[j + 2]));
    return c === '.' ? isDigit(s[j + 1]) : isDigit(c);
  };
  const escape = () => {
    i++;
    const hex = /^[0-9a-fA-F]{1,6}/.exec(s.slice(i, i + 6));
    if (hex) {
      i += hex[0].length;
      if (isWs(s[i])) i++;
      const cp = parseInt(hex[0], 16);
      return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(cp);
    }
    if (i >= s.length) return '\uFFFD';
    const cp = s.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    return String.fromCodePoint(cp);
  };
  const name = () => {
    let v = '', esc = false;
    for (;;) {
      if (isName(s[i])) v += s[i++];
      else if (validEscape(i)) { v += escape(); esc = true; }
      else return { v, esc };
    }
  };
  const remnants = () => { while (i < s.length) { if (s[i] === ')') { i++; return; } if (validEscape(i)) escape(); else i++; } };
  while (i < s.length) {
    const c = s[i]!, start = i;
    if (c === '/' && s[i + 1] === '*') { const end = s.indexOf('*/', i + 2); i = end < 0 ? s.length : end + 2; if (comments) comments.found = true; continue; }
    if (isWs(c)) { while (isWs(s[i])) i++; push('ws', start); continue; }
    if (c === '"' || c === "'") {
      i++;
      let v = '', bad = false, esc = false;
      while (i < s.length) {
        const d = s[i]!;
        if (d === c) { i++; break; }
        if (d === '\n') { bad = true; break; }
        if (d === '\\') {
          if (s[i + 1] === undefined) { i++; continue; }
          if (s[i + 1] === '\n') { i += 2; continue; }
          v += escape(); esc = true; continue;
        }
        v += d; i++;
      }
      push(bad ? 'bad' : 'string', start, v, { escaped: esc });
      continue;
    }
    if (c === '#') {
      if (isName(s[i + 1]) || validEscape(i + 1)) { i++; const id = startsIdent(i), n = name(); push('hash', start, n.v, { escaped: n.esc, id }); }
      else { i++; push('delim', start, '#'); }
      continue;
    }
    if ('(),:;[]{}'.includes(c)) { i++; push(c as Kind, start); continue; }
    if (startsNumber(i)) {
      const m = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i, i + 64))!;
      i += m[0].length;
      const num = Number(m[0]);
      if (startsIdent(i)) { const n = name(); push('dimension', start, m[0], { num, unit: n.v.toLowerCase(), escaped: n.esc }); }
      else if (s[i] === '%') { i++; push('percentage', start, m[0], { num }); }
      else push('number', start, m[0], { num });
      continue;
    }
    if (c === '-' && s.startsWith('-->', i)) { i += 3; push('cdc', start); continue; }
    if (startsIdent(i)) {
      const n = name();
      if (s[i] !== '(') { push('ident', start, n.v, { escaped: n.esc }); continue; }
      i++;
      if (n.v.toLowerCase() !== 'url') { push('function', start, n.v.toLowerCase(), { escaped: n.esc }); continue; }
      let j = i;
      while (isWs(s[j])) j++;
      if (s[j] === '"' || s[j] === "'") { push('function', start, 'url', { escaped: n.esc }); continue; }
      i = j;
      let v = '', bad = false;
      for (;;) {
        const d = s[i];
        if (d === undefined) break;
        if (d === ')') { i++; break; }
        if (isWs(d)) { while (isWs(s[i])) i++; if (s[i] === ')') { i++; break; } if (s[i] === undefined) break; bad = true; remnants(); break; }
        if (d === '"' || d === "'" || d === '(' || (d.charCodeAt(0) < 0x20 && d !== '\t') || d === '\x7f') { bad = true; remnants(); break; }
        if (d === '\\') { if (validEscape(i)) { v += escape(); continue; } bad = true; remnants(); break; }
        v += d; i++;
      }
      push(bad ? 'bad' : 'url', start, v);
      continue;
    }
    if (c === '<' && s.startsWith('<!--', i)) { i += 4; push('cdo', start); continue; }
    if (c === '@' && startsIdent(i + 1)) { i++; const n = name(); push('at', start, n.v, { escaped: n.esc }); continue; }
    const cp = s.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    push('delim', start, String.fromCodePoint(cp));
  }
  return out;
}

/** Component values: blocks and functions nested, depth-bounded. Unclosed blocks end at the end of input. */
function components(tokens: Token[]): Node[] {
  let i = 0;
  const close = { '{': '}', '[': ']', '(': ')' } as const;
  const list = (end: string | null, depth: number): Node[] => {
    if (depth > MAX_DEPTH) throw new Limit();
    const items: Node[] = [];
    while (i < tokens.length) {
      const t = tokens[i++]!;
      if (end && t.kind === end) return items;
      if (t.kind === '{' || t.kind === '[' || t.kind === '(') items.push({ kind: 'block', open: t.kind, items: list(close[t.kind], depth + 1) });
      else if (t.kind === 'function') items.push({ kind: 'fn', name: t.value, items: list(')', depth + 1) });
      else items.push(t);
    }
    return items;
  };
  return list(null, 0);
}

// ----- Rules and declarations ----------------------------------------------------------------------------------------

type Rule = { kind: 'rule'; prelude: Node[]; block: Node[] } | { kind: 'atrule'; name: string; prelude: Node[]; block: Node[] | null };
type Decl = { name: string; value: Node[]; important: boolean; bang: string; spaced: boolean; escaped: boolean };
type Contents = { decls: Decl[]; rules: Rule[]; malformed: boolean };

function atRule(nodes: Node[], i: number, name: string): [Rule, number] {
  const prelude: Node[] = [];
  let block: Node[] | null = null;
  for (i++; i < nodes.length; i++) {
    const m = nodes[i]!;
    if (m.kind === ';') { i++; break; }
    if (m.kind === 'block' && m.open === '{') { block = m.items; i++; break; }
    prelude.push(m);
  }
  return [{ kind: 'atrule', name: name.toLowerCase(), prelude, block }, i];
}

/** A list of rules. A qualified rule without a block (end of input) is dropped. */
function rules(nodes: Node[], top: boolean): Rule[] {
  const out: Rule[] = [];
  let prelude: Node[] = [];
  for (let i = 0; i < nodes.length;) {
    const n = nodes[i]!;
    if (!prelude.length && (n.kind === 'ws' || (top && (n.kind === 'cdo' || n.kind === 'cdc')))) { i++; continue; }
    if (!prelude.length && n.kind === 'at') { const [rule, next] = atRule(nodes, i, n.value); out.push(rule); i = next; continue; }
    if (n.kind === 'block' && n.open === '{') { out.push({ kind: 'rule', prelude, block: n.items }); prelude = []; }
    else prelude.push(n);
    i++;
  }
  return out;
}

function declaration(part: Node[]): Decl | null {
  let i = 0;
  while (part[i]?.kind === 'ws') i++;
  const head = part[i];
  if (head?.kind !== 'ident') return null;
  for (i++; part[i]?.kind === 'ws'; i++);
  if (part[i]?.kind !== ':') return null;
  const value = part.slice(i + 1);
  let end = value.length, start = 0, important = false, bang = '', spaced = true;
  while (end && value[end - 1]!.kind === 'ws') end--;
  const last = value[end - 1];
  if (last?.kind === 'ident' && last.value.toLowerCase() === 'important') {
    let j = end - 2;
    while (j >= 0 && value[j]!.kind === 'ws') j--;
    const b = value[j];
    if (b?.kind === 'delim' && b.value === '!') {
      important = true; bang = last.value; spaced = j > 0 && value[j - 1]!.kind === 'ws'; end = j;
      while (end && value[end - 1]!.kind === 'ws') end--;
    }
  }
  while (start < end && value[start]!.kind === 'ws') start++;
  const name = head.value.startsWith('--') ? head.value : head.value.toLowerCase();
  return { name, value: value.slice(start, end), important, bang, spaced, escaped: head.escaped };
}

/** A style block: declarations, plus nested rules (CSS Nesting) and at-rules. */
function contents(nodes: Node[]): Contents {
  const decls: Decl[] = [], nested: Rule[] = [];
  let malformed = false;
  for (let i = 0; i < nodes.length;) {
    const n = nodes[i]!;
    if (n.kind === 'ws' || n.kind === ';') { i++; continue; }
    if (n.kind === 'at') { const [rule, next] = atRule(nodes, i, n.value); nested.push(rule); i = next; continue; }
    const custom = n.kind === 'ident' && n.value.startsWith('--'), part: Node[] = [];
    let block: Block | null = null;
    for (; i < nodes.length; i++) {
      const m = nodes[i]!;
      if (m.kind === ';') { i++; break; }
      if (!custom && m.kind === 'block' && m.open === '{') { block = m; i++; break; }
      part.push(m);
    }
    if (block) { nested.push({ kind: 'rule', prelude: part, block: block.items }); continue; }
    const d = declaration(part);
    if (d) decls.push(d); else malformed = true;
  }
  return { decls, rules: nested, malformed };
}

const splitComma = (nodes: Node[]) => {
  const parts: Node[][] = [[]];
  for (const n of nodes) if (n.kind === ',') parts.push([]); else parts[parts.length - 1]!.push(n);
  return parts;
};
const solid = (nodes: Node[]) => nodes.filter(n => n.kind !== 'ws');
const lower = (n: Node | undefined) => n?.kind === 'ident' ? n.value.toLowerCase() : '';

// ----- Serialization -------------------------------------------------------------------------------------------------

const hexEscape = (c: number) => `\\${c.toString(16)} `;
/** CSSOM "serialize an identifier", escaping every non-name ASCII character as hex so no `<` or `\` survives. */
function ident(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) out += '\uFFFD';
    else if (c <= 0x1f || c === 0x7f || (i === 0 && c >= 48 && c <= 57) || (i === 1 && c >= 48 && c <= 57 && s.charCodeAt(0) === 45) || (c === 45 && i === 0 && s.length === 1)) out += hexEscape(c);
    else if (c >= 0x80 || c === 45 || c === 95 || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) out += s[i];
    else out += hexEscape(c);
  }
  return out;
}
const nameText = (s: string) => [...s].map(ch => isName(ch) ? ch : hexEscape(ch.codePointAt(0)!)).join('');
function string(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += c === 0 ? '\uFFFD' : c <= 0x1f || c === 0x7f || ch === '"' || ch === '\\' || ch === '<' || ch === '>' || ch === '&' || ch === "'" ? hexEscape(c) : ch;
  }
  return out + '"';
}
const unitText = (u: string) => /^e/i.test(u) ? hexEscape(u.charCodeAt(0)) + nameText(u.slice(1)) : ident(u);
const number = (n: Token) => n.value + (n.kind === 'percentage' ? '%' : n.kind === 'dimension' ? unitText(n.unit) : '');

type Piece = 'word' | 'fn' | 'paren' | 'minus' | 'slash' | 'star' | 'other';
/** Joins serialized tokens, adding a space wherever two neighbours would otherwise re-tokenize as one (or as a comment). */
class Out {
  text = '';
  private last: Piece | 'none' = 'none';
  private space = false;
  ws() { if (this.last !== 'none') this.space = true; }
  push(t: string, kind: Piece) {
    const a = this.last, b = kind;
    if (this.space || (a === 'word' && (b === 'word' || b === 'fn' || b === 'paren' || b === 'minus')) || (a === 'minus' && (b === 'word' || b === 'fn' || b === 'minus'))
      || (a === 'slash' && b === 'star') || (a === 'star' && b === 'slash')) this.text += ' ';
    this.space = false;
    this.text += t;
    this.last = kind;
  }
}

/** Preludes (media, supports, nth arguments): plain tokens and parentheses only. */
function rawText(nodes: Node[], delims: string): string | null {
  const out = new Out();
  for (const n of nodes) {
    switch (n.kind) {
      case 'ws': out.ws(); break;
      case 'ident': out.push(ident(n.value), 'word'); break;
      case 'number': case 'percentage': case 'dimension': out.push(number(n), 'word'); break;
      case 'string': out.push(string(n.value), 'other'); break;
      case ':': case ',': out.push(n.kind, 'other'); break;
      case 'delim':
        if (!delims.includes(n.value)) return null;
        out.push(n.value, n.value === '-' || n.value === '+' ? 'minus' : n.value === '/' ? 'slash' : 'other');
        break;
      case 'block': {
        if (n.open !== '(') return null;
        const t = rawText(n.items, delims);
        if (t === null) return null;
        out.push(`(${t})`, 'paren');
        break;
      }
      default: return null;
    }
  }
  return out.text;
}

// ----- Clients -------------------------------------------------------------------------------------------------------

type Family = 'gmail' | 'apple' | 'outlook' | 'yahoo' | 'samsung';
type Dark = 'none' | 'chromium' | 'invert' | 'outlook' | 'apple' | 'yahoo';
type Scope = {
  ctx: CssContext; client: Client; fam: Family; ganga: boolean; webmail: boolean; prefix: string; wrapper: string;
  dark: Dark; nesting: 'keep' | 'flatten' | 'drop'; inline: boolean; desktop: boolean;
};

const familyOf = (c: Client): Family => c.startsWith('gmail-') ? 'gmail' : c.startsWith('apple-') ? 'apple' : c.startsWith('outlook-') ? 'outlook' : c === 'samsung-email' ? 'samsung' : 'yahoo';
const DESKTOP = new Set<Client>(['gmail-web', 'apple-mail-macos', 'outlook-web', 'outlook-new-windows', 'outlook-mac', 'outlook-classic-windows', 'yahoo-web', 'aol-web']);
// caniemail has no new-Outlook-for-Windows column; it runs the Outlook.com renderer.
const status = (client: Client, key: string) => support(key, client === 'outlook-new-windows' ? 'outlook-web' : client);
const no = (s: Scope, key: string) => status(s.client, key) === 'no';

// Deterministic stand-ins for the per-message ids the real sanitizers generate. Formats: Gmail `msg<id>` wrapper and
// `m_<id>` names (hteumeuleu 2021), Outlook.com `.rps_<hex>` scope and `x_` names (email-bugs#64), Yahoo and AOL
// `#yiv<digits>` scope and `yiv<digits>` names (email-bugs#22).
const GMAIL_ID = '4142466614215349360', YAHOO_ID = 'yiv2642609066';

/** The prefix a client adds to every class and id, in the HTML and in its CSS. Empty when it keeps names. */
export function namePrefix(client: Client): string {
  switch (familyOf(client)) {
    case 'gmail': return `m_${GMAIL_ID}`;
    case 'outlook': return 'x_';
    case 'yahoo': return YAHOO_ID;
    default: return '';
  }
}

/** The class on the element every rule is scoped under: the webmail container, or `<html>` for native clients. */
export function wrapperClass(client: Client): string {
  switch (familyOf(client)) {
    case 'gmail': return `msg${GMAIL_ID}`;
    case 'outlook': return 'rps_ca92';
    case 'yahoo': return YAHOO_ID;
    default: return `bane-${client}`;
  }
}

function darkMode(ctx: CssContext): Dark {
  if (ctx.theme !== 'dark') return 'none';
  switch (ctx.client) {
    case 'gmail-web': return 'none'; // email-bugs#68: the web theme does not recolor messages.
    case 'gmail-ios': case 'gmail-ios-non-google': return ctx.lightOnly ? 'none' : 'invert'; // Litmus: full invert; caniemail 2026-09: `light only` honored.
    case 'gmail-android': case 'gmail-android-non-google': return ctx.lightOnly ? 'none' : 'chromium'; // email-bugs#68: WebView force dark.
    case 'samsung-email': return 'chromium'; // Android WebView force dark (unconfirmed vendor reports); meta color-scheme unsupported.
    case 'apple-mail-macos': case 'apple-mail-ios': return ctx.appleColorScheme && !ctx.lightOnly ? 'apple' : 'none'; // email-bugs#104: opt-in only.
    case 'outlook-classic-windows': return 'invert'; // Word recolors in Black theme; algorithm undocumented.
    case 'yahoo-web': case 'aol-web': return 'yahoo'; // email-bugs#156; AOL shares Yahoo's backend.
    default: return 'outlook';
  }
}

function scope(ctx: CssContext, inline: boolean): Scope {
  const client = ctx.client, fam = familyOf(client);
  const nesting = fam === 'yahoo' ? 'flatten' : (fam === 'apple' || fam === 'samsung') && status(client, 'css-nesting') !== 'no' ? 'keep' : 'drop';
  return {
    ctx, client, fam, ganga: client.endsWith('-non-google'), webmail: fam === 'gmail' || fam === 'outlook' || fam === 'yahoo',
    prefix: namePrefix(client), wrapper: wrapperClass(client), dark: darkMode(ctx), nesting, inline, desktop: DESKTOP.has(client),
  };
}

/** Whether `prefers-color-scheme: dark` and `light-dark()` resolve dark: only clients that support them, in the emulated theme. */
const prefersDark = (s: Scope) => s.fam === 'apple' ? s.dark === 'apple' : (s.fam === 'outlook' || s.fam === 'samsung') && s.ctx.theme === 'dark';

// ----- Colors ----------------------------------------------------------------------------------------------------------

type Rgba = [number, number, number, number];
type Role = 'background' | 'text' | 'border' | 'other';
const NAMED = new Map<string, string>(('aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 '
  + 'blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 '
  + 'cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 '
  + 'darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a '
  + 'darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 '
  + 'deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff '
  + 'gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 '
  + 'hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd '
  + 'lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 '
  + 'lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 '
  + 'lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 '
  + 'mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 '
  + 'midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 '
  + 'orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 '
  + 'peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f '
  + 'royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb '
  + 'slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 '
  + 'tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32').split(' ')
  .flatMap((v, i, all) => i % 2 ? [] : [[v, all[i + 1]!] as [string, string]]));
const COLOR_FN = new Set(['rgb', 'rgba', 'hsl', 'hsla']);

function hexColor(h: string): Rgba | null {
  if (!/^[0-9a-f]+$/i.test(h) || ![3, 4, 6, 8].includes(h.length)) return null;
  const long = h.length <= 4 ? [...h].map(c => c + c).join('') : h, at = (i: number) => parseInt(long.slice(i, i + 2), 16);
  return [at(0), at(2), at(4), long.length === 8 ? at(6) / 255 : 1];
}
const isSpaceSyntax = (n: Func) => (n.name === 'rgb' || n.name === 'rgba') && !n.items.some(m => m.kind === ',') && solid(n.items).length > 1;
function fnColor(n: Func): Rgba | null {
  const t = solid(n.items);
  let parts: Node[], alpha: Node | undefined;
  if (t.some(m => m.kind === ',')) {
    if (t.some((m, i) => (i % 2 === 1) !== (m.kind === ','))) return null;
    parts = t.filter((_, i) => i % 2 === 0);
    if (parts.length === 4) alpha = parts.pop();
  } else {
    const slash = t.findIndex(m => m.kind === 'delim' && m.value === '/');
    if (slash >= 0 && slash !== t.length - 2) return null;
    parts = slash >= 0 ? t.slice(0, slash) : t;
    alpha = slash >= 0 ? t[slash + 1] : undefined;
  }
  if (parts.length !== 3 || parts.some(p => p.kind !== 'number' && p.kind !== 'percentage' && p.kind !== 'dimension')) return null;
  const [p0, p1, p2] = parts as Token[];
  let a = 1;
  if (alpha) {
    if (alpha.kind === 'number') a = alpha.num; else if (alpha.kind === 'percentage') a = alpha.num / 100; else return null;
  }
  a = Math.min(1, Math.max(0, a));
  if (n.name.startsWith('rgb')) {
    const ch = (p: Token) => p.kind === 'number' ? p.num : p.kind === 'percentage' ? p.num * 2.55 : NaN;
    const rgb = [ch(p0!), ch(p1!), ch(p2!)].map(v => Math.min(255, Math.max(0, v)));
    return rgb.some(Number.isNaN) ? null : [rgb[0]!, rgb[1]!, rgb[2]!, a];
  }
  const turns: Record<string, number> = { deg: 1 / 360, grad: 1 / 400, rad: 1 / (2 * Math.PI), turn: 1 };
  const h = p0!.kind === 'number' ? p0!.num / 360 : p0!.kind === 'dimension' && turns[p0!.unit] ? p0!.num * turns[p0!.unit]! : NaN;
  const pct = (p: Token) => p.kind === 'percentage' || p.kind === 'number' ? Math.min(100, Math.max(0, p.num)) / 100 : NaN;
  const [r, g, b] = fromHsl(((h % 1) + 1) % 1, pct(p1!), pct(p2!));
  return [r, g, b].some(Number.isNaN) ? null : [r, g, b, a];
}
function parseColor(n: Node): Rgba | null {
  if (n.kind === 'ident') { const hex = NAMED.get(n.value.toLowerCase()); return hex ? hexColor(hex) : null; }
  if (n.kind === 'hash') return hexColor(n.value);
  return n.kind === 'fn' && COLOR_FN.has(n.name) ? fnColor(n) : null;
}
const hex2 = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
const format = ([r, g, b, a]: Rgba) => a >= 1 ? `#${hex2(r)}${hex2(g)}${hex2(b)}` : `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(3)})`;

function toHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function fromHsl(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h * 6) % 2) - 1)), m = l - c / 2, k = Math.floor(h * 6) % 6;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][k]!;
  return [(r! + m) * 255, (g! + m) * 255, (b! + m) * 255];
}

const linear = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const gamma = (c: number) => { c = Math.min(1, Math.max(0, c)); return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055); };
const KAPPA = 24389 / 27, EPSILON = 216 / 24389, WHITE = [0.95047, 1, 1.08883] as const;
function toLab([r, g, b]: Rgba | [number, number, number]): [number, number, number] {
  const R = linear(r), G = linear(g), B = linear(b);
  const xyz = [0.4124564 * R + 0.3575761 * G + 0.1804375 * B, 0.2126729 * R + 0.7151522 * G + 0.072175 * B, 0.0193339 * R + 0.119192 * G + 0.9503041 * B];
  const [fx, fy, fz] = xyz.map((v, i) => { const t = v / WHITE[i]!; return t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116; }) as [number, number, number];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function fromLab(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200, inv = (t: number) => t ** 3 > EPSILON ? t ** 3 : (116 * t - 16) / KAPPA;
  const X = WHITE[0] * inv(fx), Y = L > KAPPA * EPSILON ? fy ** 3 : L / KAPPA, Z = WHITE[2] * inv(fz);
  return [gamma(3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z), gamma(-0.969266 * X + 1.8760108 * Y + 0.041556 * Z), gamma(0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z)];
}
const luminance = (c: Rgba | [number, number, number]) => 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
const contrast = (a: Rgba | [number, number, number], b: Rgba | [number, number, number]) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

/** Chromium auto dark mode (Android WebView force dark): LAB lightness inversion `min(110 - L, 100)`, then dark grays
 *  between 18 and 32 snapped to 18 (blink dark_mode_color_filter.cc). */
function invert(c: Rgba): Rgba {
  const [L, A, B] = toLab(c), [r, g, b] = fromLab(Math.min(110 - L, 100), A, B);
  const gray = Math.abs(r - g) < 0.5 && Math.abs(r - b) < 0.5 && r < 32 && r > 18;
  return gray ? [18, 18, 18, c[3]] : [r, g, b, c[3]];
}
/** Blink's classifier brightness and default thresholds: text and borders darker than 150 and backgrounds brighter
 *  than 205 are inverted (dark_mode_color_classifier.cc, dark_mode_settings_builder.cc). */
const brightness = ([r, g, b]: Rgba) => Math.trunc((Math.round(r) * 299 + Math.round(g) * 587 + Math.round(b) * 114) / 1000);

// Outlook.com's transformElementForDarkMode/fixContrast (OWA source, hteumeuleu gist 51b5a8ea): colors below 4.5:1
// against the reading pane are moved in CIELAB lightness, keeping a and b. White maps to the pane color; email-bugs#88
// shows a white element rewritten to rgb(51, 51, 51), which gives the base below. Per declaration rather than per
// element, backgrounds are checked against the recolored default text.
const OUTLOOK_BASE: [number, number, number] = [51, 51, 51];
function fixContrast(color: Rgba, comparison: [number, number, number]): Rgba {
  const baseL = toLab(OUTLOOK_BASE)[0], [L, A, B] = toLab(color), compL = toLab(comparison)[0];
  const ceilingDark = 50, floorLight = 50 + baseL, mid = (floorLight + ceilingDark) / 2;
  let n = L * ((100 - baseL) / 100) + baseL;
  if (compL > mid) { n = Math.min(n, 2 * mid - n); n = ((n - baseL) * (ceilingDark - baseL)) / (mid - baseL) + baseL; }
  else { n = Math.max(n, 2 * mid - n); n = 100 - ((100 - n) * (100 - floorLight)) / (100 - mid); }
  return [...fromLab(n, A, B), color[3]];
}
const OUTLOOK_TEXT = fixContrast([0, 0, 0, 1], OUTLOOK_BASE).slice(0, 3) as [number, number, number];

function transform(c: Rgba, role: Role, s: Scope): Rgba {
  if (c[3] === 0) return c;
  switch (s.dark) {
    case 'invert': return invert(c);
    case 'chromium': return (role === 'background' ? brightness(c) > 205 : brightness(c) < 150) ? invert(c) : c;
    case 'outlook':
      if (role === 'background') return contrast(c, OUTLOOK_TEXT) < 4.5 ? fixContrast(c, OUTLOOK_TEXT) : c;
      return contrast(c, OUTLOOK_BASE) < 4.5 ? fixContrast(c, OUTLOOK_BASE) : c;
    case 'apple': {
      // Opted-in Apple Mail with no dark styles inverts pure white (Litmus 2023), even inside a dark media query
      // (email-bugs#65), onto WebKit's dark Canvas. Pure black text follows the dark CanvasText. Approximate.
      const [r, g, b] = c.map(Math.round);
      if (role === 'background' && r === 255 && g === 255 && b === 255) return s.client === 'apple-mail-ios' ? [0, 0, 0, c[3]] : [30, 30, 30, c[3]];
      if (role === 'text' && r === 0 && g === 0 && b === 0) return [255, 255, 255, c[3]];
      return c;
    }
    case 'yahoo': {
      // email-bugs#156: Yahoo "darkens by 70%" in HSL lightness, keeping hue and saturation (#fffffe -> #989800).
      // Lightening dark text by the same amount is an assumption; only the background rule is documented.
      const [h, sat, l] = toHsl(c[0], c[1], c[2]);
      if (role === 'background' && l > 0.7) return [...fromHsl(h, sat, l - 0.7), c[3]];
      if (role === 'text' && l < 0.3) return [...fromHsl(h, sat, l + 0.7), c[3]];
      return c;
    }
    default: return c;
  }
}

const ROLES = new Map<string, Role>([['background', 'background'], ['background-color', 'background'], ['bgcolor', 'background'], ['color', 'text'], ['-webkit-text-fill-color', 'text']]);
for (const p of ['border', 'outline', 'column-rule', 'border-color', 'outline-color', 'column-rule-color']) ROLES.set(p, 'border');
for (const side of ['top', 'right', 'bottom', 'left', 'inline', 'block', 'inline-start', 'inline-end', 'block-start', 'block-end']) { ROLES.set(`border-${side}`, 'border'); ROLES.set(`border-${side}-color`, 'border'); }
for (const p of ['text-decoration', 'text-decoration-color', 'text-emphasis-color', 'caret-color', 'accent-color', 'box-shadow', 'text-shadow', 'fill', 'stroke', '-webkit-text-stroke-color']) ROLES.set(p, 'other');
/** Which properties each transform touches: Outlook rewrites color, background and border colors (email-bugs#64);
 *  Apple and Yahoo are only documented for text and backgrounds. Gradients and images are never recolored. */
const applies = (mode: Dark, role: Role) => mode === 'chromium' || mode === 'invert' || (mode === 'outlook' ? role !== 'other' : role === 'background' || role === 'text');

function recolor(n: Node, s: Scope, role: Role): [string, Piece] | null {
  if (s.dark === 'none' || !applies(s.dark, role)) return null;
  const c = parseColor(n);
  if (!c) return null;
  const t = format(transform(c, role, s));
  return [t, t.startsWith('#') ? 'word' : 'fn'];
}

/** A color for the given property (or `bgcolor`/`color` attribute) as the client shows it in the context's theme.
 *  Values that are not a single plain color come back unchanged. */
export function color(value: string, property: string, ctx: CssContext): string {
  const s = scope(ctx, true), role = ROLES.get(property.toLowerCase());
  if (s.dark === 'none' || !role || !applies(s.dark, role) || value.length > 256) return value;
  const v = value.trim(), legacy = /^[0-9a-f]{6}$/i.test(v) ? `#${v}` : v;
  try {
    const nodes = solid(components(tokenize(legacy)));
    const c = nodes.length === 1 ? parseColor(nodes[0]!) : null;
    return c ? format(transform(c, role, s)) : value;
  } catch (e) {
    if (e instanceof Limit) return value;
    throw e;
  }
}

// ----- caniemail keys --------------------------------------------------------------------------------------------------

const PROPERTY_KEYS = new Map<string, string>();
const group = (key: string, names: string) => { for (const n of names.split(' ')) PROPERTY_KEYS.set(n, `css-${key}`); };
const sides = (template: string) => ['top', 'right', 'bottom', 'left'].map(side => template.replace('*', side)).join(' ');
group('accent-color', 'accent-color'); group('align-items', 'align-items'); group('aspect-ratio', 'aspect-ratio'); group('backdrop-filter', 'backdrop-filter');
group('animation', 'animation animation-name animation-duration animation-timing-function animation-delay animation-iteration-count animation-direction animation-fill-mode animation-play-state animation-composition');
group('background-blend-mode', 'background-blend-mode'); group('background-clip', 'background-clip'); group('background-color', 'background-color');
group('background-image', 'background-image'); group('background-origin', 'background-origin'); group('background-position', 'background-position background-position-x background-position-y');
group('background-repeat', 'background-repeat'); group('background-size', 'background-size'); group('background', 'background');
group('block-inline-size', 'block-size inline-size'); group('border-collapse', 'border-collapse');
group('border-image', 'border-image border-image-source border-image-slice border-image-width border-image-outset border-image-repeat');
group('border-inline-block', 'border-inline border-block');
group('border-inline-block-individual', ['inline-start', 'inline-end', 'block-start', 'block-end'].flatMap(e => [`border-${e}`, `border-${e}-width`, `border-${e}-style`, `border-${e}-color`]).join(' '));
group('border-inline-block-longhand', 'border-inline-width border-inline-style border-inline-color border-block-width border-block-style border-block-color');
group('border-radius-logical', 'border-start-start-radius border-start-end-radius border-end-start-radius border-end-end-radius');
group('border-radius', 'border-radius border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius');
group('border-spacing', 'border-spacing');
group('border', `border border-width border-style border-color ${sides('border-*')} ${sides('border-*-width')} ${sides('border-*-style')} ${sides('border-*-color')}`);
group('box-shadow', 'box-shadow'); group('box-sizing', 'box-sizing'); group('caption-side', 'caption-side'); group('clear', 'clear'); group('clip-path', 'clip-path');
group('color-scheme', 'color-scheme'); group('column-count', 'column-count');
group('column-layout-properties', 'columns column-width column-rule column-rule-width column-rule-style column-rule-color column-span column-fill');
group('cursor', 'cursor'); group('direction', 'direction'); group('display', 'display'); group('empty-cells', 'empty-cells'); group('filter', 'filter');
group('flex-direction', 'flex-direction'); group('flex-wrap', 'flex-wrap'); group('float', 'float'); group('font-kerning', 'font-kerning');
group('font-size-adjust', 'font-size-adjust'); group('font-size', 'font-size'); group('font-stretch', 'font-stretch font-width'); group('font-weight', 'font-weight'); group('font', 'font');
group('gap', 'gap row-gap column-gap grid-gap grid-row-gap grid-column-gap'); group('grid-template', 'grid-template grid-template-areas grid-template-columns grid-template-rows');
group('height', 'height'); group('hyphenate-character', 'hyphenate-character'); group('hyphenate-limit-chars', 'hyphenate-limit-chars'); group('hyphens', 'hyphens');
group('inset', 'inset inset-inline inset-block inset-inline-start inset-inline-end inset-block-start inset-block-end');
group('justify-content', 'justify-content'); group('left-right-top-bottom', 'left right top bottom'); group('letter-spacing', 'letter-spacing'); group('line-height', 'line-height');
group('list-style-image', 'list-style-image'); group('list-style-position', 'list-style-position'); group('list-style-type', 'list-style-type'); group('list-style', 'list-style');
group('margin-block-start-end', 'margin-block-start margin-block-end'); group('margin-inline-block', 'margin-inline margin-block');
group('margin-inline-start-end', 'margin-inline-start margin-inline-end'); group('margin', `margin ${sides('margin-*')}`);
group('mask-image', 'mask-image'); group('max-block-size', 'max-block-size'); group('max-height', 'max-height'); group('max-inline-size', 'max-inline-size'); group('max-width', 'max-width');
group('min-block-size', 'min-block-size'); group('min-height', 'min-height'); group('min-inline-size', 'min-inline-size'); group('min-width', 'min-width');
group('mix-blend-mode', 'mix-blend-mode'); group('object-fit', 'object-fit'); group('object-position', 'object-position'); group('opacity', 'opacity'); group('orphans', 'orphans');
group('outline-offset', 'outline-offset'); group('outline', 'outline outline-width outline-style outline-color'); group('overflow-wrap', 'overflow-wrap');
group('overflow', 'overflow overflow-x overflow-y overflow-block overflow-inline');
group('padding-block-start-end', 'padding-block-start padding-block-end'); group('padding-inline-block', 'padding-inline padding-block');
group('padding-inline-start-end', 'padding-inline-start padding-inline-end'); group('padding', `padding ${sides('padding-*')}`);
group('position', 'position'); group('resize', 'resize'); group('scroll-snap', 'scroll-snap-type scroll-snap-align scroll-snap-stop scroll-padding scroll-margin');
group('shape-margin', 'shape-margin'); group('shape-outside', 'shape-outside'); group('tab-size', 'tab-size'); group('table-layout', 'table-layout');
group('text-align-last', 'text-align-last'); group('text-align', 'text-align'); group('text-decoration-color', 'text-decoration-color'); group('text-decoration-line', 'text-decoration-line');
group('text-decoration-skip-ink', 'text-decoration-skip-ink'); group('text-decoration-style', 'text-decoration-style'); group('text-decoration-thickness', 'text-decoration-thickness');
group('text-decoration', 'text-decoration'); group('text-emphasis-position', 'text-emphasis-position'); group('text-emphasis', 'text-emphasis text-emphasis-style text-emphasis-color');
group('text-indent', 'text-indent'); group('text-justify', 'text-justify'); group('text-orientation', 'text-orientation'); group('text-overflow', 'text-overflow');
group('text-shadow', 'text-shadow'); group('text-transform', 'text-transform'); group('text-underline-offset', 'text-underline-offset'); group('text-underline-position', 'text-underline-position');
group('text-wrap', 'text-wrap text-wrap-mode text-wrap-style');
group('transform', 'transform transform-origin transform-style transform-box translate rotate scale perspective perspective-origin backface-visibility');
group('transition', 'transition transition-property transition-duration transition-timing-function transition-delay transition-behavior');
group('user-select', 'user-select'); group('vertical-align', 'vertical-align'); group('visibility', 'visibility'); group('white-space-collapse', 'white-space-collapse');
group('white-space', 'white-space'); group('widows', 'widows'); group('width', 'width'); group('word-break', 'word-break'); group('word-spacing', 'word-spacing');
group('word-wrap', 'word-wrap'); group('writing-mode', 'writing-mode'); group('z-index', 'z-index');

const UNITS = new Set(['ch', 'cm', 'em', 'ex', 'in', 'mm', 'pc', 'pt', 'px', 'rem', 'vh', 'vmax', 'vmin', 'vw']);
const FN_KEYS: Record<string, string> = {
  calc: 'css-unit-calc', '-webkit-calc': 'css-unit-calc', min: 'css-function-min', max: 'css-function-max', clamp: 'css-function-clamp', var: 'css-variables',
  'light-dark': 'css-function-light-dark', rgb: 'css-rgb', rgba: 'css-rgba', lab: 'css-modern-color', lch: 'css-modern-color', oklab: 'css-modern-color', oklch: 'css-modern-color',
};
for (const kind of ['linear', 'radial', 'conic']) for (const name of [`${kind}-gradient`, `repeating-${kind}-gradient`, `-webkit-${kind}-gradient`, `-webkit-repeating-${kind}-gradient`]) FN_KEYS[name] = `css-${kind}-gradient`;
const SYSTEM_FONTS = new Set(['system-ui', 'ui-serif', 'ui-sans-serif', 'ui-rounded', 'ui-monospace']);
const INTRINSIC = new Set(['fit-content', 'min-content', 'max-content']);
const SIZES = new Set(['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'block-size', 'inline-size', 'min-block-size', 'max-block-size', 'min-inline-size', 'max-inline-size', 'flex-basis']);

function imageKeys(url: string, keys: Set<string>) {
  const data = /^\s*data:image\/([a-z0-9+.-]+)[;,]/i.exec(url);
  const format = data?.[1] ?? /\.([a-z0-9]{2,5})(?:[?#][^]*)?$/i.exec(url)?.[1];
  if (data && /^[^,]*;base64,/i.test(url.trim())) keys.add('image-base64');
  if (format) keys.add(`image-${format.toLowerCase().replace(/^jpeg$/, 'jpg').replace(/^svg\+xml$/, 'svg')}`);
}
function valueKeys(items: Node[], prop: string, keys: Set<string>) {
  for (const n of items) {
    if (n.kind === 'ident') {
      const v = n.value.toLowerCase();
      if (v === 'initial') keys.add('css-unit-initial');
      if ((prop === 'font' || prop === 'font-family') && SYSTEM_FONTS.has(v)) keys.add('css-sytem-ui');
      if (prop === 'display') keys.add(v === 'flex' || v === 'inline-flex' ? 'css-display-flex' : v === 'grid' || v === 'inline-grid' ? 'css-display-grid' : v === 'none' ? 'css-display-none' : 'css-display');
      if (SIZES.has(prop) && INTRINSIC.has(v)) keys.add('css-intrinsic-size');
    } else if (n.kind === 'dimension' && UNITS.has(n.unit)) keys.add(`css-unit-${n.unit}`);
    else if (n.kind === 'percentage') keys.add('css-unit-percent');
    else if (n.kind === 'url') imageKeys(n.value, keys);
    else if (n.kind === 'fn') {
      const key = FN_KEYS[n.name];
      if (key) keys.add(key);
      if (n.name === 'fit-content' && SIZES.has(prop)) keys.add('css-intrinsic-size');
      if (n.name === 'url') { const arg = solid(n.items)[0]; if (arg?.kind === 'string') imageKeys(arg.value, keys); }
      valueKeys(n.items, prop, keys);
    } else if (n.kind === 'block') valueKeys(n.items, prop, keys);
  }
}
const unprefixed = (name: string) => name.replace(/^-(?:webkit|moz|ms|o)-/, '');
function declKeys(name: string, items: Node[], important: boolean): Set<string> {
  const keys = new Set<string>();
  if (important) keys.add('css-important');
  if (name.startsWith('--')) { keys.add('css-variables'); valueKeys(items, name, keys); return keys; }
  const base = unprefixed(name), key = PROPERTY_KEYS.get(name) ?? PROPERTY_KEYS.get(base);
  if (key) keys.add(key);
  if (base === 'flex-flow') { keys.add('css-flex-direction'); keys.add('css-flex-wrap'); }
  valueKeys(items, base, keys);
  return keys;
}

// ----- Declarations ----------------------------------------------------------------------------------------------------

// Google's published allowlist for Gmail with Google accounts (developers.google.com/workspace/gmail/design/css).
const GMAIL_PROPERTIES = new Set(('azimuth background background-blend-mode background-clip background-color background-image background-origin background-position '
  + 'background-repeat background-size border border-bottom border-bottom-color border-bottom-left-radius border-bottom-right-radius border-bottom-style '
  + 'border-bottom-width border-collapse border-color border-left border-left-color border-left-style border-left-width border-radius border-right '
  + 'border-right-color border-right-style border-right-width border-spacing border-style border-top border-top-color border-top-left-radius '
  + 'border-top-right-radius border-top-style border-top-width border-width box-sizing break-after break-before break-inside caption-side clear color '
  + 'column-count column-fill column-gap column-rule column-rule-color column-rule-style column-rule-width column-span column-width columns direction '
  + 'display elevation empty-cells float font font-family font-feature-settings font-kerning font-size font-size-adjust font-stretch font-style '
  + 'font-synthesis font-variant font-variant-alternates font-variant-caps font-variant-east-asian font-variant-ligatures font-variant-numeric font-weight '
  + 'height image-orientation image-resolution ime-mode isolation layout-flow layout-grid layout-grid-char layout-grid-char-spacing layout-grid-line '
  + 'layout-grid-mode layout-grid-type letter-spacing line-break line-height list-style list-style-position list-style-type margin margin-bottom '
  + 'margin-left margin-right margin-top marker-offset max-height max-width min-height min-width mix-blend-mode object-fit object-position opacity '
  + 'outline outline-color outline-style outline-width overflow overflow-x overflow-y padding padding-bottom padding-left padding-right padding-top '
  + 'page-break-after page-break-before page-break-inside pause pause-after pause-before pitch pitch-range quotes richness speak speak-header '
  + 'speak-numeral speak-punctuation speech-rate stress table-layout text-align text-align-last text-autospace text-combine-upright text-decoration '
  + 'text-decoration-color text-decoration-line text-decoration-skip text-decoration-style text-emphasis text-emphasis-color text-emphasis-style '
  + 'text-indent text-justify text-kashida-space text-orientation text-overflow text-transform text-underline-position unicode-bidi vertical-align '
  + 'voice-family white-space width word-break word-spacing word-wrap writing-mode zoom').split(' '));
const DENIED = /^(?:-ms-)?behavior$|^-moz-binding$|^src$|^mso-/;
const MATH = new Set(['calc', '-webkit-calc', 'min', 'max', 'clamp']);
const FN_ALLOW = new Set(('rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix calc -webkit-calc min max clamp translate translatex translatey translatez '
  + 'translate3d rotate rotatex rotatey rotatez rotate3d scale scalex scaley scalez scale3d skew skewx skewy matrix matrix3d perspective cubic-bezier steps '
  + 'linear blur brightness contrast drop-shadow grayscale hue-rotate invert opacity saturate sepia rect inset circle ellipse polygon repeat minmax '
  + 'fit-content counter counters').split(' ').concat(Object.keys(FN_KEYS).filter(name => name.includes('gradient'))));
const POSITIONS: Record<Family, string[]> = { gmail: [], outlook: ['static', 'sticky'], yahoo: ['static', 'relative'], apple: ['static', 'relative', 'absolute'], samsung: ['static', 'relative', 'absolute'] };

/** A data: raster image the preview CSP allows and the client shows; every other URL is dropped. */
function dataUrl(v: string, s: Scope): string | null {
  if (v.length > MAX_DATA_URL) return null;
  const m = /^\s*data:image\/(png|gif|jpe?g|webp|avif);base64,([a-z0-9+/=\s]*)$/i.exec(v);
  if (!m) return null;
  const type = m[1]!.toLowerCase();
  if (no(s, 'image-base64') || no(s, `image-${type.replace('jpeg', 'jpg')}`)) return null;
  return `url("data:image/${type};base64,${m[2]!.replace(/\s+/g, '')}")`;
}

function fnValue(n: Func, s: Scope, prop: string, role: Role | undefined, math: boolean, top: boolean): [string, Piece] | null {
  if (n.name === 'url') { const arg = solid(n.items); const u = arg.length === 1 && arg[0]!.kind === 'string' ? dataUrl(arg[0]!.value, s) : null; return u ? [u, 'fn'] : null; }
  if (n.name === 'light-dark') {
    const args = splitComma(n.items);
    if (args.length !== 2) return null;
    const v = value(args[prefersDark(s) ? 1 : 0]!, s, prop, role, math, top);
    return v ? [v, 'word'] : null;
  }
  if (top && role && COLOR_FN.has(n.name)) { const c = recolor(n, s, role); if (c) return c; }
  if (n.name === 'var') {
    const comma = n.items.findIndex(m => m.kind === ','), head = solid(comma < 0 ? n.items : n.items.slice(0, comma))[0];
    if (head?.kind !== 'ident' || !head.value.startsWith('--') || solid(comma < 0 ? n.items : n.items.slice(0, comma)).length !== 1) return null;
    const fallback = comma < 0 ? '' : value(n.items.slice(comma + 1), s, prop, role, math, false);
    return fallback === null ? null : [`var(${ident(head.value)}${fallback ? `,${fallback}` : ''})`, 'fn'];
  }
  if (!FN_ALLOW.has(n.name)) return null;
  const inner = value(n.items, s, prop, undefined, math || MATH.has(n.name), false);
  return inner === null ? null : [`${ident(n.name)}(${inner})`, 'fn'];
}

/** A declaration value re-serialized token by token, or null when anything in it is unsafe or unparsed. Top-level
 *  colors of color-bearing properties go through the client's dark-mode transform. */
function value(items: Node[], s: Scope, prop: string, role: Role | undefined, math = false, top = true): string | null {
  const out = new Out();
  for (const n of items) {
    switch (n.kind) {
      case 'ws': out.ws(); break;
      case ',': out.push(',', 'other'); break;
      case 'delim':
        if (n.value === '/') out.push('/', 'slash');
        else if (math && n.value === '*') out.push('*', 'star');
        else if (math && (n.value === '+' || n.value === '-')) out.push(n.value, 'minus');
        else return null;
        break;
      case 'ident': case 'hash': {
        const c = top && role ? recolor(n, s, role) : null;
        if (c) out.push(...c);
        else if (n.kind === 'ident') out.push(ident(n.value), 'word');
        else out.push(`#${nameText(n.value)}`, 'word');
        break;
      }
      case 'string': out.push(string(n.value), 'other'); break;
      case 'number': case 'percentage': case 'dimension':
        // caniemail css-unit-vh: iOS Mail resolves vh to zero.
        out.push(s.client === 'apple-mail-ios' && n.kind === 'dimension' && n.unit === 'vh' ? '0px' : number(n), 'word');
        break;
      case 'url': { const u = dataUrl(n.value, s); if (!u) return null; out.push(u, 'fn'); break; }
      case 'fn': { const t = fnValue(n, s, prop, role, math, top); if (!t) return null; out.push(...t); break; }
      case 'block':
        if (n.open === '(' && math) { const t = value(n.items, s, prop, undefined, true, false); if (t === null) return null; out.push(`(${t})`, 'paren'); }
        else if (n.open === '[' && prop.startsWith('grid') && n.items.every(m => m.kind === 'ident' || m.kind === 'ws')) out.push(`[${n.items.filter(m => m.kind === 'ident').map(m => ident((m as Token).value)).join(' ')}]`, 'other');
        else return null;
        break;
      default: return null;
    }
  }
  return out.text || null;
}

const topWords = (items: Node[]) => items.filter((n): n is Token => n.kind === 'ident').map(n => n.value.toLowerCase());
const hasDelim = (items: Node[], d: string) => items.some(n => n.kind === 'delim' && n.value === d);
const negative = (items: Node[]) => items.some(n => (n.kind === 'dimension' || n.kind === 'number' || n.kind === 'percentage') && n.num < 0);
const hasImage = (items: Node[]) => items.some(n => n.kind === 'url' || (n.kind === 'fn' && (n.name === 'url' || n.name.includes('gradient'))));

/** Value rules the support matrix records only as notes. */
function valueAllowed(name: string, items: Node[], s: Scope): boolean {
  const { fam } = s, words = topWords(items);
  switch (name) {
    case 'position': return words.length === 1 && items.length === 1 && POSITIONS[fam].includes(words[0]!); // caniemail css-position notes
    case 'display':
      if (s.ganga && words.some(w => ['flex', 'grid', 'flow-root', 'contents', 'inline-flex', 'inline-grid', 'initial', 'revert', 'unset'].includes(w))) return false;
      if (s.ganga && words.length > 1) return false;
      return fam !== 'yahoo' || !(words.some(w => ['flow-root', 'inline-flex', 'inline-grid', 'contents', 'revert'].includes(w)) || words.length > 1);
    case 'margin': case 'margin-top': case 'margin-right': case 'margin-bottom': case 'margin-left':
      return !((fam === 'gmail' || fam === 'yahoo' || fam === 'outlook') && negative(items));
    case 'text-indent': return !((fam === 'gmail' || fam === 'yahoo') && negative(items));
    case 'font-weight': return fam !== 'yahoo' || !items.some(n => n.kind === 'number' && (n.num % 100 !== 0 || n.num < 100 || n.num > 900));
    case 'float': case 'clear': return !((s.client !== 'gmail-web' && fam === 'gmail') || fam === 'yahoo') || !words.some(w => w === 'inline-start' || w === 'inline-end');
    case 'list-style': return fam !== 'gmail' || !hasImage(items); // Gmail removes the whole property
    case 'background-image':
      // email-bugs#135: Gmail Android mangles inline gradients into an invalid url().
      if (s.inline && (s.client === 'gmail-android' || s.client === 'gmail-android-non-google') && someFn(items, n => n.name.includes('gradient'))) return false;
      return fam !== 'yahoo' || !items.some(n => n.kind === ','); // Yahoo drops the comma between layers
    case 'background': return fam !== 'yahoo' || !(items.some(n => n.kind === ',') || hasDelim(items, '/'));
    case 'transition': return fam !== 'yahoo' || !words.includes('all');
  }
  if (fam === 'yahoo' && name.startsWith('transition-')) return false;
  if (fam === 'yahoo' && name.includes('radius') && hasDelim(items, '/')) return false;
  // rgb()/rgba() whitespace syntax: unsupported on Yahoo and AOL (Gmail rejects it as a whole block or attribute).
  if (fam === 'yahoo' && someFn(items, isSpaceSyntax)) return false;
  return true;
}
const someFn = (items: Node[], test: (n: Func) => boolean): boolean => items.some(n => n.kind === 'fn' ? test(n) || someFn(n.items, test) : n.kind === 'block' && someFn(n.items, test));

function filterDecl(d: Decl, s: Scope): string | null {
  if (d.escaped || !d.value.length) return null;
  let name = d.name, important = d.important, items = d.value;
  if (name.startsWith('--')) {
    if (no(s, 'css-variables')) return null;
    const v = value(items, s, name, undefined);
    return v === null ? null : `${ident(name)}:${v}${important ? '!important' : ''}`;
  }
  if (DENIED.test(name) || (s.fam === 'gmail' && !s.ganga && !GMAIL_PROPERTIES.has(name))) return null;
  const keys = declKeys(name, items, important);
  // caniemail css-height #1 and email-bugs#9: Yahoo and AOL rewrite height to min-height.
  if (s.fam === 'yahoo' && name === 'height') { name = 'min-height'; keys.delete('css-height'); keys.add('css-min-height'); }
  // caniemail css-list-style #3: the image part goes, the rest stays.
  if (name === 'list-style' && s.fam !== 'gmail' && no(s, 'css-list-style-image')) items = items.filter(n => !hasImage([n]));
  if (!valueAllowed(name, items, s)) return null;
  for (const key of keys) if (no(s, key)) return null;
  // email-bugs#16: Yahoo removes `!important` written without a space before it on background-image.
  if (s.fam === 'yahoo' && important && !d.spaced && name === 'background-image') important = false;
  const v = value(items, s, name, ROLES.get(name));
  return v === null ? null : `${ident(name)}:${v}${important ? '!important' : ''}`;
}

/** Gmail removes a whole `<style>` or `style` attribute on one invalid token (hteumeuleu 2017, email-bugs#13 and #160):
 *  misplaced `= * $ % \ & @ ^ { } [ ] ( ) ? | < >`, escapes, uppercase `!important`, space-separated rgb(). */
function gmailFatal(d: Decl): boolean {
  const bad = (items: Node[], math: boolean): boolean => items.some(n => {
    switch (n.kind) {
      case 'bad': case 'at': case 'cdo': case 'cdc': case ':': case ';': case '[': case ']': case '(': case ')': case '{': case '}': return true;
      case 'delim': return !(n.value === '/' || (math && '*+-'.includes(n.value)));
      case 'ident': case 'string': case 'hash': case 'dimension': return n.escaped;
      case 'block': return n.open !== '(' || !math || bad(n.items, true);
      case 'fn': return isSpaceSyntax(n) || bad(n.items, math || MATH.has(n.name));
      default: return false;
    }
  });
  return d.escaped || (d.important && d.bang !== 'important') || bad(d.value, false);
}

// ----- Selectors -------------------------------------------------------------------------------------------------------

type Part =
  | { k: 'type' | 'class' | 'id' | 'nest'; name: string }
  | { k: 'attr'; name: string; op: string; value: string | null; flag: string }
  | { k: 'pseudo' | 'element'; name: string; args: Node[] | null; sub: Complex[] | null };
type Complex = { compounds: Part[][]; combinators: string[]; lead: string };

const PSEUDO_CLASSES = new Set(('active any-link checked default disabled empty enabled first-child first-of-type focus focus-visible focus-within hover '
  + 'in-range indeterminate invalid last-child last-of-type link only-child only-of-type optional out-of-range placeholder-shown read-only read-write '
  + 'required root target valid visited').split(' '));
const PSEUDO_ELEMENTS = new Set(['after', 'before', 'first-letter', 'first-line', 'marker', 'placeholder', 'selection']);
const LEGACY_ELEMENTS = new Set(['after', 'before', 'first-letter', 'first-line']);
const COMBINATOR_KEYS: Record<string, string> = { ' ': 'css-selector-descendant', '>': 'css-selector-child', '+': 'css-selector-adjacent-sibling', '~': 'css-selector-general-sibling' };

function attribute(items: Node[]): Part | null {
  const t = solid(items), head = t[0];
  if (head?.kind !== 'ident') return null;
  const name = head.value.toLowerCase();
  if (t.length === 1) return { k: 'attr', name, op: '', value: null, flag: '' };
  let j = 1, op = '';
  const a = t[1], b = t[2];
  if (a?.kind === 'delim' && '~|^$*'.includes(a.value) && b?.kind === 'delim' && b.value === '=') { op = `${a.value}=`; j = 3; }
  else if (a?.kind === 'delim' && a.value === '=') { op = '='; j = 2; }
  else return null;
  const v = t[j];
  if (v?.kind !== 'ident' && v?.kind !== 'string') return null;
  const f = t[j + 1];
  const flag = f?.kind === 'ident' && /^[is]$/i.test(f.value) ? f.value.toLowerCase() : '';
  return j + 1 + (flag ? 1 : 0) === t.length ? { k: 'attr', name, op, value: v.value, flag } : null;
}

function pseudoFunction(name: string, items: Node[]): Part | null {
  if (name === 'not' || name === 'is' || name === 'where' || name === 'has') { const sub = parseList(items, name === 'has'); return sub ? { k: 'pseudo', name, args: items, sub } : null; }
  if (/^nth-(?:last-)?(?:child|of-type)$/.test(name)) return items.every(n => n.kind === 'ws' || n.kind === 'number' || n.kind === 'dimension' || (n.kind === 'delim' && '+-'.includes(n.value)) || (n.kind === 'ident' && /^(?:odd|even|-?n(?:-\d+)?|-?n-)$/i.test(n.value))) ? { k: 'pseudo', name, args: items, sub: null } : null;
  if (name === 'lang' || name === 'dir') return items.every(n => n.kind === 'ws' || n.kind === 'ident' || n.kind === 'string' || n.kind === ',') ? { k: 'pseudo', name, args: items, sub: null } : null;
  return null;
}

function parseComplex(nodes: Node[], relative: boolean): Complex | null {
  const compounds: Part[][] = [], combinators: string[] = [];
  let parts: Part[] = [], pending = '', lead = '';
  const flush = () => {
    if (!parts.length) return true;
    if (compounds.length) combinators.push(pending || ' ');
    else if (pending.trim()) { if (!relative) return false; lead = pending; }
    compounds.push(parts); parts = []; pending = '';
    return true;
  };
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!, next = nodes[i + 1];
    if (n.kind === 'ws') { if (parts.length) { if (!flush()) return null; pending = ' '; } else if (compounds.length && !pending) pending = ' '; continue; }
    if (n.kind === 'delim' && '>+~'.includes(n.value)) { if (!flush() || pending.trim()) return null; pending = n.value; continue; }
    if (n.kind === 'ident') { if (parts.length) return null; parts.push({ k: 'type', name: n.value.toLowerCase() }); continue; }
    if (n.kind === 'delim' && n.value === '*') { if (parts.length || (next?.kind === 'delim' && next.value === '|')) return null; parts.push({ k: 'type', name: '*' }); continue; }
    if (n.kind === 'delim' && n.value === '.') { if (next?.kind !== 'ident') return null; parts.push({ k: 'class', name: next.value }); i++; continue; }
    if (n.kind === 'delim' && n.value === '&') { parts.push({ k: 'nest', name: '&' }); continue; }
    if (n.kind === 'hash') { if (!n.id) return null; parts.push({ k: 'id', name: n.value }); continue; }
    if (n.kind === 'block' && n.open === '[') { const a = attribute(n.items); if (!a) return null; parts.push(a); continue; }
    if (n.kind === ':') {
      let m = next, element = false;
      if (m?.kind === ':') { element = true; i++; m = nodes[i + 1]; }
      if (!m) return null;
      i++;
      if (m.kind === 'ident') {
        const name = m.value.toLowerCase();
        if (element || LEGACY_ELEMENTS.has(name)) { if (!PSEUDO_ELEMENTS.has(name)) return null; parts.push({ k: 'element', name, args: null, sub: null }); }
        else { if (!PSEUDO_CLASSES.has(name)) return null; parts.push({ k: 'pseudo', name, args: null, sub: null }); }
        continue;
      }
      if (m.kind === 'fn' && !element) { const p = pseudoFunction(m.name, m.items); if (!p) return null; parts.push(p); continue; }
      return null;
    }
    return null;
  }
  if (!flush() || pending.trim() || !compounds.length) return null;
  return { compounds, combinators, lead };
}
function parseList(nodes: Node[], relative: boolean): Complex[] | null {
  const list: Complex[] = [];
  for (const part of splitComma(nodes)) {
    const c = parseComplex(part, relative);
    if (!c || list.length >= MAX_SELECTORS) return null;
    list.push(c);
  }
  return list;
}

function selectorKeys(list: Complex[], keys: Set<string>) {
  if (list.length > 1) keys.add('css-selector-grouping');
  for (const c of list) {
    for (const comb of [c.lead, ...c.combinators]) if (comb) keys.add(COMBINATOR_KEYS[comb]!);
    for (const parts of c.compounds) {
      let named = 0;
      for (const p of parts) {
        if (p.k === 'type') keys.add(p.name === '*' ? 'css-selector-universal' : 'css-selector-type');
        else if (p.k === 'class' || p.k === 'id') { keys.add(`css-selector-${p.k}`); named++; }
        else if (p.k === 'attr') keys.add('css-selector-attribute');
        else if (p.k === 'pseudo') { keys.add(`css-pseudo-class-${p.name}`); if (p.sub) selectorKeys(p.sub, keys); }
        else if (p.k === 'element') keys.add(`css-pseudo-element-${p.name}`);
      }
      if (named >= 2) keys.add('css-selector-chaining');
    }
  }
}

/** One compound as the client rewrites it, or null when the client drops the rule. */
function compoundText(parts: Part[], s: Scope): string | null {
  const { fam } = s, named = parts.some(p => p.k === 'class' || p.k === 'id');
  for (const p of parts) {
    if (p.k === 'nest' && s.webmail) return null;
    if (p.k === 'attr') {
      if (fam === 'gmail' && !(p.name === 'class' && p.op === '~=')) return null; // caniemail css-selector-attribute #5
      if (fam === 'outlook' && (!['', '=', '~=', '|='].includes(p.op) || parts.some(q => q.k === 'class'))) return null; // #1 #2
      if (fam === 'yahoo' && p.op !== '=') return null; // #4
    }
    if (p.k === 'pseudo' || p.k === 'element') {
      if (fam === 'gmail' && p.name !== 'hover') return null;
      if (fam === 'outlook' && (named || parts.some(q => q.k === 'attr'))) return null; // only on type selectors
      if ((fam === 'outlook' || fam === 'yahoo') && !['first-child', 'first-of-type', 'last-child', 'last-of-type', 'only-child', 'only-of-type', 'hover', 'active', 'focus', 'focus-visible', 'focus-within', 'visited', 'link', 'checked', 'default', 'target', 'not', 'has', 'lang', 'after', 'before', 'first-letter', 'first-line', 'marker', 'placeholder'].includes(p.name) && !p.name.startsWith('nth-')) return null;
      // caniemail css-pseudo-class-nth-child and -has: Yahoo strips the argument, which invalidates the selector.
      if (fam === 'yahoo' && p.args) return null;
    }
    if (p.k === 'class' && fam === 'yahoo' && /^[-_]/.test(p.name)) return null; // email-bugs#22
  }
  // caniemail css-selector-chaining #4: Outlook.com prefixes only the first class of a chain, so the rule never matches.
  const chain = !(fam === 'outlook' && no(s, 'css-selector-chaining'));
  let first = true, out = '';
  for (const p of parts) {
    switch (p.k) {
      case 'type': out += p.name === '*' ? '*' : fam === 'outlook' && p.name === 'body' ? '.bane-mail-body' : ident(p.name); break;
      case 'class': {
        const name = fam === 'yahoo' && p.name.endsWith('__') ? p.name.slice(0, -1) : p.name; // email-bugs#22: one trailing underscore lost
        out += `.${ident((first || chain ? s.prefix : '') + name)}`;
        first = false;
        break;
      }
      case 'id': out += `#${ident(s.prefix + p.name)}`; break;
      case 'nest': out += '&'; break;
      case 'attr': {
        // Gmail prefixes `[class~=…]` values with its names; Outlook leaves them unprefixed (caniemail #3).
        const v = p.value === null ? '' : string(fam === 'gmail' ? s.prefix + p.value : p.value);
        out += `[${ident(p.name)}${p.op}${v}${p.flag ? ` ${p.flag}` : ''}]`;
        break;
      }
      case 'element': out += `::${p.name}`; break;
      case 'pseudo': {
        let args = '';
        if (p.sub) { const sub = p.sub.map(c => complexText(c, s, true)); if (sub.includes(null)) return null; args = `(${sub.join(',')})`; }
        else if (p.args) { const t = rawText(p.args, '+-'); if (t === null) return null; args = `(${t})`; }
        out += `:${p.name}${args}`;
      }
    }
  }
  return out;
}
function complexText(c: Complex, s: Scope, nested: boolean): string | null {
  let out = c.lead ? `${c.lead} ` : '';
  for (let i = 0; i < c.compounds.length; i++) {
    const t = compoundText(c.compounds[i]!, s);
    if (t === null) return null;
    out += (i ? (c.combinators[i - 1] === ' ' ? ' ' : c.combinators[i - 1]) : '') + t;
  }
  return !nested && s.webmail ? `.${ident(s.wrapper)} ${out}` : out;
}
/** A selector list scoped and renamed for the client, or null when the client drops the rule. */
function selectors(prelude: Node[], s: Scope, nested: boolean): string | null {
  const list = parseList(prelude, nested);
  if (!list) return null;
  const keys = new Set<string>();
  selectorKeys(list, keys);
  for (const key of keys) if (no(s, key) && !(key === 'css-selector-chaining' && s.fam === 'outlook')) return null;
  const texts = list.map(c => complexText(c, s, nested));
  return texts.includes(null) ? null : texts.join(',');
}

// ----- Media queries -----------------------------------------------------------------------------------------------------

type Tri = { v: 0 | 1 | 2; t: string }; // false, true, or unknown with the residual condition the browser evaluates
const TRUE: Tri = { v: 1, t: '' }, FALSE: Tri = { v: 0, t: '' };
const unknown = (t: string): Tri => ({ v: 2, t });
const tri = (b: boolean) => b ? TRUE : FALSE;
const and = (parts: Tri[]): Tri => parts.some(p => p.v === 0) ? FALSE : parts.some(p => p.v === 2) ? unknown(parts.filter(p => p.v === 2).map(p => p.t).join(' and ')) : TRUE;
const or = (parts: Tri[]): Tri => parts.some(p => p.v === 1) ? TRUE : parts.some(p => p.v === 2) ? unknown(parts.filter(p => p.v === 2).map(p => p.t).join(' or ')) : FALSE;
const not = (r: Tri): Tri => r.v === 2 ? unknown(`not ${r.t}`) : tri(!r.v);

const GMAIL_MEDIA = new Set(['min-width', 'max-width', 'min-device-width', 'max-device-width', 'orientation', 'min-resolution', 'max-resolution']);
const YAHOO_MEDIA = new Set(['min-width', 'max-width', 'min-height', 'max-height']);
const BROWSER_MEDIA = /^(?:(?:min-|max-)?(?:device-)?(?:height|aspect-ratio)|orientation|(?:min-|max-)?resolution|(?:-webkit-)?(?:min-|max-)?device-pixel-ratio|(?:min-|max-)?(?:color|color-index|monochrome)|color-gamut|dynamic-range|grid|scan|update|overflow-block|overflow-inline|scripting|display-mode)$/;
const mediaKey = (name: string) => name === 'prefers-color-scheme' || name === 'prefers-reduced-motion' || name === 'orientation' ? `css-at-media-${name}`
  : name === 'hover' || name === 'any-hover' ? 'css-at-media-hover' : /device-pixel-ratio$/.test(name) ? 'css-at-media-device-pixel-ratio' : '';

/** caniemail css-at-media notes: Gmail removes queries outside Google's list; Yahoo and AOL keep only screen and
 *  min/max width and height, turning the rest into `@media ()` or `( _filtered_a )`, which never match. */
function gate(name: string, val: Node[] | null, s: Scope): boolean {
  const key = mediaKey(name), blocked = key !== '' && no(s, key);
  if (s.fam === 'gmail') { if (!GMAIL_MEDIA.has(name) || blocked) throw new MediaDrop(); return true; }
  if (s.fam === 'yahoo') return YAHOO_MEDIA.has(name);
  if (blocked) return false;
  return !(s.client === 'apple-mail-ios' && name === 'orientation' && val?.some(n => lower(n) === 'portrait'));
}
function length(val: Node[]): number | null {
  const t = solid(val), n = t[0];
  if (t.length !== 1 || !n) return null;
  if (n.kind === 'number' && n.num === 0) return 0;
  if (n.kind !== 'dimension') return null;
  const scale: Record<string, number> = { px: 1, em: 16, rem: 16, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 };
  return scale[n.unit] === undefined ? null : n.num * scale[n.unit]!;
}
function featureValue(name: string, val: Node[] | null, s: Scope): 0 | 1 | 2 {
  const word = val && solid(val).length === 1 ? lower(solid(val)[0]) : '';
  const m = /^(min-|max-)?(?:device-)?width$/.exec(name);
  if (m) {
    if (!val) return 1;
    const px = length(val), w = s.ctx.width;
    return px === null ? 2 : (m[1] === 'min-' ? w >= px : m[1] === 'max-' ? w <= px : w === px) ? 1 : 0;
  }
  switch (name) {
    case 'prefers-color-scheme': return !val ? 1 : word === 'dark' ? +prefersDark(s) as 0 | 1 : word === 'light' ? +!prefersDark(s) as 0 | 1 : 0;
    case 'prefers-reduced-motion': case 'prefers-reduced-transparency': case 'prefers-reduced-data': case 'prefers-contrast': return word === 'no-preference' ? 1 : 0;
    case 'forced-colors': case 'inverted-colors': return word === 'none' ? 1 : 0;
    case 'hover': case 'any-hover': return (!val || word === 'hover' ? s.desktop : word === 'none' && !s.desktop) ? 1 : 0;
    case 'pointer': case 'any-pointer': return (!val || (word === 'fine' ? s.desktop : word === 'coarse' && !s.desktop)) ? 1 : 0;
  }
  return BROWSER_MEDIA.test(name) ? 2 : 0;
}
function feature(raw: Node[], s: Scope): Tri {
  const t = solid(raw), head = t[0];
  if (head?.kind === 'ident' && (t.length === 1 || t[1]!.kind === ':')) {
    const name = head.value.toLowerCase(), val = t.length === 1 ? null : t.slice(2);
    if ((val && !val.length) || !gate(name, val, s)) return FALSE;
    const v = featureValue(name, val, s);
    if (v !== 2) return tri(!!v);
    const text = rawText(raw, '/');
    return text === null ? FALSE : unknown(`(${text})`);
  }
  // Range syntax. Gmail's list has no range form; residual comparisons are written with `>` so no `<` reaches the output.
  if (s.fam === 'gmail') throw new MediaDrop();
  const at = t.findIndex(n => n.kind === 'ident');
  if (at < 0) return FALSE;
  const name = lower(t[at]);
  if (!/^(?:device-)?(?:width|height|aspect-ratio)$|^resolution$/.test(name) || (s.fam === 'yahoo' && !YAHOO_MEDIA.has(`min-${name}`))) return FALSE;
  const op = (a: Node | undefined, b: Node | undefined): string => a?.kind === 'delim' && '<>='.includes(a.value) ? (b?.kind === 'delim' && b.value === '=' && a.value !== '=' ? `${a.value}=` : a.value) : '';
  const flip = (o: string) => o.replace(/^</, '#').replace(/^>/, '<').replace(/^#/, '>');
  const comparisons: [string, Node[]][] = [];
  if (at + 1 < t.length) { const o = op(t[at + 1], t[at + 2]); if (!o) return FALSE; comparisons.push([o, t.slice(at + 1 + o.length)]); }
  if (at > 0) {
    const two = t[at - 1]?.kind === 'delim' && (t[at - 1] as Token).value === '=' && t[at - 2]?.kind === 'delim' && '<>'.includes((t[at - 2] as Token).value);
    const o = two ? op(t[at - 2], t[at - 1]) : op(t[at - 1], undefined);
    if (!o) return FALSE;
    comparisons.push([flip(o), t.slice(0, at - o.length)]);
  }
  return and(comparisons.map(([o, val]) => {
    if (!val.length) return FALSE;
    if (/width$/.test(name)) {
      const px = length(val), w = s.ctx.width;
      if (px === null) return FALSE;
      return tri(o === '<' ? w < px : o === '<=' ? w <= px : o === '>' ? w > px : o === '>=' ? w >= px : w === px);
    }
    const v = rawText(val, '/');
    if (v === null) return FALSE;
    return unknown(o.startsWith('<') ? `(${v} ${flip(o)} ${name})` : `(${name} ${o} ${v})`);
  }));
}
function inParens(n: Node | undefined, s: Scope): Tri {
  if (n?.kind !== 'block' || n.open !== '(') return FALSE;
  const t = solid(n.items);
  if (t[0]?.kind === 'block' || (lower(t[0]) === 'not' && t.length === 2)) { const r = condition(t, s, true); return r.v === 2 ? unknown(`(${r.t})`) : r; }
  return feature(n.items, s);
}
function condition(t: Node[], s: Scope, allowOr: boolean): Tri {
  if (!t.length) return FALSE;
  if (lower(t[0]) === 'not') { if (s.fam === 'gmail') throw new MediaDrop(); return t.length === 2 ? not(inParens(t[1], s)) : FALSE; }
  const parts = [inParens(t[0], s)];
  let op = '';
  for (let i = 1; i < t.length; i += 2) {
    const w = lower(t[i]);
    if ((w !== 'and' && w !== 'or') || (op && w !== op) || (w === 'or' && !allowOr) || i + 1 >= t.length) return FALSE;
    if (w === 'or' && s.fam === 'gmail') throw new MediaDrop();
    op = w;
    parts.push(inParens(t[i + 1], s));
  }
  return op === 'or' ? or(parts) : and(parts);
}
function mediaQuery(t: Node[], s: Scope): Tri {
  if (!t.length) return FALSE;
  const w0 = lower(t[0]);
  if (!w0 || (w0 === 'not' && t[1]?.kind === 'block')) return condition(t, s, true);
  let i = 1, negate = false, type = w0;
  if (w0 === 'not' || w0 === 'only') { if (t[1]?.kind !== 'ident') return FALSE; negate = w0 === 'not'; type = lower(t[1]); i = 2; }
  if (s.fam === 'gmail' && (negate || (type !== 'all' && type !== 'screen'))) throw new MediaDrop();
  let cond = TRUE;
  if (i < t.length) { if (lower(t[i]) !== 'and') return FALSE; cond = condition(t.slice(i + 1), s, false); }
  const r = (s.fam === 'yahoo' ? type === 'screen' : type === 'all' || type === 'screen') ? cond : FALSE;
  return !negate ? r : r.v === 2 ? unknown(`not ${ident(type)} and ${r.t}`) : tri(!r.v);
}
/** A media query list evaluated for the emulated device and theme: width, color scheme, hover, pointer and motion
 *  are decided here, independent of the host. Only height, orientation and resolution are left to the browser. */
function media(prelude: Node[], s: Scope): { keep: boolean; cond: string | null } {
  if (!solid(prelude).length) return { keep: true, cond: null };
  try {
    const residual: string[] = [];
    for (const q of splitComma(prelude)) {
      const r = mediaQuery(solid(q), s);
      if (r.v === 1) return { keep: true, cond: null };
      if (r.v === 2) residual.push(r.t);
    }
    return residual.length ? { keep: true, cond: residual.join(',') } : { keep: false, cond: null };
  } catch (e) {
    if (e instanceof MediaDrop) return { keep: false, cond: null };
    throw e;
  }
}

// ----- Style sheets ------------------------------------------------------------------------------------------------------

function emitBlock(nodes: Node[], s: Scope, depth: number): string {
  if (depth > MAX_DEPTH) throw new Limit();
  const c = contents(nodes), parts: string[] = [];
  for (const d of c.decls) { const t = filterDecl(d, s); if (t) parts.push(t); }
  let nested = '';
  for (const r of c.rules) {
    // caniemail css-nesting #3: Yahoo and AOL remove nested selectors and apply their declarations to the parent.
    if (s.nesting === 'flatten') { if (r.kind === 'rule') { const inner = emitBlock(r.block, s, depth + 1); if (inner) parts.push(inner); } continue; }
    if (s.nesting !== 'keep') continue;
    if (r.kind === 'rule') {
      const sel = selectors(r.prelude, s, true), inner = sel === null ? '' : emitBlock(r.block, s, depth + 1);
      if (inner) nested += `${sel}{${inner}}`;
    } else if (r.name === 'media' && r.block && !no(s, 'css-at-media')) {
      const m = media(r.prelude, s), inner = m.keep ? emitBlock(r.block, s, depth + 1) : '';
      if (inner) nested += m.cond === null ? `&{${inner}}` : `@media ${m.cond}{${inner}}`;
    }
  }
  return parts.join(';') + (nested && parts.length ? ';' : '') + nested;
}

function keyframes(r: Extract<Rule, { kind: 'atrule' }>, s: Scope, depth: number): string {
  if (!r.block || no(s, 'css-at-keyframes')) return '';
  const head = solid(r.prelude);
  if (head.length !== 1 || (head[0]!.kind !== 'ident' && head[0]!.kind !== 'string')) return '';
  const name = head[0]!.kind === 'ident' ? ident(head[0]!.value) : string(head[0]!.value), frames = { ...s, nesting: 'drop' as const };
  let out = '';
  for (const f of rules(r.block, false)) {
    if (f.kind !== 'rule') continue;
    const stops: string[] = [];
    for (const p of splitComma(f.prelude).map(solid)) {
      const n = p[0];
      if (p.length === 1 && n?.kind === 'percentage' && n.num >= 0 && n.num <= 100) stops.push(number(n));
      else if (p.length === 1 && (lower(n) === 'from' || lower(n) === 'to')) stops.push(lower(n));
      else { stops.length = 0; break; }
    }
    const body = stops.length ? emitBlock(f.block, frames, depth + 1) : '';
    if (body) out += `${stops.join(',')}{${body}}`;
  }
  return out ? `@keyframes ${name}{${out}}` : '';
}

function emitRules(list: Rule[], s: Scope, depth: number, inMedia: boolean): string {
  if (depth > MAX_DEPTH) throw new Limit();
  let out = '';
  for (const r of list) {
    if (r.kind === 'rule') {
      const sel = selectors(r.prelude, s, false), body = sel === null ? '' : emitBlock(r.block, s, depth + 1);
      if (body) out += `${sel}{${body}}`;
    } else if (r.block && r.name === 'media') {
      // caniemail css-at-media #10: Outlook removes nested media queries.
      if (no(s, 'css-at-media') || (inMedia && s.fam === 'outlook')) continue;
      const m = media(r.prelude, s), inner = m.keep ? emitRules(rules(r.block, false), s, depth + 1, true) : '';
      if (inner) out += m.cond === null ? inner : `@media ${m.cond}{${inner}}`;
    } else if (r.block && r.name === 'supports') {
      const cond = no(s, 'css-at-supports') ? null : rawText(r.prelude, '');
      const inner = cond ? emitRules(rules(r.block, false), s, depth + 1, inMedia) : '';
      if (inner) out += `@supports ${cond}{${inner}}`;
    } else if (r.name === 'keyframes' || r.name === '-webkit-keyframes') out += keyframes(r, s, depth);
    // @font-face, @import and every other at-rule would load or declare outside resources: omitted.
    if (out.length > MAX_OUTPUT) throw new Limit();
  }
  return out;
}

const hasAt = (nodes: Node[]): boolean => nodes.some(n => n.kind === 'at' || ((n.kind === 'block' || n.kind === 'fn') && hasAt(n.items)));
function gmailRejects(list: Rule[]): boolean {
  const rejects = (r: Rule): boolean => {
    if (r.kind === 'atrule') return !!r.block && (hasAt(r.block) || (r.name === 'media' && rules(r.block, false).some(rejects)));
    if (r.prelude.some(n => n.kind === '}' || n.kind === ']' || n.kind === ')' || n.kind === 'bad' || (n.kind === 'block' && n.open === '('))) return true;
    if (r.block.some(n => n.kind === 'block' && n.open === '{') || hasAt(r.block)) return true; // nesting: an at-rule or block inside a rule
    const c = contents(r.block);
    return c.malformed || c.decls.some(gmailFatal);
  };
  return list.some(rejects);
}

/** caniemail css-at-media and email-bugs#92 (re-confirmed 2026-11): Outlook.com drops every style after two adjacent closing braces. */
function truncateAtDoubleBrace(tokens: Token[]): Token[] {
  for (let i = 1; i < tokens.length; i++) if (tokens[i]!.kind === '}' && tokens[i - 1]!.kind === '}' && tokens[i]!.at === tokens[i - 1]!.at + 1) return tokens.slice(0, i + 1);
  return tokens;
}

/** A `<style>` sheet as the client applies it, scoped and renamed for the emulated container; '' when it keeps none. */
export function stylesheet(css: string, ctx: CssContext): string {
  const s = scope(ctx, false);
  // caniemail html-style: no <style> with non-Google accounts in the Gmail apps.
  if (s.ganga || no(s, 'html-style') || css.length > MAX_SHEET) return '';
  try {
    let tokens = tokenize(css);
    if (s.client === 'outlook-web' || s.client === 'outlook-new-windows') tokens = truncateAtDoubleBrace(tokens);
    const list = rules(components(tokens), true);
    if (s.fam === 'gmail' && gmailRejects(list)) return '';
    const out = emitRules(list, s, 0, false);
    return out.length > MAX_OUTPUT ? '' : out;
  } catch (e) {
    if (e instanceof Limit) return '';
    throw e;
  }
}

/** A `style` attribute as the client applies it; '' when it keeps nothing. */
export function declarations(css: string, ctx: CssContext): string {
  if (css.length > MAX_INLINE) return '';
  const s = scope(ctx, true);
  try {
    const c = contents(components(tokenize(css)));
    if (s.fam === 'gmail' && (c.malformed || c.rules.length || c.decls.some(gmailFatal))) return '';
    return c.decls.map(d => filterDecl(d, s)).filter(Boolean).join(';');
  } catch (e) {
    if (e instanceof Limit) return '';
    throw e;
  }
}

// ----- Feature collection --------------------------------------------------------------------------------------------------

function collectBlock(nodes: Node[], found: Set<string>, depth: number) {
  const c = contents(nodes);
  for (const d of c.decls) for (const key of declKeys(d.name, d.value, d.important)) found.add(key);
  if (c.rules.length && depth > 0) found.add('css-nesting');
  collectRules(c.rules, found, depth, true);
}
/** `inStyle`: the rules are nested in a style rule, so group rules hold declarations as well as rules. */
function collectRules(list: Rule[], found: Set<string>, depth: number, inStyle = false) {
  if (depth > MAX_DEPTH) throw new Limit();
  for (const r of list) {
    if (r.kind === 'rule') {
      const sel = parseList(r.prelude, inStyle);
      if (sel) selectorKeys(sel, found);
      collectBlock(r.block, found, depth + 1);
      continue;
    }
    if (r.name === 'media') {
      found.add('css-at-media');
      const walk = (nodes: Node[]) => { for (const n of nodes) { if (n.kind === 'ident') { const key = mediaKey(n.value.toLowerCase()); if (key) found.add(key); } else if (n.kind === 'block') walk(n.items); } };
      walk(r.prelude);
    } else if (r.name === 'font-face') found.add('css-at-font-face');
    else if (r.name === 'import') { found.add('css-at-import'); continue; }
    else if (r.name === 'supports') found.add('css-at-supports');
    else if (r.name === 'keyframes' || r.name === '-webkit-keyframes') {
      found.add('css-at-keyframes');
      for (const f of r.block ? rules(r.block, false) : []) if (f.kind === 'rule') collectBlock(f.block, found, depth + 1);
      continue;
    }
    if (!r.block) continue;
    if (r.name === 'font-face' || inStyle) collectBlock(r.block, found, depth + 1);
    else collectRules(rules(r.block, false), found, depth + 1);
  }
}

/** Adds the caniemail feature keys a sheet (or `style` attribute) uses, from parsed syntax. */
export function collectCss(css: string, inline: boolean, found: Set<string>): void {
  if (css.length > (inline ? MAX_INLINE : MAX_SHEET)) return;
  try {
    const comments = { found: false }, nodes = components(tokenize(css, comments));
    if (comments.found) found.add('css-comments');
    if (inline) collectBlock(nodes, found, 0);
    else collectRules(rules(nodes, true), found, 0);
  } catch (e) {
    if (!(e instanceof Limit)) throw e;
  }
}
