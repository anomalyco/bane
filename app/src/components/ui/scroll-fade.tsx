// Scrollbars are hidden everywhere (ui.css). Where a scroll area clips its content mid-view, the clipped edge fades
// instead: this list names those areas once, so a new surface built from them inherits the fade, and any other area
// opts in with .ui-scroll-fade. The page's own scroll (.page-surface) has no fade. The fade masks the whole element, its
// background, border and shadow too, so a surface with a shadow scrolls an inner .ui-popover-scroll instead.
const FADES = [
  '.ui-scroll-fade', '.ui-dialog__body', '.ui-sheet__body', '.ui-table-scroll', '.ui-tabs', '.sidebar', '.support-log', 'pre',
  '.limits-table-scroll', '.docs-table-scroll', '.legal-table', '.docs-install > code', '.developer-url > code', '.trace-code',
  '.docs-sidebar', '.legal-toc', '.legal-switcher', '.settings-rail__groups', '.rcv-filters', '.mailbox-threads', '.mailbox-reader',
  '.delivery-timeline', '.template-picker', '.settings-key-domain-options', '.ritual-diff', '.ui-popover-scroll',
  '.uin-list', '.uin-body', '.docs-toc-scroll',
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
  document.addEventListener('focusin', revealFocus)
  document.addEventListener('focusout', releaseClippedFocus)
  return () => { observer.disconnect(); document.removeEventListener('focusin', revealFocus); document.removeEventListener('focusout', releaseClippedFocus); cancelAnimationFrame(frame); for (const { stop } of tracked.values()) stop(); tracked.clear() }
}

// Keyboard focus lands with its whole ring in view. Chrome leaves a control that is already partly visible where it is
// (the last tab of a sideways rail, a field half below the fold), so it is scrolled the rest of the way, nearest edge
// first; the area's scroll-padding keeps it clear of the edge, the fade and the ring. A control that a text clip cuts
// (an address past a cell's ellipsis) can't be scrolled into view, so its ring moves to that clip (data-focus-clipped).
function revealFocus(event: FocusEvent) {
  const el = event.target
  if (!(el instanceof HTMLElement)) return
  requestAnimationFrame(() => {
    if (document.activeElement !== el || !el.matches(':focus-visible')) return
    // The ring is the control's own outline, or a row's or card's drawn around it (:has(:focus-visible)).
    let ring: HTMLElement = el
    for (let n: HTMLElement | null = el, depth = 0; n && depth < 5; n = n.parentElement, depth++) {
      const style = getComputedStyle(n)
      if (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) { ring = n; break }
    }
    const style = getComputedStyle(ring), reach = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset) || 0)
    const r = ring.getBoundingClientRect()
    const outside = (c: { left: number; top: number; right: number; bottom: number }) => r.left - reach < c.left - .5 || r.top - reach < c.top - .5 || r.right + reach > c.right + .5 || r.bottom + reach > c.bottom + .5
    let hidden = outside({ left: 0, top: 0, right: innerWidth, bottom: innerHeight })
    for (let n = ring.parentElement; n && !hidden; n = n.parentElement) {
      const s = getComputedStyle(n)
      if (!/auto|scroll/.test(s.overflowX + s.overflowY)) continue
      const c = n.getBoundingClientRect()
      hidden = outside({ left: c.left + n.clientLeft, top: c.top + n.clientTop, right: c.left + n.clientLeft + n.clientWidth, bottom: c.top + n.clientTop + n.clientHeight })
    }
    if (hidden) ring.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    // The control itself, not just its ring, cut by a clip on an axis that clips.
    const after = ring.getBoundingClientRect()
    for (let n = ring.parentElement; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n), x = /hidden|clip/.test(s.overflowX), y = /hidden|clip/.test(s.overflowY)
      if (!x && !y) continue
      const c = n.getBoundingClientRect()
      if (x && (after.left < c.left - .5 || after.right > c.right + .5) || y && (after.top < c.top - .5 || after.bottom > c.bottom + .5)) { n.setAttribute('data-focus-clipped', ''); return }
    }
  })
}

function releaseClippedFocus() { for (const el of document.querySelectorAll('[data-focus-clipped]')) el.removeAttribute('data-focus-clipped') }
