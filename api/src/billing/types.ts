// Shared billing shapes. BillingPosition mirrors billing_position() (migration 293); BillingGate adds billing_gate()'s
// decision. BillingSummary, LedgerEntry, PaymentView and AutoRechargeSettings mirror the public API (routes.ts).
// Money fields are integer micro-cents as strings (see money.ts).
export type Enforcement = 'off' | 'shadow' | 'enforce';
export type AccountMode = 'prepaid' | 'invoiced' | 'exempt';
export type BillingMeter = 'send' | 'receive' | 'omen' | 'storage' | 'byo_send' | 'byo_receive';
export type LedgerKind = 'topup' | 'usage' | 'grant' | 'refund_hold' | 'refund_release' | 'dispute' | 'dispute_reversal' | 'write_off' | 'adjustment' | 'expire';
export type NoticeKind = 'low_balance' | 'sends_paused' | 'receive_hold_soon' | 'receive_held' | 'recharge_failed' | 'credit_expiring';

export interface BillingPosition {
  mode: AccountMode;
  enforcement: Enforcement;
  balanceUc: string;
  promoUc: string;
  /** Unsettled usage cost after the free tier. */
  openUc: string;
  /** balance + promo − open. */
  availableUc: string;
  freeEmailsLeft: number;
  unpaidSince: string | null;
  receiveHeld: boolean;
  /** Whether Omens may run (false only when enforced, prepaid and nothing is available). */
  omens: boolean;
  canRecharge: boolean;
  thresholdUc: string;
}
export type BillingGate = BillingPosition & { ok: boolean; enforced: boolean; requiredUc: string };

export type SendingState = 'ok' | 'low' | 'paused';
export type ReceivingState = 'ok' | 'grace' | 'held';
export type AutoRechargeState = 'off' | 'on' | 'pending' | 'failed' | 'capped';
export interface AutoRechargeSettings { enabled: boolean; thresholdCents: number; amountCents: number; monthlyCapCents: number }

export interface BillingSummary {
  enforcement: Enforcement;
  mode: AccountMode;
  state: { sending: SendingState; receiving: ReceivingState; autoRecharge: AutoRechargeState };
  balance: { paid: string; promo: string; unsettled: string; available: string } | null;
  free: { month: string; emails: { limit: number; used: number; left: number }; storage: { limitBytes: number; agedBytes: string } };
  monthToDate: { cost: string } | null;
  grace: { unpaidSince: string | null; receiveHoldAt: string | null; writeOffAt: string | null };
  autoRecharge: (AutoRechargeSettings & { monthTotalCents: number; disabledReason: string | null; pending: boolean }) | null;
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  prices: { emailPerThousand: string; omenPerThousand: string; storagePerGbMonth: string; freeEmails: number; freeStorageBytes: number; topUpMinCents: number; currency: 'USD' };
  topUpUrl: string;
}

export interface LedgerEntry {
  id: string; at: string; kind: LedgerKind;
  /** paid + promo */
  amount: string; paid: string; promo: string; balanceAfter: string;
  description: string; detail: Record<string, unknown>;
  paymentId: string | null; invoiceUrl: string | null;
}

export type PaymentKind = 'checkout' | 'saved_card' | 'recharge' | 'setup';
export type PaymentStatus = 'created' | 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled' | 'expired';
export interface PaymentView {
  id: string; at: string; kind: PaymentKind; status: PaymentStatus;
  amountCents: number; taxCents: number | null; totalCents: number | null;
  card: { brand: string; last4: string } | null;
  invoiceUrl: string | null; invoicePdf: string | null; receiptUrl: string | null;
  failure: { code: string; message: string } | null;
}
