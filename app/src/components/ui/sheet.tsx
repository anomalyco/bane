import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'

// Swipe a bottom sheet down to close it: past a quarter of its height, or a quick flick at any distance. Dragging up
// past the top meets friction instead of a wall. Starts on the sheet's grab area, or anywhere on it while its content
// is scrolled to the top; links, buttons and fields keep their own touches.
export function useSheetDrag(close: () => void, enabled = true) {
  const drag = useRef<{ id: number; y: number; at: number; dy: number; el: HTMLElement } | null>(null)
  if (!enabled) return {}
  const interactive = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('input, textarea, select, button, a, [role="option"], [role="menuitem"], [contenteditable="true"], .ui-sheet__scroll-x'))
  const scrolledDown = (target: EventTarget | null, sheet: HTMLElement) => {
    for (let node = target instanceof Element ? target : null; node && node !== sheet; node = node.parentElement) if (node.scrollTop > 0) return true
    return false
  }
  return {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (drag.current || event.pointerType === 'mouse' && event.button !== 0) return
      const sheet = event.currentTarget, grab = (event.target as Element).closest?.('.ui-sheet__grab')
      if (!grab && (interactive(event.target) || scrolledDown(event.target, sheet))) return
      drag.current = { id: event.pointerId, y: event.clientY, at: performance.now(), dy: 0, el: sheet }
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const state = drag.current
      if (!state || state.id !== event.pointerId) return
      const raw = event.clientY - state.y
      if (!state.dy && Math.abs(raw) < 4) return
      if (!state.dy) { try { state.el.setPointerCapture(event.pointerId) } catch { /* Released already. */ } }
      state.dy = raw > 0 ? raw : -Math.sqrt(-raw) * 2
      state.el.style.transition = 'none'
      state.el.style.transform = `translateY(${state.dy}px)`
    },
    onPointerUp(event: ReactPointerEvent<HTMLElement>) { finish(event, false) },
    onPointerCancel(event: ReactPointerEvent<HTMLElement>) { finish(event, true) },
  }
  function finish(event: ReactPointerEvent<HTMLElement>, cancelled: boolean) {
    const state = drag.current
    if (!state || state.id !== event.pointerId) return
    drag.current = null
    const velocity = state.dy / Math.max(1, performance.now() - state.at)
    state.el.style.transition = ''
    if (!cancelled && state.dy > 0 && (state.dy > state.el.offsetHeight / 4 || velocity > 0.11)) { close(); return }
    state.el.style.transform = ''
  }
}

// Keeps a CSS variable at the on-screen keyboard's height, so a sheet anchored to the bottom rises above it.
export function useKeyboardInset() {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const root = document.documentElement
    const update = () => { const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop); root.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`) }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => { viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update); root.style.removeProperty('--keyboard-inset') }
  }, [])
}

/** A bottom sheet on Radix Dialog: focus trapped, Esc and a swipe down close it, focus returns to the opener. A sheet
 *  opened by a plain button (no Radix trigger) names it in `returnFocus`: a tap doesn't always focus the button first. */
export function Sheet({ open, onOpenChange, title, description, children, className, hideTitle = false, returnFocus }: { open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode; className?: string; hideTitle?: boolean; returnFocus?: RefObject<HTMLElement | null> }) {
  const handlers = useSheetDrag(() => onOpenChange(false))
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}><DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="ui-dialog-overlay ui-sheet-overlay" />
    <DialogPrimitive.Content data-component="Sheet" className={['ui-sheet', className].filter(Boolean).join(' ')} aria-describedby={undefined} onCloseAutoFocus={event => { const opener = returnFocus?.current; if (opener?.isConnected) { event.preventDefault(); opener.focus(); } }} {...handlers}>
      <SheetOpenEffects />
      <div className="ui-sheet__grab" aria-hidden="true"><span /></div>
      <DialogPrimitive.Title className={hideTitle ? 'sr-only' : 'ui-sheet__title'}>{title}</DialogPrimitive.Title>
      {description && <DialogPrimitive.Description className="ui-sheet__description">{description}</DialogPrimitive.Description>}
      <div className="ui-sheet__body">{children}</div>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal></DialogPrimitive.Root>
}
export function SheetOpenEffects() { useKeyboardInset(); return null }
export const SheetClose = DialogPrimitive.Close
