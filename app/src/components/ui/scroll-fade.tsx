// A scroll area with its scrollbar hidden (.ui-scroll-fade), as a callback ref: marks the edges that have content
// beyond them (data-more-above, data-more-below) so they fade out. Tracks scrolling, the area's own size and its
// children's, and children added later. The fade grows in only after the first frame, so an area that opens already
// overflowing is at rest when it appears.
export function scrollFade(el: HTMLElement | null) {
  if (!el) return
  const update = () => {
    el.toggleAttribute('data-more-above', el.scrollTop > 1)
    el.toggleAttribute('data-more-below', el.scrollHeight - el.clientHeight - el.scrollTop > 1)
  }
  const sizes = new ResizeObserver(update)
  const watch = () => { sizes.disconnect(); sizes.observe(el); for (const child of el.children) sizes.observe(child) }
  const children = new MutationObserver(() => { watch(); update() })
  update()
  watch()
  children.observe(el, { childList: true })
  el.addEventListener('scroll', update, { passive: true })
  const frame = requestAnimationFrame(() => el.setAttribute('data-settled', ''))
  return () => { cancelAnimationFrame(frame); sizes.disconnect(); children.disconnect(); el.removeEventListener('scroll', update) }
}
