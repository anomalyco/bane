import { ApiError } from './core.js';
import type { EndpointType } from './ritual-schema.js';

/** A ritual action that should run again later. Every endpoint type schedules retries through this one class. */
export class ActionRetry extends ApiError {
  constructor(code: string, readonly afterMs: number = 0) {
    super(503, code, 'Ritual delivery will be retried.', undefined, true);
  }
}
/** Exponential backoff from 15 s to 12 h with ±25% jitter, never sooner than the endpoint's Retry-After. */
export function actionDelay(attempt: number, afterMs: number, random = Math.random) {
  const base = Math.min(12 * 3600000, 15000 * 4 ** Math.max(0, attempt - 1));
  return Math.max(afterMs, Math.round(base * (0.75 + 0.5 * random())));
}
/** Retry-After as delta seconds (integer or decimal, as Discord sends) or an HTTP date; capped at 7 days. */
export function retryAfterMs(value?: string | null, now = Date.now()) {
  if (!value) return 0;
  const trimmed = value.trim();
  const ms = /^\d+(?:\.\d+)?$/.test(trimmed) ? Math.ceil(Number(trimmed) * 1000) : /[a-z]/i.test(trimmed) ? Date.parse(trimmed) - now : NaN;
  return Number.isFinite(ms) ? Math.max(0, Math.min(ms, 7 * 86400000)) : 0;
}

export type EndpointPolicy = { perMinute: number; retryOnTimeout: boolean; idempotent: boolean };
/**
 * Defaults per endpoint type, overridden per endpoint with updateEndpoint. Chat posts are not
 * idempotent, so an ambiguous timeout is not retried unless asked. A forward is deduplicated by
 * message and endpoint inside the send transaction, so retrying it is always safe.
 */
export const DEFAULT_POLICY: Record<EndpointType, EndpointPolicy> = {
  slack: { perMinute: 60, retryOnTimeout: false, idempotent: false },
  discord: { perMinute: 30, retryOnTimeout: false, idempotent: false },
  webhook: { perMinute: 60, retryOnTimeout: false, idempotent: false },
  forward: { perMinute: 60, retryOnTimeout: true, idempotent: true },
};
export function endpointPolicy(type: EndpointType, row?: { per_minute?: number | null; retry_on_timeout?: boolean | null; idempotent?: boolean | null } | null): EndpointPolicy {
  const base = DEFAULT_POLICY[type];
  return {
    perMinute: row?.per_minute ?? base.perMinute,
    retryOnTimeout: type === 'forward' || (row?.retry_on_timeout ?? base.retryOnTimeout),
    idempotent: type === 'forward' || (row?.idempotent ?? base.idempotent),
  };
}
/** Whether an attempt whose outcome is unknown (timeout, dropped connection, lost worker) may be sent again. */
export const replaySafe = (policy: EndpointPolicy) => policy.idempotent || policy.retryOnTimeout;
