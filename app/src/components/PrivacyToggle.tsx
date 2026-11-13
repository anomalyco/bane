import { useId } from 'react'
import { togglePrivacy, usePrivacy } from '../lib/privacy'

/** Privacy mode (lib/privacy.ts), in the sidebar footer and the phone's More sheet. ⇧P toggles it too (AppShell). */
export function PrivacyToggle() {
  const on = usePrivacy(), hint = useId()
  const state = on ? 'checked' : 'unchecked'
  return <button type="button" className="privacy-toggle" aria-pressed={on} aria-describedby={hint} title="Privacy mode (⇧P)" onClick={togglePrivacy}>
    <span className="privacy-toggle__text"><span className="privacy-toggle__label">Privacy mode</span><span id={hint} className="privacy-toggle__hint">Blur email addresses</span></span>
    <span className="ui-switch privacy-toggle__switch" data-state={state} aria-hidden="true"><span className="ui-switch__thumb" data-state={state} /></span>
  </button>
}
