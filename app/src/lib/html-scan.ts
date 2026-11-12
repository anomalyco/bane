// What the dashboard reads straight out of a message's HTML, before the sanitizer parses it. The sender writes that
// HTML, so each check passes over it once however it is shaped: no pattern here can back up over a long run and start
// again. No React here, so the API acceptance suite can test it.

const FONT_STYLE = /<style data-(?:bane|opensend)-fonts>/g
/** The HTML without the font block Bane adds to mail it sends, which names italic faces whether or not the message uses them. */
export function withoutFontStyles(html: string): string {
  let kept = '', from = 0
  for (const open of html.matchAll(FONT_STYLE)) {
    if (open.index < from) continue
    const end = html.indexOf('</style>', open.index)
    // Unclosed: nothing later closes either, so the rest stays as it is.
    if (end < 0) break
    kept += html.slice(from, open.index)
    from = end + '</style>'.length
  }
  return kept + html.slice(from)
}

/** Every complete <img …> tag, in order. */
export function imageTags(html: string): string[] {
  const tags: string[] = [], open = /<img\b/gi
  for (let match; (match = open.exec(html));) {
    const end = html.indexOf('>', open.lastIndex)
    // No tag closes after this point.
    if (end < 0) break
    tags.push(html.slice(match.index, end + 1))
    open.lastIndex = end + 1
  }
  return tags
}

/** A remote image or CSS background, for the "Load images" prompt only: the sanitizer and the frame's CSP decide what loads. */
export function mentionsRemoteImage(html: string): boolean {
  return imageTags(html).some(tag => /\ssrc\s*=[\s"']*https?:/i.test(tag)) || /url\([\s"']*(?:https?:)?\/\//i.test(html) || /\sbackground\s*=[\s"']*https?:/i.test(html)
}
