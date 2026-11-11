import { boundedHtmlFragment } from './bounded-html.js';
import type { DefaultTreeAdapterMap } from 'parse5';

/** HTML is parsed locally and never rendered, visited, or treated as instructions. */
export function visibleMail(text: string | null, html: string | null, extract = '') {
  let hiddenContent = false;
  const strip = (s: string) =>
    s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, () => {
      hiddenContent = true;
      return '';
    });
  const links: { text: string; href: string; mismatch: boolean }[] = [];
  function walk(n: DefaultTreeAdapterMap['childNode']): string {
    if (n.nodeName === '#text' && 'value' in n) return strip(n.value);
    if (!('tagName' in n)) return '';
    const attr = (k: string) => n.attrs.find((a) => a.name === k)?.value;
    if (
      ['script', 'style', 'template', 'noscript', 'head', 'svg', 'math'].includes(n.tagName) ||
      attr('hidden') !== undefined ||
      attr('aria-hidden') === 'true' ||
      /(?:display\s*:\s*none|visibility\s*:\s*hidden|(?:font-size|width|height|opacity)\s*:\s*0(?:[a-z%]+)?(?:\s*!important)?\s*(?:;|$))/i.test(
        attr('style') ?? '',
      )
    ) {
      hiddenContent = true;
      return '';
    }
    const s = n.childNodes.map(walk).join('');
    if (n.tagName === 'a' && links.length < 20 && extract.includes('links')) {
      try {
        const url = new URL(attr('href') ?? '');
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
          const claimed = s.trim().match(/^(?:https?:\/\/)?([\w-]+(?:\.[\w-]+)+)(?:[/:?#]|$)/i)?.[1];
          links.push({ text: s.trim(), href: url.href, mismatch: !!claimed && claimed.toLowerCase() !== url.hostname });
        }
      } catch {
        /* Not an absolute web link. */
      }
    }
    return ['div', 'p', 'br', 'li', 'tr'].includes(n.tagName) ? `\n${s}\n` : s;
  }
  const fragment = html ? boundedHtmlFragment(html) : null;
  const visible = html ? (fragment ? fragment.childNodes.map(walk).join('') : '') : strip(text ?? '');
  if (html && !fragment) hiddenContent = true;
  const codes = new Set<string>();
  if (extract.includes('codes'))
    for (const kw of visible.matchAll(/\b(?:code|verification|verify|otp|passcode|one[- ]time|pin)\b/gi)) {
      const around = visible.slice(Math.max(0, kw.index! - 80), kw.index! + kw[0].length + 80);
      for (const m of around.matchAll(/\b[A-Z0-9]{4,10}\b/gi))
        if (/\d/.test(m[0])) {
          codes.add(m[0]);
          if (codes.size === 5) break;
        }
      if (codes.size === 5) break;
    }
  return { text: visible.trim(), hiddenContent, extract: { codes: [...codes], links } };
}
