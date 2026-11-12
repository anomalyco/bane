import type { JobHandler, Runtime } from '../core.js';

// Package B owns this file: the billing.recharge job and the minute sweep (recharge sweep + reconciliation).
export const rechargeJob: JobHandler = async () => {};
export async function billingMinute(_runtime: Runtime): Promise<void> {}
