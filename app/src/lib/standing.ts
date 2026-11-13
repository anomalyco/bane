import type { StandingStep } from '../data/types'
import { productName } from '../../../api/src/brand'

// The sending standing's customer copy, shared by the page banner (restrict, pause) and Overview's standing card
// (warn and above). Every message has three parts: what happened (the API's reason), what Nightmail did (below) and how
// to fix it (the checklist on Overview).
const order: StandingStep[] = ['ok', 'notice', 'warn', 'restrict', 'pause']
export const stepAtLeast = (step: StandingStep | null | undefined, floor: StandingStep) => Boolean(step) && order.indexOf(step!) >= order.indexOf(floor)
export type RaisedStep = 'warn' | 'restrict' | 'pause'
export const standingTitle: Record<RaisedStep, string> = { warn: 'Your limit is frozen', restrict: 'Marketing is held', pause: 'Sending is paused' }
export const standingDid: Record<RaisedStep, string> = {
  warn: 'Your daily limit won’t rise until this clears. All mail still sends.',
  restrict: 'Marketing is held; receipts and resets still send.',
  pause: 'All sending is paused. Receiving, inboxes and the dashboard keep working. Queued mail is held for 72 hours, then canceled.',
}
// When a step has no measured reason (an operator's hold, an AWS tenant pause).
export const standingFallback: Record<RaisedStep, string> = { warn: 'Sending crossed a warning line.', restrict: `${productName} held marketing after a review.`, pause: `${productName} paused sending.` }
export const standingTone = (step: RaisedStep) => step === 'pause' ? 'danger' as const : 'warning' as const
export const releaseLabel = { release_marketing: 'Release marketing', resume_sending: 'Resume sending' } as const
