// The width a run of text takes in an element's font, without putting the text in the page. A masked address
// (components/PrivateAddress.tsx) reserves the width of its hidden part this way.
//
// Each character's advance is read once per font from a hidden ruler that holds the printable ASCII alphabet, never
// the text being measured, and the advances are summed (lib/private-address.ts textWidth). The sum is the text's own
// width where kerning and ligatures are off, which the address's box turns off. A character outside the alphabet is
// measured on a canvas, which is close rather than exact. When a ruler's font changes (a web font arrives, the zoom
// changes) its advances are read again and everyone who reserved a width is told in the same frame.
import { textWidth } from './private-address'

const ALPHABET = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i))
// Everything that decides an advance. A ruler copies these from the element it measures for.
const FONT = ['font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant-caps', 'font-variant-numeric', 'font-variant-ligatures', 'font-variant-east-asian',
  'font-feature-settings', 'font-variation-settings', 'font-kerning', 'font-optical-sizing', 'font-size-adjust', 'letter-spacing', 'word-spacing', 'text-rendering', 'text-transform'] as const

type Ruler = { advances: Map<string, number>; other: (character: string) => number }
const rulers = new Map<string, Ruler>()
const listeners = new Set<() => void>()
let canvas: CanvasRenderingContext2D | null | undefined

function ruler(element: Element): Ruler {
  const style = getComputedStyle(element), font = FONT.map(property => style.getPropertyValue(property))
  const key = font.join('|')
  const known = rulers.get(key)
  if (known) return known
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;white-space:pre;inline-size:max-content;block-size:0;overflow:hidden;contain:layout style'
  FONT.forEach((property, i) => host.style.setProperty(property, font[i]!))
  const cells = ALPHABET.map(character => { const cell = document.createElement('span'); cell.style.display = 'inline-block'; cell.textContent = character; return host.appendChild(cell) })
  document.body.appendChild(host)
  const advances = new Map<string, number>()
  const read = () => { advances.clear(); cells.forEach((cell, i) => advances.set(ALPHABET[i]!, cell.getBoundingClientRect().width)) }
  read()
  const spacing = Number.parseFloat(style.letterSpacing) || 0, shorthand = `${font[3]} ${font[2]} ${font[1]} ${font[0]}`
  const made: Ruler = { advances, other(character) {
    canvas ??= document.createElement('canvas').getContext('2d')
    if (!canvas) return advances.get('m')!
    canvas.font = shorthand
    return canvas.measureText(character).width + spacing
  } }
  rulers.set(key, made)
  // The ruler is as wide as its alphabet: it resizes exactly when an advance changes.
  let width = host.getBoundingClientRect().width
  new ResizeObserver(() => {
    const next = host.getBoundingClientRect().width
    if (next === width) return
    width = next; read()
    for (const listener of listeners) listener()
  }).observe(host)
  return made
}

/** The width of `text` in `element`'s font. */
export function measuredWidth(element: Element, text: string) {
  const { advances, other } = ruler(element)
  return textWidth(text, character => { let advance = advances.get(character); if (advance === undefined) advances.set(character, advance = other(character)); return advance })
}
/** Calls back when widths measured before may have changed. */
export function onRulerChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
