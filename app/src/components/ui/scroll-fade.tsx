// Scrollbars are hidden everywhere (ui.css). Where a scroll area clips its content mid-view, the clipped edge fades
// instead: this list names those areas once, so a new surface built from them inherits the fade, and any other area
// opts in with .ui-scroll-fade. The page's own scroll (.page-surface) has no fade. The fade masks the whole element, its
// background, border and shadow too, so a surface with a shadow scrolls an inner .ui-popover-scroll instead.
const FADES = [
  '.ui-scroll-fade', '.ui-dialog__body', '.ui-sheet__body', '.ui-table-scroll', '.ui-tabs', '.sidebar', '.support-log', 'pre',
  '.limits-table-scroll', '.docs-table-scroll', '.legal-table', '.docs-install > code', '.developer-url > code', '.trace-code',
  '.docs-sidebar', '.legal-toc', '.legal-switcher', '.settings-rail__groups', '.rcv-filters', '.mailbox-threads', '.mailbox-reader',
  '.delivery-timeline', '.template-picker', '.settings-key-domain-options', '.ritual-diff', '.ui-popover-scroll',
  '.uin-list', '.uin-body',
].join(', ')

// Marks the edges with content beyond them (data-more-above, -below, -left, -right) from scrolling, the area's size
// and its children's sizes; watchScrollFades refreshes it when its content changes. The fade grows in only after the
// first frame, so an area that appears already overflowing is at rest when it does. Only an axis that scrolls fades: an
// element whose content overflows visibly (a <pre> inside a scrolling diff) keeps it.
function track(el: HTMLElement) {
  const style = getComputedStyle(el), scrolls = (value: string) => value === 'auto' || value === 'scroll'
  const update = () => {
    const x = scrolls(style.overflowX), y = scrolls(style.overflowY)
    el.toggleAttribute('data-scroll-fade', x || y)
    const right = el.scrollWidth - el.clientWidth, down = el.scrollHeight - el.clientHeight, left = Math.abs(el.scrollLeft)
    el.toggleAttribute('data-more-above', y && el.scrollTop > 1)
    el.toggleAttribute('data-more-below', y && down - el.scrollTop > 1)
    el.toggleAttribute('data-more-left', x && left > 1)
    el.toggleAttribute('data-more-right', x && right - left > 1)
  }
  const sizes = new ResizeObserver(update)
  const refresh = () => { sizes.disconnect(); sizes.observe(el); for (const child of el.children) sizes.observe(child); update() }
  refresh()
  el.addEventListener('scroll', update, { passive: true })
  const frame = requestAnimationFrame(() => el.setAttribute('data-settled', ''))
  const stop = () => { cancelAnimationFrame(frame); sizes.disconnect(); el.removeEventListener('scroll', update) }
  return { refresh, stop }
}

const MARKS = ['data-scroll-fade', 'data-settled', 'data-more-above', 'data-more-below', 'data-more-left', 'data-more-right']

/** Attaches the edge fade to every matching scroll area in the document, now and as they mount; detaches as they leave. */
export function watchScrollFades(root: HTMLElement = document.body) {
  const tracked = new Map<HTMLElement, ReturnType<typeof track>>(), changed = new Set<HTMLElement>()
  let frame = 0
  const each = (node: Node, fn: (el: HTMLElement) => void) => {
    if (!(node instanceof HTMLElement)) return
    if (node.matches(FADES)) fn(node)
    for (const el of node.querySelectorAll<HTMLElement>(FADES)) fn(el)
  }
  const attach = (el: HTMLElement) => { if (!tracked.has(el)) tracked.set(el, track(el)) }
  const release = (el: HTMLElement) => { tracked.get(el)?.stop(); tracked.delete(el) }
  // Content changed somewhere inside: refresh every tracked area around it once, on the next frame.
  const touched = (node: Node | null) => {
    for (let el = node instanceof HTMLElement ? node : node?.parentElement ?? null; el; el = el.parentElement) if (tracked.has(el)) changed.add(el)
    if (changed.size && !frame) frame = requestAnimationFrame(() => { frame = 0; for (const el of changed) tracked.get(el)?.refresh(); changed.clear() })
  }
  each(root, attach)
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.removedNodes) each(node, el => { if (!el.isConnected) release(el) })
      for (const node of record.addedNodes) if (node.isConnected) each(node, attach)
      if (record.type === 'attributes' && record.target instanceof HTMLElement) {
        // A class change can turn an existing element into a scroll area, or out of one.
        const el = record.target
        if (el.matches(FADES)) attach(el)
        else if (tracked.has(el)) { release(el); for (const name of MARKS) el.removeAttribute(name) }
      } else touched(record.target)
    }
  })
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] })
  return () => { observer.disconnect(); cancelAnimationFrame(frame); for (const { stop } of tracked.values()) stop(); tracked.clear() }
}
