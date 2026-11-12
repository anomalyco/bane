import { z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SESv2Client } from '@aws-sdk/client-sesv2';
import { sql } from 'drizzle-orm';
import type { ReadyConnection } from './provider-credentials.js';

export type Database = NodePgDatabase;
export const SuppressionReason = z.string().describe('Reason recorded when this send was suppressed. For a multi-recipient send blocked locally, this is the first blocked recipient in To, Cc, Bcc order.');
export const SuppressionEventData = z.object({suppressionReason:SuppressionReason.optional()}).catchall(z.unknown());
export type DbExecutor = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;
export type Permission = 'read' | 'send' | 'manage';
export interface Actor {
  workspaceId: string; permissions: Permission[]; domains: string[]; keyId: string; credential?: 'dashboard' | 'apiKey' | 'mcp' | 'agentToken' | 'operatorService' | 'support'; email?: string; name?: string;
  role?: string; receivingConsent?:boolean; grantId?:string; tokenId?:string;
  // Number of emails queued per region, for a bounded post-commit wake.
  dispatchTargets?: Map<string, { count: number; priority: boolean }>;
  dispatchAccount?: { aws_account_id: string; kind: ReadyConnection['kind'] };
  // Orchestration jobs this request committed that must not wait for a coalesced wake (campaign launches).
  wakeJobs?: number;
  wakeJobPool?: 'webhook';
}
export interface Storage {
  // Identity for reusable immutable bytes only, never pending request-bound I/O.
  readonly cacheScope?: object;
  /**
   * `signal` cancels an S3 put; an R2 binding put cannot be cancelled once it starts (an already
   * aborted signal still stops it). No backend bounds when a put can land, so the hourly cleanup
   * reconciles storage against its records instead (maintenance.ts).
   */
  put(key: string, body: Uint8Array, contentType: string, signal?: AbortSignal): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  delete(key: string): Promise<void>;
  /** Up to 1,000 objects in key order after `after`; `cursor` continues the listing and is absent at its end. */
  list?(prefix: string, after?: string): Promise<{ objects: { key: string; uploaded: Date }[]; cursor?: string }>;
}
export interface Config {
  /** Requests per minute per credential. */
  apiRateLimitPerMinute: number;
  workspaceId: string;
  authSecret: string;
  mailGatewayToken?:string;
  previousAuthSecret?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  allowedEmails: string[];
  allowedDomains: string[];
  defaultWorkspaceOwners: '*' | string[];
  multiTenant: boolean;
  platformAccount?: string;
  /** The one Hosted workspace that may own the installation's own domain (PUBLIC_URL's host). */
  platformDomainWorkspace?: string;
  /** Hosted only: From for Bane's own owner notices (sender standing), on the platform workspace's domain. */
  notifyFrom?: string;
  /** Hosted only: the support platform's operator credential, its URL and the handoff signing key (src/support.ts). */
  support?: { platformToken?: string; previousPlatformToken?: string; url?: string; signingKey?: { kty: 'OKP'; crv: 'Ed25519'; d: string; x: string } };
  regionalSending?: boolean;
  trustedPool?: boolean;
  receivingRedrive?:boolean;
  allowSesSandbox?: boolean;
  requireDmarcForBulk?: boolean;
  hostedScreen?: boolean;
  placementShadow?: boolean;
  placementDblZone?: string;
  byoTemplateUrl?: string;
  byoV2?: boolean;
  byoV5TemplateUrl?: string;
  domainConnect?: { privateKey: import('node:crypto').KeyObject; keyId: string };
  /** Regions offered for MX shared sending; defaults to us-east-2. */
  sharedRegions?: string[];
  hostedSendCaps: { firstWeek: number; secondWeek: number; mature: number };
  publicUrl: string;
  sesFeedbackUrl?: string;
  regions: string[];
  liveEnabled: boolean;
  simulatedSes: { latencyMs: number; maxSendRate: number; deliveryDelayMs: number };
  // Pacing target relative to the provider quota: factor (1.1 aims 10% above) and an optional absolute live rate.
  dispatch: { rateFactor: number; targetRate?: number; dailyHeadroomPercent: number };
  encryptionKey: string;
  previousEncryptionKey?: string;
  awsAccountId?: string;
  snsTopicArns: string[];
  // Subset of snsTopicArns that carries SES inbound receipt notifications for mailboxes.
  inboundTopicArns?: string[];
  reputationAlertUrl?: string;
  // Opt-in Jev content screen for live transactional sends with `screen: true`; undefined without TYPESAFE_API_KEY.
  screen?: { apiKey: string; endpoint: string; model: string; mode: 'reject' | 'flag'; threshold: number };
  aws?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  configurationSets: { transactional: string; marketing: string };
}
export interface RenderedImage { data: Uint8Array; mimeType: 'image/png'; }
export interface PublicImage { data: Uint8Array; contentType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; }
export type FeedbackItem = { region: string; topicArn: string; messageId: string; message: Record<string, unknown>; topicKind?:'byo'|'shared'; mac?: string };
export interface Runtime {
  mailR2?: { bucket: R2Bucket; name: string; write: boolean };
  db: Database; storage: Storage; config: Config;
  // Workers' public egress guards connect-time DNS; Node instead pins the checked IP in TLS.
  placementEdge?: { probesPerJob:number };
  wake?: (readyJobs?: number, immediate?: 'webhook'|'ingest') => Promise<void>;
  deferNudge?: (work: (runtime: Runtime) => Promise<void>) => void;
  // Nudges the long-lived dispatcher for one account/region after queued mail commits. Dispatch
  // never depends on it: the dispatcher also polls and the scheduler pings it every minute.
  dispatch?: (region: string, accountId?: string, emails?: number, kind?: ReadyConnection['kind'], priority?: boolean) => Promise<void>;
  // Verified provider feedback (and simulated callbacks) leave the request path through this
  // sink and are ingested in batches, never through the sending jobs table.
  feedback?: { enqueue: (items: FeedbackItem[]) => Promise<void> };
  allowFeedbackTopic?: (arn:string)=>Promise<boolean>;
  allowSnsCertMiss?: (peer: string) => Promise<boolean>;
  snsCertificateState?: import('./operations.js').SnsCertificateState; // Omitted by production: share one state per isolate, not per request.
  allowMalformedSns?: (peer: string) => Promise<boolean>;
  jwksCacheScope?: object; // Workers create a new DB adapter per request; scope public keys to the binding instead.
  renderHtmlImage?: (html: string) => Promise<RenderedImage>; importPublicImage?: (url: string) => Promise<PublicImage>;
  // Outbound webhook transport. Node supplies a connect-time guard against private addresses
  // (see adapters/node.ts); Workers use plain fetch, which cannot reach them.
  webhookFetch?: WebhookFetch;
}
export type WebhookFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number;retryAfter?:string|null }>;
// mailboxIds is what the credential can see now (a provisioning key also sees the inboxes it created);
// scopeIds is an inbox key's configured scope, which never changes for that key.
export type MailboxAccess = { keyId: string; grantId?:string; workspaceId: string; admin: boolean; mailboxIds: string[] | null; scopeIds?: string[] | null; permissions: import('./db/mailbox.js').MailboxPermission[] };
/** A support grant (src/support.ts): one user, the workspaces they still belong to, read-only, for one ticket. */
export type SupportScope = { grantId: string; userId: string; ticketRef: string; operatorId: string; contentWorkspaceId: string | null; expiresAt: string;
  workspaces: { id: string; name: string; role: 'owner' | 'admin' | 'member' }[] };
export type AppEnv = { Bindings: Runtime; Variables: { actor: Actor; boundedBody?: boolean; requestId: string; serverTimings: { name: string; durationMs: number }[]; mailboxAccess?: MailboxAccess;
  /** The error code and field a failed request answered with, for its request log line. `unmatched`: no route did. */
  failure?: { code: string; field?: string; databaseCode?: string; unmatched?: boolean };
  /** Who a protocol handler authenticated (MCP authenticates inside its route), for the request log line. */
  principal?: { type: string; workspace?: string }; support?: SupportScope } };
export type App = OpenAPIHono<AppEnv>;
export type Ctx = Context<AppEnv>;
export type ClaimedWebhook = { routed?:boolean;format?:string;name?:string;include?:string[];timeout_seconds?:number;retry_attempts?:number; delivery_id: string; generation: number; event_id: string; payload: unknown; synthetic: boolean; webhook_id: string; url: string; encrypted_secret: string; encrypted_headers: string | null; owned?: boolean };
export type JobHandler = (runtime: Runtime, payload: Record<string, unknown>, job: { id: string; attempts: number; workspaceId: string;
  /** The claim's lease (lease_until as claimed): the job is still this runner's while it matches. Absent when a handler is called directly. */
  leaseFence?: string;
  ingest?:import('./mailbox-ingest-input.js').IngestInput|null;
  deleteBinding?:ReadyConnection|null; webhook?: ClaimedWebhook | null; recordWithSettlement?: (ctes: import('drizzle-orm').SQL) => void }) => Promise<void>;

export class ApiError extends Error {
  /** Structured detail for errors that have several parts, such as ritual compile diagnostics. */
  details?: Record<string, unknown>[];
  /** The field names a log line may name: the schema's own, never a key the caller sent (app.ts invalidFields). */
  logField?: string;
  constructor(public status: number, public code: string, message: string, public field?: string, public retryable = false, public resetAt?: string) { super(message); }
}
export class ModuleLoadError extends ApiError {
  constructor(cause?: unknown) {
    super(503, 'MODULE_LOAD_FAILED', 'Unable to load a required runtime module; retry shortly.', undefined, true);
    this.name = 'ModuleLoadError';
    if (cause !== undefined) this.cause = cause;
  }
}
export function wrapModuleLoad<T>(work: () => Promise<T>): Promise<T> {
  try {
    return work().catch(error => { throw error instanceof ModuleLoadError ? error : new ModuleLoadError(error); });
  } catch (error) {
    return Promise.reject(error instanceof ModuleLoadError ? error : new ModuleLoadError(error));
  }
}
export function lazyModule<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => pending ??= wrapModuleLoad(load).catch(error => { pending = undefined; throw error; });
}
export const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), requestId: z.string(), field: z.string().optional(), retryable: z.boolean(), resetAt: z.iso.datetime().optional().describe('Next capacity change for a Hosted rolling send limit.'), details: z.array(z.record(z.string(), z.unknown())).optional().describe('Every problem found, when there is more than one part, such as ritual diagnostics with ritual, line, column, message and hint.') }) }).openapi('ApiError');
export const errors = Object.fromEntries([400, 401, 403, 404, 409, 413, 422, 429, 500, 503].map(status => [status, { description: 'Request failed; use error.code and requestId to diagnose.', content: { 'application/json': { schema: ErrorSchema } } }]));
export const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { dashboardSession: [] }, { secureDashboardSession: [] }];
export const IdParams = z.object({ id: z.string().min(1).max(120) });
export const PageQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });
export const AudienceSpec = z.object({ listId: z.string().min(1).max(120), segmentId: z.string().min(1).max(120).optional(), excludeListIds: z.array(z.string().min(1).max(120)).max(20).optional(), excludeSegmentIds: z.array(z.string().min(1).max(120)).max(20).optional(),
  priority: z.object({ property: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/), values: z.array(z.string().max(200)).min(1).max(20) }).strict().optional().describe('Send order: contacts whose property equals an earlier value are reviewed and released first; everyone else follows. Useful with paced sending, e.g. { property: "plan", values: ["active", "former"] }.') }).strict();
export const json = <T extends z.ZodType>(schema: T) => ({ content: { 'application/json': { schema } }, required: true });
export const response = <T extends z.ZodType>(schema: T, description = 'Success') => ({ description, content: { 'application/json': { schema } } });
export const page = <T extends z.ZodType>(schema: T) => z.object({ data: z.array(schema), nextCursor: z.string().nullable() });
export function id(prefix: string) { return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`; }
/** A (created_at, id) page cursor, bound to its resource and filters; microseconds survive the round trip. */
export function readCursor(value: string | undefined, binding: string): { at: string; id: string } | null {
  if (!value) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    // ISO 8601 allows offsets up to ±23:59; Postgres refuses past ±15:59 (22009), so an edited cursor would be a 500.
    const tuple = z.tuple([z.string().datetime({ offset: true }).regex(/(?:Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/), z.string().min(1).max(120), z.literal(binding)]).parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return { at: tuple[0], id: tuple[1] };
  } catch { throw new ApiError(422, 'INVALID_CURSOR', 'Use the returned cursor with the same filters.', 'cursor'); }
}
export function nextCursor(rows: { id: string; createdAt: string }[], limit: number, binding: string) {
  const last = rows[limit - 1];
  return rows.length > limit && last ? Buffer.from(JSON.stringify([last.createdAt.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'), last.id, binding])).toString('base64url') : null;
}
/**
 * Where a sending upload is stored. The prefix belongs to uploads alone: every other key family starts
 * with a workspace ID or a mail class, and no workspace may be named `uploads` (migration 158).
 */
export const uploadKey = (workspaceId: string, attachmentId: string) => `uploads/${workspaceId}/${attachmentId}`;
export function actor(c: Ctx, action: Permission | 'editContent' = 'read'): Actor {
  const value = c.get('actor');
  // Dashboard roles include content editing. A scoped machine grant is still bounded by its
  // original permission contract: send alone does not delegate contact or template management.
  const permission = action === 'editContent' ? (c.env.config.multiTenant && value?.credential === 'dashboard' ? 'send' : 'manage') : action;
  if (!value || (!value.permissions.includes('manage') && !value.permissions.includes(permission))) throw new ApiError(403, 'PERMISSION_DENIED', `This operation requires ${permission} permission.`);
  return value;
}
// ---------- route guards shared by REST and the MCP listing ----------
// Each takes a concrete request path or an OpenAPI template ({id} segments). The middleware that
// enforces a guard and the MCP listing that must agree with it call the same predicate.
/** mailboxAuth: inbox keys, or a workspace credential through actorMailAccess. */
export const mailboxRoute = (path: string) => /^\/v1\/(?:inbound|inboxes)(?:\/|$)/.test(path);
const appPasswordRoute = (path: string) => /^\/v1\/inboxes\/[^/]+\/app-passwords(?:\/|$)/.test(path);
/** requireReceivingConsent: an MCP grant without explicit receiving consent is refused. */
export const receivingConsentRoute = (path: string) =>
  appPasswordRoute(path) || /^\/v1\/(?:routing|rituals|endpoints|inbound\/(?:retired|domains|addresses|keys|webhooks|overview))(?:\/|$)|^\/v1\/(?:inbox-connections|inbound\/policy|domains\/[^/]+\/receiving-host|inbound\/messages\/[^/]+\/redeliver)$/.test(path);
/** notMember: workspace members are refused these areas whatever their scopes. */
export const ownerRoute = (method: string, path: string) => {
  const verb = method.toUpperCase();
  return appPasswordRoute(path) || /^\/v1\/(?:domains|webhooks|agent-tokens)(?:\/|$)|^\/v1\/regions\/|^\/v1\/settings\/ses$/.test(path) || (path === '/v1/regions' && verb !== 'GET')
    || (verb === 'POST' && /^\/v1\/campaigns\/[^/]+\/(?:send|schedule|unschedule|reschedule|pause|resume|pacing|cancel)$/.test(path));
};
/** notMember (app.ts): whether REST refuses this actor the route because it is a workspace member. */
export const memberRefused = (actor: Pick<Actor, 'role'> | undefined, method: string, path: string) => actor?.role === 'member' && ownerRoute(method, path);
/** Hosted workspace administration: a signed-in dashboard session, and with `manage` an owner or admin. Not found when self-hosted. */
export function dashboardSession(c: Ctx, manage = false) {
  if (!c.env.config.multiTenant) return notFound('Endpoint');
  const a = c.get('actor');
  if (a.credential !== 'dashboard') throw new ApiError(403, 'DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.');
  if (manage && a.role !== 'admin' && a.role !== 'owner') throw new ApiError(403, 'PERMISSION_DENIED', 'Workspace administration requires an owner or admin.');
  return { workspaceId: a.workspaceId, userId: a.keyId.slice(5), email: a.email! };
}
/**
 * Whether a route's guard admits this caller. A summary reports a section as null when its own endpoint would refuse
 * the caller (403, 404) or isn't set up on this installation (a *_NOT_CONFIGURED error), instead of failing the whole read.
 */
export function admits(guard: () => unknown) {
  try { guard(); return true; }
  catch (error) { if (error instanceof ApiError && (error.status === 403 || error.status === 404 || error.code.endsWith('_NOT_CONFIGURED'))) return false; throw error; }
}
// Received mail a Bane credential can read: dashboard members read addressed mail; unrestricted manage credentials read
// the whole workspace; everything else reads none. Used by mailboxAuth, the unified logs and the MCP listing.
export function actorMailAccess(actor: Actor): MailboxAccess | null {
  if (actor.domains.length) return null;
  if (actor.role === 'member' && actor.credential === 'dashboard') return { keyId: actor.keyId, workspaceId: actor.workspaceId, admin: false, mailboxIds: null, permissions: ['read', 'send'] };
  if (!actor.permissions.includes('manage')) return null;
  return { keyId: actor.keyId, workspaceId: actor.workspaceId, admin: true, mailboxIds: null, permissions: ['read', 'send', 'modify'] };
}
export function senderDomainAllowed(allowed: readonly string[], candidate: string) {
  const domain = candidate.toLowerCase();
  return !allowed.length || allowed.some(value => { const parent = value.toLowerCase(); return domain === parent || domain.endsWith(`.${parent}`); });
}
export const webhookUrlHint = (url: string) => '••••' + url.slice(-4);
export const WebhookUrlHint = z.string().describe('Write-only HTTPS endpoint. Only the last four characters are shown; omit url on update to keep the saved URL.');
export function region(runtime: Runtime, value: string) {
  if (!runtime.config.regions.includes(value)) throw new ApiError(422, 'REGION_NOT_CONFIGURED', 'The requested region is not configured for this deployment.', 'region');
  return value;
}
// Runtime identities are invocation-local in Workers; never reuse an I/O client
// across requests. Node drains also receive a fresh resolved runtime.
const sesClients = new WeakMap<Runtime, Map<string, SESv2Client>>();
export const isSimulatedSes = (runtime: Runtime) => !runtime.config.liveEnabled || !runtime.config.aws;
export function assertSesConfigured(runtime: Runtime) {
  if (isSimulatedSes(runtime)) throw new ApiError(503, 'SES_NOT_CONFIGURED', 'Live SES access is disabled or AWS credentials are missing.');
}
export function assertSharedAccount(runtime: Runtime, row: Pick<ReadyConnection, 'kind' | 'aws_account_id'>) {
  if (runtime.config.multiTenant && row.kind === 'shared' && runtime.config.platformAccount && row.aws_account_id !== null && row.aws_account_id !== runtime.config.platformAccount)
    throw new ApiError(503, 'AWS_ACCOUNT_MISMATCH', 'This Hosted binding belongs to a different platform account.', undefined, true);
}
// Old queued simulator jobs and SNS receipts retain their original topic as a deduplication key.
export function simulatedTopic(topic: unknown, region?: unknown) {
  if (typeof topic !== 'string') return false;
  return ['urn:bane:simulated-ses:', 'urn:opensend:simulated-ses:'].some(prefix => region === undefined ? topic.startsWith(prefix) : topic === prefix + region);
}
/** The bane_email_id tag the dispatcher stamps on every SES message (only meaningful after SNS signature verification). */
export function taggedEmailId(message: unknown): string | undefined {
  const tags = (message as { mail?: { tags?: Record<string, unknown> } } | undefined)?.mail?.tags;
  const tag = tags?.bane_email_id ?? tags?.opensend_email_id;
  const value = Array.isArray(tag) ? tag[0] : undefined;
  return typeof value === 'string' && /^email_[a-z0-9]{8,64}$/.test(value) ? value : undefined;
}
const loadSesClientDeps = lazyModule(() => Promise.all([import('@aws-sdk/client-sesv2'), import('@smithy/fetch-http-handler'), import('./provider-credentials.js')]));
export async function preloadSesTransport(multiTenant = false) {
  const [sesv2, { FetchHttpHandler }, creds] = await wrapModuleLoad(() => loadSesClientDeps());
  if (multiTenant) await wrapModuleLoad(() => creds.loadStsSdk());
  const getSesSync = (runtime: Runtime, selectedRegion: string, connection?: ReadyConnection, runClients?: Map<string, SESv2Client>): SESv2Client => {
    region(runtime, selectedRegion);
    assertSesConfigured(runtime);
    if (runtime.config.multiTenant && connection) assertSharedAccount(runtime, connection); // Even a cached SDK client must not cross a rebind.
    let clients = runClients ?? sesClients.get(runtime);
    if (!clients) { clients = new Map(); sesClients.set(runtime, clients); }
    // The dispatcher leases the connection alongside the mail. One shared-account client can
    // sign for all Hosted tenants (TenantName is on the command); BYO role rotations must get
    // a new provider. Never put a request-bound client or pending STS promise across invocations.
    const key = runClients && connection
      ? JSON.stringify([selectedRegion, connection.kind, connection.aws_account_id, connection.role_arn, connection.external_id, connection.deliverySession])
      : connection ? JSON.stringify([selectedRegion, connection.id, connection.identitySession, connection.deliverySession]) : selectedRegion;
    let client = clients.get(key);
    if (!client) {
      client = new sesv2.SESv2Client({ region: selectedRegion, ...(runtime.config.multiTenant ? { credentials: () => creds.workspaceCredentials(runtime, selectedRegion, connection), ignoreConfiguredEndpointUrls: true } : { credentials: runtime.config.aws }), maxAttempts: 1, cacheMiddleware: !!runClients, requestHandler: new FetchHttpHandler({ requestTimeout: 15000 }) });
      clients.set(key, client);
    }
    return client;
  };
  return { sesv2, getSesSync };
}
export async function getSes(runtime: Runtime, selectedRegion: string, connection?: ReadyConnection, runClients?: Map<string, SESv2Client>): Promise<SESv2Client> {
  region(runtime, selectedRegion);
  assertSesConfigured(runtime);
  if (runtime.config.multiTenant && connection) assertSharedAccount(runtime,connection); // Even a cached SDK client must not cross a rebind.
  const { getSesSync } = await preloadSesTransport(runtime.config.multiTenant);
  return getSesSync(runtime, selectedRegion, connection, runClients);
}
// Database connection failures are transient: the statement never reached the database or the connection dropped.
// Hyperdrive reports its own failures (pool exhausted, origin refused the connection) as SQLSTATE 58000; Postgres
// passes 53300 (too many connections), class 08 (connection exceptions) and 57P01-57P03 (shutdown, starting up);
// node-postgres throws plain errors when a socket drops. Drizzle wraps all of them, so read the cause chain.
const TRANSIENT_SQLSTATES = new Set(['58000', '53300', '57P01', '57P02', '57P03']);
const TRANSIENT_SOCKET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE']);
// node-postgres's pool checkout timeout is the same condition as Hyperdrive's "Failed to acquire a connection".
const TRANSIENT_DRIVER_MESSAGE = /^(?:Connection terminated(?: unexpectedly)?|Client has encountered a connection error and is not queryable|Failed to acquire a connection from the pool\.?|timeout exceeded when trying to connect|Server connection attempt failed: .+)$/;
const errorChain = (error: unknown) => { const chain: Error[] = []; try { for (let current = error; current instanceof Error && chain.length < 5; current = current.cause) chain.push(current); } catch { /* A throwing cause getter or proxy ends the chain. */ } return chain; };
/** The SQLSTATE behind an error, including one wrapped by Drizzle, for logs: a five-character string or nothing. */
export const databaseCodeOf = (error: unknown) => {
  for (const e of errorChain(error)) {
    let code: unknown;
    try { code = (e as { code?: unknown }).code; } catch { continue; }
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
};
export function transientDatabaseError(error: unknown) {
  try {
    if (error instanceof ApiError) return false;
    return errorChain(error).some(e => {
      try {
        const code: unknown = (e as { code?: unknown }).code, message: unknown = e.message;
        return typeof code === 'string' && (TRANSIENT_SQLSTATES.has(code) || /^08[0-9A-Z]{3}$/.test(code) || TRANSIENT_SOCKET_CODES.has(code)) || typeof message === 'string' && TRANSIENT_DRIVER_MESSAGE.test(message);
      } catch { return false; }
    });
  } catch { return false; } // A hostile proxy is not a database error.
}
/** A transaction Postgres rolled back to break a deadlock (40P01) or a serialization conflict (40001): nothing it wrote
 * was kept, so the same request or job can safely run again. */
export const databaseConflict = (error: unknown) => !(error instanceof ApiError) && ['40P01', '40001'].includes(databaseCodeOf(error) ?? '');
/** What callers see when the database is briefly unreachable: retry, nothing was committed by this request. */
export const databaseUnavailable = (background = false) => new ApiError(503, 'DATABASE_UNAVAILABLE', background ? 'The database was briefly unavailable; the job will be retried.' : 'The database is briefly unavailable. Retry the request.', undefined, true);
// Structured logs: one JSON object per line. The Worker's lines go to Workers Logs, the Node API and runner's to
// stdout (CloudWatch on Fargate); the mail gateway writes the same fields. Every request writes one `event: 'request'`
// line (app.ts) and every unexpected failure one `logError` line with its stack. docs/ci.md describes the fields and the
// nightly report that reads them.
const logContext: { service?: string; deploy?: string } = {};
/** Which process is logging and the commit it runs, stamped on every line. */
export function setLogContext(context: { service: string; deploy?: unknown }) {
  logContext.service = context.service;
  logContext.deploy = typeof context.deploy === 'string' && /^[0-9a-f]{7,40}$/.test(context.deploy) ? context.deploy.slice(0, 12) : undefined;
}
const ROUTINE_CODES = new Set(['JOB_COMPLETED', 'QUEUE_WAKE', 'QUEUE_WAKE_COALESCED', 'JOB_DEFERRED']);
// Sample routine successes at the source, NOT whole invocations: a sampled-out request still logs every failure, and
// a kept line carries its `sampleRate` so counts are estimated as 1/sampleRate lines each.
function sampleRate(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>) {
  if (level !== 'info') return 1;
  if (typeof fields.code === 'string' && ROUTINE_CODES.has(fields.code)) return 0.01;
  return typeof fields.status === 'number' && fields.status < 400 ? 0.1 : 1;
}
// Defense in depth: callers log operations, IDs and codes, never bodies, headers, addresses or tokens. A string that
// slips through anyway loses addresses and long credential-like runs: secrets are a prefix and 64 hex digits, while
// IDs carry 32 and error codes are upper case (some are 40 characters long).
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const CREDENTIAL = /[A-Za-z0-9_]{40,}/g;
const credentialLike = (run: string) => /[a-z]/.test(run) && /[0-9]/.test(run) ? '[redacted]' : run;
// Only strings, numbers, booleans, plain objects and arrays are written, and every object or array in a line is one
// scrub built itself: no method of the input is called (not slice, map or entries, which an array or proxy can
// override) and no getter runs. An array is read by index up to 50 elements, an object by its own enumerable data
// properties up to 50 keys, each read inside try. Anything else (an error, a class instance, an accessor, a proxy that
// throws, anything nested deeper than three levels) becomes '[object]', so no toString or toJSON is ever reached.
const SCRUB_ITEMS = 50;
function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.replace(EMAIL, '[email]').replace(CREDENTIAL, credentialLike).slice(0, 2000);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value;
  if (typeof value !== 'object') return typeof value === 'bigint' ? String(value) : undefined; // Functions and symbols.
  try {
    if (depth > 2) return '[object]';
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return '[object]';
      const length: unknown = Reflect.get(value, 'length');
      const items: unknown[] = [];
      for (let index = 0; index < (typeof length === 'number' && length > 0 ? Math.min(Math.floor(length), SCRUB_ITEMS) : 0); index++) {
        let item: unknown;
        try { const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index)); item = descriptor && 'value' in descriptor ? scrub(descriptor.value, depth + 1) : descriptor ? '[object]' : undefined; }
        catch { item = '[object]'; }
        items[index] = item === undefined ? null : item;
      }
      return items;
    }
    if (prototype !== Object.prototype && prototype !== null) return '[object]';
    const entries: Record<string, unknown> = Object.create(null);
    let kept = 0;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') continue;
      if (kept++ >= SCRUB_ITEMS) break;
      try {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (descriptor?.enumerable) entries[key] = 'value' in descriptor ? scrub(descriptor.value, depth + 1) : '[object]';
      } catch { entries[key] = '[object]'; }
    }
    return entries;
  } catch { return '[object]'; } // A proxy that throws from getPrototypeOf, ownKeys or a revoked proxy.
}
/** What `log` writes when a line cannot be built: logging never throws into a request. */
const LOG_FALLBACK = '{"level":"error","code":"LOG_SERIALIZE_FAILED"}';
function logFallback() { try { console.error(LOG_FALLBACK); } catch { /* Nothing left to write with. */ } }
export function log(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>) {
  let line: string, write: 'info' | 'warn' | 'error' = 'error';
  try {
    write = level === 'info' || level === 'warn' ? level : 'error';
    const rate = sampleRate(write, fields);
    if (rate < 1 && Math.random() >= rate) return;
    const clean = scrub(fields);
    if (clean === null || typeof clean !== 'object' || Array.isArray(clean)) throw new TypeError('fields are not a plain object');
    line = JSON.stringify({ level: write, timestamp: new Date().toISOString(), service: logContext.service, deploy: logContext.deploy, ...clean, ...(rate < 1 ? { sampleRate: rate } : {}) });
  } catch { return logFallback(); }
  try { console[write](line); } catch { logFallback(); }
}
// A V8 stack is a header and then "    at <function> (<location>)" frames. The header is the error's name and message
// (`${name}: ${message}`, or whichever is not empty), and either can span lines that look exactly like frames: a
// database error quotes its SQL parameters, and a name is just a property (PR #131 review). So neither is trusted and
// no line is counted: the stack must start with that exact header text, character for character, and frames are read
// only after it (V8 formats the header from the current name and message on first access). Every line after it must be
// a frame; only frames in Bane's own code (the Worker bundle, or src/ or dist/ outside node_modules) are kept, rebuilt
// from the function name and file:line:column. Anything else fails closed: no frames. The one case this cannot see is
// code that shortens a message after something already read the stack; no request can do that.
const FRAME = /^ {4}at (?:async )?(?:(?:new )?([\w$.<>[\]]{1,80}(?: \[as [\w$]{1,40}\])?) \()?(?:file:\/\/)?([^\s()]{1,300}):(\d{1,7}):(\d{1,7})\)?$/;
const OWN_CODE = /(?:^|\/)(worker\.js|(?:src|dist)\/[\w./-]{1,200}\.(?:ts|js))$/;
export function stackFrames(error: unknown, limit = 12) {
  let stack: unknown, name: unknown, message: unknown;
  try {
    if (!(error instanceof Error)) return undefined;
    stack = error.stack; name = error.name; message = error.message;
  } catch { return undefined; } // A throwing getter or proxy trap, or a revoked proxy.
  // Each read once; anything but a string (an object with its own toString) fails closed.
  if (name === undefined) name = 'Error';
  if (message === undefined) message = '';
  if (typeof stack !== 'string' || typeof name !== 'string' || typeof message !== 'string') return undefined;
  const header = !name ? message : !message ? name : `${name}: ${message}`;
  if (!stack.startsWith(`${header}\n`)) return undefined;
  const frames: string[] = [];
  for (const line of stack.slice(header.length + 1).split('\n')) {
    if (!/^ {4}at /.test(line)) return undefined; // Not a stack after all.
    const match = FRAME.exec(line);
    if (!match) continue; // A native, eval or anonymous-location frame.
    const [, fn, location, row, column] = match;
    const file = location!.includes('node_modules') ? undefined : OWN_CODE.exec(location!)?.[1];
    if (file && frames.length < limit) frames.push(`${fn ?? '<anonymous>'} (${file}:${row}:${column})`);
  }
  return frames.join('\n') || undefined;
}
/**
 * An error's class name (`TypeError`, `DrizzleQueryError`) as a string, or `Error`. `name` is read once and used only
 * when it is a string that looks like a class name: an object with its own toString would be serialized whole.
 */
const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export function errorTypeOf(error: unknown): string {
  try {
    if (!(error instanceof Error)) return error === null ? 'null' : typeof error;
    const name: unknown = error.name;
    return typeof name === 'string' && CLASS_NAME.test(name) ? name : 'Error';
  } catch { return 'Error'; }
}
/**
 * One line for an unexpected failure: its code, error class, SQLSTATE and Bane's own stack frames. Never a message:
 * neither the error's nor an ApiError's, whose text can quote request data (a template variable, a filename).
 */
/** An error code for a log line: an upper-case code string (`INTERNAL_ERROR`, `MCP_HTTP_405`), or `UNKNOWN_ERROR`. */
export const errorCodeOf = (value: unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'UNKNOWN_ERROR';
export function logError(error: unknown, fields: Record<string, unknown> & { code: string; message?: never }, level: 'error' | 'warn' = 'error') {
  let entry: Record<string, unknown>;
  try {
    let known = false;
    try { known = error instanceof ApiError; } catch { /* A proxy: treat as unexpected. */ }
    // `code` usually comes from an ApiError; it is logged only as an error-code-shaped string.
    entry = { ...fields, code: errorCodeOf(fields.code), errorType: known ? undefined : errorTypeOf(error), databaseCode: databaseCodeOf(error), stack: known ? undefined : stackFrames(error) };
  } catch { return logFallback(); }
  log(level, entry);
}
export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; worker-src 'self' blob:; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
} as const;
export function applySecurityHeaders(headers: Headers): Headers {
  // Route-specific policies (notably OAuth form redirects) take precedence.
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!headers.has(name)) headers.set(name, value);
  return headers;
}
export function secureResponse(response: Response): Response {
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: applySecurityHeaders(new Headers(response.headers)) });
}
// HTTPS installations name auth cookies `__Host-bane.*`; plain-HTTP local development uses `bane.*`.
export const HOST_COOKIE = '__Host-bane.';
export function hasSessionCookie(headers: Headers): boolean {
  const cookie = headers.get('cookie');
  return Boolean(cookie && /(?:^|;\s*)(?:__Host-)?bane\.session_token(?:\.\d+)?=[^;\s]/.test(cookie));
}
export function publicFailureBucket(path: string, status: number, headers?: Headers): 'auth' | 'unsubscribe' | null {
  // SNS callers share egress addresses; reject untrusted topics/signatures without charging that pool.
  if (status < 400 || status >= 500 || path === '/v1/events/ses') return null;
  if (/^\/unsubscribe(?:\/|$)/.test(path) || /^\/v1\/forwarding\//.test(path)) return 'unsubscribe';
  if (status !== 401 || !/^\/v1(?:\/|$)/.test(path)) return null;
  return headers && !headers.has('authorization') && !hasSessionCookie(headers) ? null : 'auth';
}
export function admissionPeer(address: string): string {
  if (!address.includes(':')) return address;
  try {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical);
    if (mapped) return mapped.slice(1).flatMap(v => [parseInt(v,16) >>> 8, parseInt(v,16) & 255]).join('.');
    const [left, right] = canonical.split('::');
    const a = left ? left.split(':') : [], b = right ? right.split(':') : [];
    return [...a, ...Array(8-a.length-b.length).fill('0'), ...b].slice(0,4).join(':') + '::';
  } catch { return 'unknown'; }
}
// Cloudflare gives every cross-zone Worker subrequest the same client address and names the calling
// zone in CF-Worker, so callers on Workers (OpenCode Console among them) would otherwise share one
// admission bucket and one failure budget with every other Worker on the Internet. Only that egress
// address may choose a bucket this way; any other client keeps its own address.
const WORKER_EGRESS = admissionPeer('2a06:98c0:3600::103');
export function admissionKey(address: string, worker: string | null) {
  const zone = worker?.trim().toLowerCase();
  return address === WORKER_EGRESS && zone && /^[a-z0-9.-]{1,253}$/.test(zone) ? `worker:${zone}` : address;
}

// Identity entry has a request budget; authenticated API routes have a failure
// budget. Check completed failures before dispatch, never charge concurrency.
const failureCounts = new Map<string, number>();
let failureMinute = 0;
export function allowMalformedSns(peer: string) {
  const minute=Math.floor(Date.now()/60000);
  if(minute!==failureMinute){failureCounts.clear(); failureMinute=minute;}
  const key=`malformed-sns:${peer}`, count=failureCounts.get(key)??0;
  if(count>=40 || (!count && failureCounts.size>=4096)) return false;
  failureCounts.set(key,count+1); return true;
}
export async function guardPublicRequest(path: string, headers: Headers, peer: string, work: () => Promise<Response>) {
  const entry = /^\/(?:api\/auth|\.well-known)(?:\/|$)/.test(path) || path==='/mcp/login' || path==='/mcp/consent';
  const lane = entry ? 'identity-entry' : publicFailureBucket(path, 401, headers);
  if (!lane) return work();
  const minute = Math.floor(Date.now()/60000);
  if (minute !== failureMinute) { failureCounts.clear(); failureMinute = minute; }
  const key = `${lane}:${peer}`;
  // At capacity, rely on edge admission for unknown peers. Never share either
  // a penalty or an in-flight reservation between unrelated credentials.
  if (!failureCounts.has(key) && failureCounts.size >= 4096) return entry ? publicFailureDenied() : work();
  const count = failureCounts.get(key) ?? 0;
  if (count >= 40) return publicFailureDenied();
  if(entry) failureCounts.set(key,count+1);
  const response=await work();
  if(!entry && minute===failureMinute && publicFailureBucket(path,response.status,headers) && (failureCounts.has(key) || failureCounts.size<4096)) {
    failureCounts.set(key,Math.min(40,(failureCounts.get(key)??0)+1));
  }
  return response;
}
/**
 * One atomic per-minute counter in api_request_budgets, named by `key` within a workspace: true while this minute's
 * charges, this one included, stay within `limit`. A window stored in the future (an operator's or a test's hold) stays.
 */
export async function chargeBudget(runtime: Pick<Runtime, 'db'>, workspaceId: string, key: string, limit: number) {
  const { rows: [row] } = await runtime.db.execute<{ used: number }>(sql`INSERT INTO api_request_budgets(workspace_id, key_id, window_start, used)
    VALUES (${workspaceId}, ${key}, date_trunc('minute', now()), 1)
    ON CONFLICT (workspace_id, key_id) DO UPDATE SET
      used = CASE WHEN excluded.window_start > api_request_budgets.window_start THEN 1 ELSE least(api_request_budgets.used + 1, ${limit + 1}) END,
      window_start = greatest(api_request_budgets.window_start, excluded.window_start) RETURNING used`);
  return row!.used <= limit;
}
// All credentials and image-producing routes share one atomic workspace counter.
export async function chargeRenderBudget(c: Ctx, workspaceId: string) {
  const limit = 30;
  if (!await chargeBudget(c.env, workspaceId, 'render:images', limit)) {
    c.header('Retry-After', '60');
    throw new ApiError(429, 'RENDER_RATE_LIMITED', `This workspace allows ${limit} image previews and imports per minute. Retry after the window resets.`, undefined, true);
  }
}
export async function timed<T>(c: Ctx, name: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await work(); }
  finally { c.get('serverTimings').push({ name, durationMs: performance.now() - start }); }
}
export async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('');
}
export function randomSecret(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return prefix + Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
}
export function notFound(entity: string): never { throw new ApiError(404, 'NOT_FOUND', `${entity} was not found.`); }
export const redactCapabilityText = (value: string) => value.replace(/u_[0-9a-f]{64}/g, '[redacted]');
export function redactCapabilityData(value: Record<string, unknown>): Record<string, unknown> {
  const redact = (item: unknown): unknown => {
    if (typeof item === 'string') return redactCapabilityText(item);
    if (Array.isArray(item)) return item.map(redact);
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [redactCapabilityText(key), redact(child)]));
    return item;
  };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactCapabilityText(key), redact(item)]));
}
export function admissionDenied(): Response {
  const requestId = id('req');
  log('warn', { requestId, code: 'ADMISSION_RATE_LIMITED', operation: 'admission' });
  return secureResponse(Response.json({ error: { code: 'ADMISSION_RATE_LIMITED', message: 'Too many requests from this connection. Retry after one minute.', requestId, retryable: true } }, { status: 429, headers: { 'x-request-id': requestId, 'retry-after': '60', 'cache-control': 'no-store' } }));
}
export function publicFailureDenied(): Response {
  const requestId = id('req');
  log('warn', { requestId, code: 'PUBLIC_RATE_LIMITED', operation: 'public-failure' });
  return secureResponse(Response.json({ error: { code: 'PUBLIC_RATE_LIMITED', message: 'Too many failed public requests from this connection. Retry after one minute.', requestId, retryable: true } }, { status: 429, headers: { 'x-request-id': requestId, 'retry-after': '60', 'cache-control': 'no-store' } }));
}
