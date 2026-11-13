import { Agentation } from 'agentation'

export default function DevAnnotations() {
  return <>
    {/* Lifted above the support chat's Help button, which owns the page's bottom-right corner. */}
    <style>{`[data-agentation-root], [data-agentation-root] * { font-family: var(--font-body) !important; } .bane-dev-annotations { bottom: calc(var(--launcher-inset) + var(--launcher-size) + var(--space-12)) !important; }`}</style>
    <Agentation endpoint="http://127.0.0.1:4747" className="bane-dev-annotations" />
  </>
}
