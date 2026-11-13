import type { SupportPlatform } from './bane.js';
import type { SupportConversation } from './conversation.js';
import type { SupportIntake } from './intake.js';

/** The support Worker's bindings (wrangler.dev.jsonc / wrangler.prod.jsonc). */
export interface Env {
  CONVERSATION: DurableObjectNamespace<SupportConversation>;
  /** abuse@, privacy@, legal@: one object per thread, tickets only, no agent (intake.ts). */
  INTAKE: DurableObjectNamespace<SupportIntake>;
  DB: D1Database;
  /** Bane's SupportPlatform entrypoint (RPC). */
  BANE: Service & SupportPlatform;
  /** Bane's default entrypoint: its public API, called with the support address's API key (limited to that address). */
  BANE_API: Fetcher;
  /** Per-person conversation starts and per-sender inbound mail (Workers rate limiting). */
  CHAT_START?: RateLimit;
  EMAIL_IN?: RateLimit;
  /** One key across all inbound mail, at a higher rate (the Worker answers 503 so Bane retries later). */
  EMAIL_IN_GLOBAL?: RateLimit;
  /** Screenshots: the stage's private uploads bucket (bane-support[-dev]-uploads, 90-day lifecycle). */
  UPLOADS: R2Bucket;
  /** Optional: downscales large screenshots before the model sees them (Cloudflare Images binding). */
  IMAGES?: ImagesBinding;
  /** Tests only: where model requests go instead of the network (a fake gateway). Never set in a deployed config. */
  MODEL_FAKE?: Fetcher;

  STAGE: 'dev' | 'production';
  /** https://support.bane.mx: links in emails (confirm, continue in Bane). */
  PUBLIC_URL: string;
  /** The dashboard origin allowed to start chats and open sockets (https://bane.mx). Comma-separated for dev. */
  DASHBOARD_ORIGINS: string;
  /** Bane's own origin, for API paths over BANE_API and dashboard links (https://bane.mx). */
  BANE_ORIGIN: string;
  /** support@bane.mx and its inbound address ID in the platform workspace. */
  SUPPORT_ADDRESS: string;
  SUPPORT_ADDRESS_ID: string;
  /** The intake addresses, e.g. "abuse@bane.mx,privacy@bane.mx,legal@bane.mx" (local part = the mailbox). */
  INTAKE_ADDRESSES: string;
  /** Where tickets are emailed. */
  TICKET_TO: string;
  /** Console's inference gateway, Anthropic Messages API base (https://opencode.ai/inference/anthropic/v1). The model is pinned in code (agent/opencode.ts). */
  GATEWAY_URL: string;

  // Secrets (wrangler secret put). The Worker fails closed with a clear error when one is missing.
  CONSOLE_GATEWAY_KEY?: string;
  SUPPORT_ROOT_SECRET?: string;
  BANE_INBOUND_WEBHOOK_SECRET?: string;
  BANE_SUPPORT_INBOX_KEY?: string;
  /** The intake addresses' webhook secret and API key (read and send on those three addresses only). */
  BANE_INTAKE_WEBHOOK_SECRET?: string;
  BANE_INTAKE_INBOX_KEY?: string;
}
