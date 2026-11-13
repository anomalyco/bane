import type { JobHandler } from '../core.js';
import { restoreJob } from './restore.js';
import { rechargeJob } from './stripe-jobs.js';
import { notifyJob } from './notify.js';

/** Job handlers for billing.* (dispatch.ts). */
export const billingJobs: Record<string, JobHandler> = { 'billing.restored': restoreJob, 'billing.recharge': rechargeJob, 'billing.notify': notifyJob };
