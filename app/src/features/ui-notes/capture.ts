import { addressParts, maskedParts } from '../../lib/private-address'
import type { NoteContext, NoteElement } from '../../data/ui-notes'

// What a UI note records about the element it was left on, so an agent can find it in the code and see it: where
// (URL, route pattern), how the page was shown (viewport, theme, device, build), a locator (a CSS path plus test IDs,
// components and text), its box and computed styles, and a screenshot crop with some context. Addresses never leave
// the page in full: text, labels, the URL and the screenshot are masked by the dashboard's one rule
// (lib/private-address.ts), revealed addresses included.

declare const __BANE_BUILD__: string
export const build = typeof __BANE_BUILD__ === 'string' ? __BANE_BUILD__ : 'unknown'
// The layer itself and its sheets (portalled to the body on a phone) are never noted or drawn.
const OWN = '[data-ui-notes], .uin-sheet'
export const ownElement = (node: EventTarget | null) => node instanceof Element && Boolean(node.closest(OWN))

/** Text with every address masked: its first two characters, then dots. */
export function maskText(text: string) {
  if (!text.includes('@')) return text
  return addressParts(text).map(part => part.address ? `${maskedParts(part.text)?.shown ?? part.text.slice(0, 2)}•••` : part.text).join('')
}
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text
const clean = (value: string | null | undefined, max: number) => { const text = value?.replace(/\s+/g, ' ').trim(); return text ? clip(maskText(text), max) : null }
function maskedUrl(href: string) {
  let decoded = href
  try { decoded = decodeURI(href).replace(/%40/gi, '@') } catch { /* keep it as it is */ }
  return clip(maskText(decoded), 2000)
}

/** The route pattern of a path: IDs, numbers and addresses become :id, so every campaign editor is /campaigns/:id/edit. */
export const routeOf = (pathname: string) => '/' + pathname.split('/').filter(Boolean).map(segment => {
  let value = segment
  try { value = decodeURIComponent(segment) } catch { /* keep it */ }
  return /^(?:[a-z]{2,6}_[A-Za-z0-9_-]{6,}|[0-9a-f]{8,}(?:-[0-9a-f]{4,}){0,4}|\d+)$/i.test(value) || value.includes('@') ? ':id' : segment
}).join('/')

// ---------------------------------------------------------------- locator

// React's generated IDs (useId: «r1», :r1:, _r_1_) and Radix's change between renders and builds.
const stableId = (id: string) => id && !/[:«»]|^_r_|radix-|^\d/.test(id) && id.length <= 64 ? id : null
const stableClass = (name: string) => /^[a-z][\w-]*$/i.test(name) && !/^(?:css|sc|jsx)-|\d{3,}/.test(name)
const quote = (value: string) => `"${value.replace(/["\\]/g, '\\$&')}"`
function step(node: Element) {
  let part = node.tagName.toLowerCase()
  const classes = [...node.classList].filter(stableClass).slice(0, 2)
  part += classes.map(name => `.${CSS.escape(name)}`).join('')
  const parent = node.parentElement
  if (parent) {
    const same = [...parent.children].filter(child => child.tagName === node.tagName)
    if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`
  }
  return part
}
/** A child-combinator path from the nearest stable anchor (an ID, a test ID, a data-component) down to the element. */
function pathFrom(target: Element, anchor: (node: Element) => string | null) {
  const parts: string[] = []
  for (let node: Element | null = target; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const own = node !== target || parts.length ? anchor(node) : null
    if (own) { parts.unshift(own); break }
    parts.unshift(step(node))
    if (parts.length > 14) break
  }
  return parts.join(' > ')
}
const byId = (node: Element) => node.id && stableId(node.id) ? `#${CSS.escape(node.id)}` : null
const byTestId = (node: Element) => { const value = node.getAttribute('data-testid'); return value ? `[data-testid=${quote(value)}]` : null }
const byComponent = (node: Element) => { const value = node.getAttribute('data-component'); return value ? `[data-component=${quote(value)}]` : null }
function selectors(target: Element) {
  const testId = target.getAttribute('data-testid')
  const own = byId(target) ?? (testId ? `[data-testid=${quote(testId)}]` : null)
  // The page itself (body, html) has no path: its tag finds it.
  const primary = own ?? (pathFrom(target, node => byId(node) ?? byTestId(node)) || target.tagName.toLowerCase())
  const alternatives = [pathFrom(target, node => byTestId(node) ?? byComponent(node) ?? byId(node)), (() => {
    // A short descendant path inside the page: the element's own tag and classes under its nearest ID.
    const anchor = target.parentElement?.closest('[id]')
    const id = anchor && stableId(anchor.id)
    return id ? `#${CSS.escape(id)} ${step(target).replace(/:nth-of-type\(\d+\)$/, '')}` : null
  })()].filter((value, index, all): value is string => Boolean(value) && value !== primary && all.indexOf(value) === index)
  return { selector: primary, alternatives: alternatives.map(value => maskText(value)), testId }
}

// The nearest components: data-component on shared primitives, and in a development build React's own names.
type Fiber = { type?: unknown; return?: Fiber | null }
const reactInternal = /^(?:Provider|Consumer|Context|ForwardRef|Memo|Suspense|Fragment|StrictMode|Profiler|Route|Routes|Router|Link|NavLink|Outlet|Slot|SlotClone|Presence|Primitive|DismissableLayer|FocusScope|Portal|ChunkPage|Anonymous)/
function componentNames(target: Element) {
  const names: string[] = []
  for (let node: Element | null = target; node && names.length < 8; node = node.parentElement) {
    const name = node.getAttribute('data-component')
    if (name && !names.includes(name)) names.push(name)
  }
  if (import.meta.env.DEV) {
    const key = Object.keys(target).find(name => name.startsWith('__reactFiber$'))
    for (let fiber = key ? (target as unknown as Record<string, Fiber>)[key] : null; fiber && names.length < 8; fiber = fiber.return ?? null) {
      const type = fiber.type as { displayName?: string; name?: string } | string | undefined
      const name = typeof type === 'function' || (typeof type === 'object' && type) ? (type as { displayName?: string; name?: string }).displayName ?? (type as { name?: string }).name : undefined
      if (name && name.length > 2 && /^[A-Z]/.test(name) && !reactInternal.test(name) && !names.includes(name)) names.push(name)
    }
  }
  return names
}

const implicitRole: Record<string, string> = { a: 'link', button: 'button', h1: 'heading', h2: 'heading', h3: 'heading', input: 'textbox', textarea: 'textbox', select: 'combobox', img: 'img', nav: 'navigation', main: 'main', table: 'table', tr: 'row', td: 'cell', th: 'columnheader', li: 'listitem', dialog: 'dialog' }
const STYLES = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'background-color', 'text-align', 'vertical-align', 'display', 'align-items', 'justify-content', 'gap',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'width', 'height', 'border-radius', 'opacity', 'white-space', 'text-overflow']

/** Everything recorded about the element and the page around it. */
export function describe(target: Element): { element: NoteElement; context: NoteContext; url: string; route: string } {
  const box = target.getBoundingClientRect(), computed = getComputedStyle(target)
  const styles = Object.fromEntries(STYLES.map(name => [name, computed.getPropertyValue(name).trim()] as const).filter(([, value]) => value && value !== 'normal' && value !== 'none' && value !== 'auto'))
  const names = componentNames(target)
  const html = target instanceof HTMLElement ? target : null
  const element: NoteElement = {
    ...selectors(target), component: names[0] ?? null, components: names.slice(0, 8).reverse(),
    tag: target.tagName.toLowerCase(), role: target.getAttribute('role') ?? implicitRole[target.tagName.toLowerCase()] ?? null,
    label: clean(target.getAttribute('aria-label') ?? target.getAttribute('title') ?? target.getAttribute('placeholder') ?? target.getAttribute('alt'), 300),
    text: clean(html?.innerText ?? target.textContent, 300),
    box: { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height), scrollX: round(scrollX), scrollY: round(scrollY) },
    styles: Object.fromEntries(Object.entries(styles).map(([name, value]) => [name, clip(value, 200)])),
  }
  const width = innerWidth
  const context: NoteContext = {
    viewport: { width, height: innerHeight }, dpr: Math.round((devicePixelRatio || 1) * 100) / 100,
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light', device: width <= 640 ? 'phone' : width < 900 ? 'tablet' : 'desktop',
    pointer: matchMedia('(pointer: coarse)').matches ? 'coarse' : 'fine', build: build.slice(0, 64), title: clip(maskText(document.title), 200),
  }
  return { element, context, url: maskedUrl(location.href), route: routeOf(location.pathname) }
}
const round = (value: number) => Math.round(value * 10) / 10

/** The element a note was left on, on this page now, or null when it is not here (moved, removed, another tab). */
export function locate(element: Pick<NoteElement, 'selector' | 'alternatives' | 'text'>): Element | null {
  for (const selector of [element.selector, ...element.alternatives]) {
    let found: Element[]
    try { found = [...document.querySelectorAll(selector)].filter(node => !ownElement(node) && node.getClientRects().length > 0) } catch { continue }
    if (found.length === 1) return found[0]!
    if (found.length > 1 && element.text) {
      const match = found.filter(node => clean((node as HTMLElement).innerText ?? node.textContent, 300) === element.text)
      if (match.length === 1) return match[0]!
    }
  }
  return null
}

// ---------------------------------------------------------------- screenshot

// Context around the element: 64 px each side, and at least 400 × 200 px (centred on it), so its neighbours show.
const MARGIN = 64, MIN_WIDTH = 400, MIN_HEIGHT = 200, MAX_BYTES = 2 * 1024 * 1024
type Rect = { left: number; top: number; right: number; bottom: number }
const intersect = (a: Rect, b: Rect): Rect => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) })
// The clone the image is drawn from: every address in its text, form values and labels masked, a revealed one
// included (the pointer is on it when the note is made). The library calls this for each cloned element once its
// children are in, and never for text nodes, so each element masks its own text.
function maskClone(node: Node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return
  const element = node as HTMLElement
  for (const child of element.childNodes) if (child.nodeType === Node.TEXT_NODE && child.nodeValue?.includes('@')) child.nodeValue = maskText(child.nodeValue)
  if ('value' in element && typeof element.value === 'string' && element.value.includes('@')) { const value = maskText(element.value); (element as HTMLInputElement).value = value; element.setAttribute('value', value) }
  for (const name of ['title', 'aria-label', 'placeholder', 'alt', 'value']) { const value = element.getAttribute(name); if (value?.includes('@')) element.setAttribute(name, maskText(value)) }
}
/**
 * A crop of the page around the element (see MARGIN; inside the viewport), drawn from a masked clone with the
 * element outlined. Draws the smallest ancestor that holds the crop, so a long page never renders whole. Null when the
 * browser can't draw it; the note is saved without one.
 */
export async function screenshot(target: Element): Promise<{ blob: Blob; width: number; height: number } | null> {
  try {
    const { domToCanvas } = await import('modern-screenshot')
    const rect = target.getBoundingClientRect(), viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
    const padX = Math.max(MARGIN, (MIN_WIDTH - rect.width) / 2), padY = Math.max(MARGIN, (MIN_HEIGHT - rect.height) / 2)
    const want = intersect({ left: rect.left - padX, top: rect.top - padY, right: rect.right + padX, bottom: rect.bottom + padY }, viewport)
    let host: Element = target
    for (let node = target.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      const r = node.getBoundingClientRect()
      if (r.height > innerHeight * 2.5 || r.width > innerWidth * 1.5) break
      host = node
      if (r.left <= want.left && r.top <= want.top && r.right >= want.right && r.bottom >= want.bottom) break
    }
    const hostRect = host.getBoundingClientRect(), crop = intersect(want, hostRect)
    const width = crop.right - crop.left, height = crop.bottom - crop.top
    if (width < 1 || height < 1) return null
    const scale = Math.min(devicePixelRatio || 1, 2)
    const background = getComputedStyle(document.body).backgroundColor
    const canvas = await domToCanvas(host, { scale, backgroundColor: background, timeout: 4000, features: { restoreScrollPosition: true },
      filter: node => !(node instanceof Element && node.matches(OWN)), onCloneEachNode: maskClone })
    const ratio = canvas.width / Math.max(1, hostRect.width)
    const out = document.createElement('canvas')
    out.width = Math.round(width * ratio); out.height = Math.round(height * ratio)
    const context = out.getContext('2d')
    if (!context) return null
    context.drawImage(canvas, (crop.left - hostRect.left) * ratio, (crop.top - hostRect.top) * ratio, width * ratio, height * ratio, 0, 0, out.width, out.height)
    // The element, outlined just outside its box.
    context.strokeStyle = '#E5484D'; context.lineWidth = 2 * ratio
    context.strokeRect((rect.left - crop.left - 2) * ratio, (rect.top - crop.top - 2) * ratio, (rect.width + 4) * ratio, (rect.height + 4) * ratio)
    const encode = (type: string, quality?: number) => new Promise<Blob | null>(resolve => out.toBlob(resolve, type, quality))
    let blob = await encode('image/webp', 0.9)
    if (!blob || blob.type !== 'image/webp' || blob.size > MAX_BYTES) blob = await encode('image/webp', 0.7)
    if (!blob || blob.size > MAX_BYTES) blob = await encode('image/jpeg', 0.8)
    return blob && blob.size <= MAX_BYTES && ['image/webp', 'image/png', 'image/jpeg'].includes(blob.type) ? { blob, width: out.width, height: out.height } : null
  } catch {
    return null
  }
}
