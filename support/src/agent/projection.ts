// Customer-safe projection (design §4.1): every support-route response passes through here before the model sees it.
// The model's context is, in effect, shown to the customer, so it gets only what the customer may see: no grant or
// operator internals, third-party text fenced as untrusted, and a bounded size.

/** Fields support routes return that are about Nightmail's side of the conversation, never the customer's data. */
const DROP = new Set(['grant', 'operatorId', 'operator', 'ticketRef', 'token', 'tokenHash', 'internal', 'ipNetwork', 'userAgent', 'actorLabel', 'retainUntil', 'watch', 'watchFlag', 'handoffId', 'via']);
/** Text written by other people (recipients, mail servers, the customer's own content): data, never instructions. */
const UNTRUSTED = new Set(['subject', 'diagnostic', 'diagnosticCode', 'text', 'html', 'snippet', 'lastError', 'pauseReason', 'reason', 'message', 'name', 'previewText', 'replyText', 'body']);
export const RESULT_LIMIT = 8192;

export function project(value: unknown, depth = 0, key = ''): unknown {
  if (depth > 8) return '[…]';
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map(v => project(v, depth + 1, key));
    return value.length > 50 ? [...items, `[${value.length - 50} more not shown]`] : items;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!DROP.has(k)) out[k] = project(v, depth + 1, k);
    return out;
  }
  if (typeof value === 'string') {
    const capped = value.length > 2000 ? `${value.slice(0, 2000)}… [${value.length - 2000} more characters]` : value;
    return UNTRUSTED.has(key) && capped.length > 0 && /[A-Za-z]{3}/.test(capped) ? `<untrusted>${capped.replaceAll('</untrusted>', '')}</untrusted>` : capped;
  }
  return value;
}

/** The tool result as the model reads it: projected JSON, at most RESULT_LIMIT bytes. */
export function toolResult(value: unknown): string {
  const text = JSON.stringify(project(value));
  if (text.length <= RESULT_LIMIT) return text;
  return `${text.slice(0, RESULT_LIMIT - 120)}… [truncated: ask for a narrower window, one workspace or the next page]`;
}
