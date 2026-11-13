import { sql, type SQL } from 'drizzle-orm';
import { ApiError, log, type Config } from '../core.js';
import { formatUsd, microCents } from './money.js';
import type { BillingGate } from './types.js';

/** True when this workspace is metered and may be gated: Hosted installations only, never the platform's own workspace. */
export const billed = (config: Pick<Config, 'multiTenant' | 'platformDomainWorkspace'>, workspaceId: string) =>
  config.multiTenant && workspaceId !== config.platformDomainWorkspace;

/**
 * A column for a statement that already runs (pendingCounts, the campaign release buffer): billing_gate()'s decision
 * for `recipients` more emails, or NULL when the installation isn't multi-tenant or the workspace is the platform's.
 * Callers hold the workspace admission lock, so concurrent sends never overspend each other.
 */
export function billingGate(config: Pick<Config, 'multiTenant' | 'platformDomainWorkspace'>, workspaceId: string, recipients: number, sim: boolean): SQL {
  return billed(config, workspaceId) ? sql`billing_gate(${workspaceId}::text, ${recipients}::int, ${sim}::boolean)` : sql`NULL::jsonb`;
}

export const balanceExhausted = (config: Pick<Config, 'publicUrl'>, b: Pick<BillingGate, 'requiredUc' | 'availableUc'>) => new ApiError(402, 'BALANCE_EXHAUSTED',
  `Sending is paused: this workspace's Bane balance is empty. Add credit at ${config.publicUrl}/settings#billing. Required ${formatUsd(microCents(b.requiredUc))}, available ${formatUsd(microCents(b.availableUc))}.`, undefined, true);

/**
 * Acts on a gate decision. Applies only to Hosted sending (`hosted` not null: BYO is free). Enforced and not ok:
 * 402 BALANCE_EXHAUSTED. Not ok but not enforced (shadow, or off): logs BILLING_SHADOW_DENY and allows.
 */
export function assertBilling(b: BillingGate | null | undefined, hosted: unknown, context: { workspaceId: string; config: Pick<Config, 'publicUrl'> }): void {
  if (!b || hosted === null || hosted === undefined || b.ok) return;
  if (b.enforced) throw balanceExhausted(context.config, b);
  if (b.mode === 'prepaid' && b.enforcement === 'shadow') log('info', { code: 'BILLING_SHADOW_DENY', workspaceId: context.workspaceId, requiredUc: b.requiredUc, availableUc: b.availableUc });
}
