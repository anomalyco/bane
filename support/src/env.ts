import type { SupportPlatform } from './bane.js';
import type { SupportConversation } from './conversation.js';

/** The support Worker's bindings (wrangler.dev.jsonc / wrangler.prod.jsonc). */
export interface Env {
  CONVERSATION: DurableObjectNamespace<SupportConversation>;
  DB: D1Database;
  /** Bane's SupportPlatform entrypoint (RPC). */
  BANE: Service & SupportPlatform;
  /** Bane's default entrypoint: its public API, called with the support address's inbox key. */
  BANE_API: Fetcher;
  /** Per-person conversation starts and per-sender inbound mail (Workers rate limiting). */
  CHAT_START?: RateLimit;
  EMAIL_IN?: RateLimit;
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
  /** Where tickets are emailed. */
  TICKET_TO: string;
  /** Console's inference gateway, Anthropic Messages API base (https://opencode.ai/inference/anthropic/v1). The model is pinned in code (agent/opencode.ts). */
  GATEWAY_URL: string;

  // Secrets (wrangler secret put). The Worker fails closed with a clear error when one is missing.
  CONSOLE_GATEWAY_KEY?: string;
  SUPPORT_ROOT_SECRET?: string;
  BANE_INBOUND_WEBHOOK_SECRET?: string;
  BANE_SUPPORT_INBOX_KEY?: string;
}
