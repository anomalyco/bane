import { chunk } from '../../lib/preloadable'

// The composer (the email editor) is the largest chunk. Campaign and template editors share it, App.tsx starts it at
// boot on an editor route, and hovering a campaign or template row warms it.
export const composer = chunk(() => import('./EmailComposer'))
export const EmailComposer = composer.page(module => module.EmailComposer)
