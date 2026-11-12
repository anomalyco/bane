import { ApiError, type Database, type Runtime } from '../core.js';
import type { AutoRechargeSettings, PaymentView } from './types.js';

// Package B (Stripe) owns this file: a thin fetch client, top-ups, card setup, auto-recharge settings, refunds and
// payment reads. The contract commit only fixes the signatures; every body below is replaced by B.
const notConfigured = () => new ApiError(503, 'BILLING_NOT_CONFIGURED', 'Payments are not configured on this installation.');

export async function createCheckoutTopUp(_runtime: Runtime, _input: { workspaceId: string; amountCents: number; actor: string; billingEmail: string | null }): Promise<{ attemptId: string; url: string; expiresAt: string }> { throw notConfigured(); }
export async function chargeSavedCardTopUp(_runtime: Runtime, _input: { workspaceId: string; amountCents: number; actor: string }): Promise<{ attemptId: string; status: PaymentView['status'] }> { throw notConfigured(); }
export async function createCardSetup(_runtime: Runtime, _input: { workspaceId: string; actor: string; billingEmail: string | null }): Promise<{ url: string; expiresAt: string }> { throw notConfigured(); }
export async function removePaymentMethod(_runtime: Runtime, _workspaceId: string): Promise<void> { throw notConfigured(); }
export async function setAutoRecharge(_runtime: Runtime, _workspaceId: string, _settings: AutoRechargeSettings): Promise<void> { throw notConfigured(); }
export async function refundTopUp(_runtime: Runtime, _input: { workspaceId: string; attemptId: string; amountCents?: number; reason: string; operator: string }): Promise<{ refundId: string; status: string }> { throw notConfigured(); }
export async function getPayment(_db: Database, _workspaceId: string, _id: string): Promise<PaymentView | null> { return null; }
export async function listPayments(_db: Database, _workspaceId: string, _cursor?: string | null, _limit = 50): Promise<{ data: PaymentView[]; nextCursor: string | null }> { return { data: [], nextCursor: null }; }
