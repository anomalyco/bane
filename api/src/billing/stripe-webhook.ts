import type { App } from '../core.js';

// Package B owns this file: POST /v1/billing/stripe (signature check, event dedupe, ownership filter, processing).
export function registerStripeWebhook(_app: App): void {}
