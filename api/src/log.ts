// Nightmail's structured logging, with no dependencies so the support Worker (support/) bundles the same fields, sampling and
// redaction. core.ts re-exports it and adds logError, which knows ApiError and SQLSTATEs.
// Structured logs: one JSON object per line. The Worker's lines go to Workers Logs, the Node API and runner's to
// stdout (CloudWatch on Fargate); the mail gateway writes the same fields. Every request writes one `event: 'request'`
// line (app.ts) and every unexpected failure one `logError` line with its stack. docs/ci.md describes the fields and the
// nightly report that reads them.
const logContext: { service?: string; deploy?: string; sample?: boolean } = {};
/**
 * Which process is logging and the commit it runs, stamped on every line. `sample: false` keeps every success line, for a
 * low-volume service (the support Worker) where each request matters more than the volume.
 */
export function setLogContext(context: { service: string; deploy?: unknown; sample?: boolean }) {
  logContext.service = context.service;
  logContext.deploy = typeof context.deploy === 'string' && /^[0-9a-f]{7,40}$/.test(context.deploy) ? context.deploy.slice(0, 12) : undefined;
  logContext.sample = context.sample;
}
const ROUTINE_CODES = new Set(['JOB_COMPLETED', 'QUEUE_WAKE', 'QUEUE_WAKE_COALESCED', 'JOB_DEFERRED']);
// Sample routine successes at the source, NOT whole invocations: a sampled-out request still logs every failure, and
// a kept line carries its `sampleRate` so counts are estimated as 1/sampleRate lines each.
function sampleRate(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>) {
  if (level !== 'info' || logContext.sample === false) return 1;
  if (typeof fields.code === 'string' && ROUTINE_CODES.has(fields.code)) return 0.01;
  return typeof fields.status === 'number' && fields.status < 400 ? 0.1 : 1;
}
// Defense in depth: callers log operations, IDs and codes, never bodies, headers, addresses or tokens. A string that
// slips through anyway loses addresses and long credential-like runs: secrets are a prefix and 64 hex digits, while
// IDs carry 32 and error codes are upper case (some are 40 characters long).
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const CREDENTIAL = /[A-Za-z0-9_]{40,}/g;
const credentialLike = (run: string) => /[a-z]/.test(run) && /[0-9]/.test(run) ? '[redacted]' : run;
// Only strings, numbers, booleans, plain objects and arrays are written, and every object or array in a line is one
// scrub built itself: no method of the input is called (not slice, map or entries, which an array or proxy can
// override) and no getter runs. An array is read by index up to 50 elements, an object by its own enumerable data
// properties up to 50 keys, each read inside try. Anything else (an error, a class instance, an accessor, a proxy that
// throws, anything nested deeper than three levels) becomes '[object]', so no toString or toJSON is ever reached.
const SCRUB_ITEMS = 50;
function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.replace(EMAIL, '[email]').replace(CREDENTIAL, credentialLike).slice(0, 2000);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value;
  if (typeof value !== 'object') return typeof value === 'bigint' ? String(value) : undefined; // Functions and symbols.
  try {
    if (depth > 2) return '[object]';
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return '[object]';
      const length: unknown = Reflect.get(value, 'length');
      const items: unknown[] = [];
      for (let index = 0; index < (typeof length === 'number' && length > 0 ? Math.min(Math.floor(length), SCRUB_ITEMS) : 0); index++) {
        let item: unknown;
        try { const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index)); item = descriptor && 'value' in descriptor ? scrub(descriptor.value, depth + 1) : descriptor ? '[object]' : undefined; }
        catch { item = '[object]'; }
        items[index] = item === undefined ? null : item;
      }
      return items;
    }
    if (prototype !== Object.prototype && prototype !== null) return '[object]';
    const entries: Record<string, unknown> = Object.create(null);
    let kept = 0;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') continue;
      if (kept++ >= SCRUB_ITEMS) break;
      try {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (descriptor?.enumerable) entries[key] = 'value' in descriptor ? scrub(descriptor.value, depth + 1) : '[object]';
      } catch { entries[key] = '[object]'; }
    }
    return entries;
  } catch { return '[object]'; } // A proxy that throws from getPrototypeOf, ownKeys or a revoked proxy.
}
/** What `log` writes when a line cannot be built: logging never throws into a request. */
const LOG_FALLBACK = '{"level":"error","code":"LOG_SERIALIZE_FAILED"}';
export function logFallback() { try { console.error(LOG_FALLBACK); } catch { /* Nothing left to write with. */ } }
export function log(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>) {
  let line: string, write: 'info' | 'warn' | 'error' = 'error';
  try {
    write = level === 'info' || level === 'warn' ? level : 'error';
    const rate = sampleRate(write, fields);
    if (rate < 1 && Math.random() >= rate) return;
    const clean = scrub(fields);
    if (clean === null || typeof clean !== 'object' || Array.isArray(clean)) throw new TypeError('fields are not a plain object');
    line = JSON.stringify({ level: write, timestamp: new Date().toISOString(), service: logContext.service, deploy: logContext.deploy, ...clean, ...(rate < 1 ? { sampleRate: rate } : {}) });
  } catch { return logFallback(); }
  try { console[write](line); } catch { logFallback(); }
}
// A V8 stack is a header and then "    at <function> (<location>)" frames. The header is the error's name and message
// (`${name}: ${message}`, or whichever is not empty), and either can span lines that look exactly like frames: a
// database error quotes its SQL parameters, and a name is just a property (PR #131 review). So neither is trusted and
// no line is counted: the stack must start with that exact header text, character for character, and frames are read
// only after it (V8 formats the header from the current name and message on first access). Every line after it must be
// a frame; only frames in Nightmail's own code (the Worker bundle, or src/ or dist/ outside node_modules) are kept, rebuilt
// from the function name and file:line:column. Anything else fails closed: no frames. The one case this cannot see is
// code that shortens a message after something already read the stack; no request can do that.
const FRAME = /^ {4}at (?:async )?(?:(?:new )?([\w$.<>[\]]{1,80}(?: \[as [\w$]{1,40}\])?) \()?(?:file:\/\/)?([^\s()]{1,300}):(\d{1,7}):(\d{1,7})\)?$/;
const OWN_CODE = /(?:^|\/)(worker\.js|(?:src|dist)\/[\w./-]{1,200}\.(?:ts|js))$/;
export function stackFrames(error: unknown, limit = 12) {
  let stack: unknown, name: unknown, message: unknown;
  try {
    if (!(error instanceof Error)) return undefined;
    stack = error.stack; name = error.name; message = error.message;
  } catch { return undefined; } // A throwing getter or proxy trap, or a revoked proxy.
  // Each read once; anything but a string (an object with its own toString) fails closed.
  if (name === undefined) name = 'Error';
  if (message === undefined) message = '';
  if (typeof stack !== 'string' || typeof name !== 'string' || typeof message !== 'string') return undefined;
  const header = !name ? message : !message ? name : `${name}: ${message}`;
  if (!stack.startsWith(`${header}\n`)) return undefined;
  const frames: string[] = [];
  for (const line of stack.slice(header.length + 1).split('\n')) {
    if (!/^ {4}at /.test(line)) return undefined; // Not a stack after all.
    const match = FRAME.exec(line);
    if (!match) continue; // A native, eval or anonymous-location frame.
    const [, fn, location, row, column] = match;
    const file = location!.includes('node_modules') ? undefined : OWN_CODE.exec(location!)?.[1];
    if (file && frames.length < limit) frames.push(`${fn ?? '<anonymous>'} (${file}:${row}:${column})`);
  }
  return frames.join('\n') || undefined;
}
/**
 * An error's class name (`TypeError`, `DrizzleQueryError`) as a string, or `Error`. `name` is read once and used only
 * when it is a string that looks like a class name: an object with its own toString would be serialized whole.
 */
const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export function errorTypeOf(error: unknown): string {
  try {
    if (!(error instanceof Error)) return error === null ? 'null' : typeof error;
    const name: unknown = error.name;
    return typeof name === 'string' && CLASS_NAME.test(name) ? name : 'Error';
  } catch { return 'Error'; }
}
/** An error code for a log line: an upper-case code string (`INTERNAL_ERROR`, `MCP_HTTP_405`), or `UNKNOWN_ERROR`. */
export const errorCodeOf = (value: unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'UNKNOWN_ERROR';
