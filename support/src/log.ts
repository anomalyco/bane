import { errorCodeOf, errorTypeOf, log, setLogContext, stackFrames } from '../../api/src/log.js';
import { BaneError } from './bane.js';
import { MissingSecret } from './tokens.js';

// Nightmail's structured logs (api/src/log.ts, PR #131): one JSON line per event in Workers Logs, with the same fields,
// sampling and redaction (addresses and credential-like runs scrubbed, only plain data written). Callers log route
// templates, opaque IDs, codes and counts: never a raw path or query (tokens), an address, a subject or message text.
// Support's volume is low, so every success line is kept rather than sampled.
setLogContext({ service: 'bane-support', sample: false });
export { log };

/**
 * One line for a failure: its code, error class, Nightmail's status, code and request ID for a Nightmail API error, the missing
 * secret's name, and the Worker's own stack frames. Never the error's message, which can quote mail or chat text.
 */
export function logError(error: unknown, fields: Record<string, unknown> & { code: string; message?: never }, level: 'error' | 'warn' = 'error') {
  let entry: Record<string, unknown>;
  try {
    const bane = error instanceof BaneError ? { baneStatus: error.status, baneCode: errorCodeOf(error.code), baneRequestId: error.requestId ?? undefined } : {};
    const secret = error instanceof MissingSecret ? { secret: error.secret } : {};
    entry = { ...fields, code: errorCodeOf(fields.code), errorType: errorTypeOf(error), ...bane, ...secret, stack: stackFrames(error) };
  } catch { entry = { code: errorCodeOf(fields.code), errorType: 'Error' }; }
  log(level, entry);
}
