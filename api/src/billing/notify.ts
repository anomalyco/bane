import type { JobHandler } from '../core.js';

// Package C owns this file: the billing.notify job (owner emails for billing_notices rows).
export const notifyJob: JobHandler = async () => {};
