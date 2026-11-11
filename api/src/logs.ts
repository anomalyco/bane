import { createRoute, z } from '@hono/zod-openapi';
import { and, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { actor, ApiError, errors, PageQuery, region, response, security, type Actor, type App, type MailboxAccess } from './core.js';
import { emails } from './db/sending.js';
import { mailMessages as messages } from './db/mailbox.js';
import { accessibleMessages, readsDelivery, visibleAddresses } from './inbound-threads.js';
import { listedSubject, literalSearch, pageBinding, scope, senderDomainWhere, sentUntrustedContent, Status } from './sending.js';

// Logs: sent and received mail in one list, newest first, from one SQL statement. Each side keeps its own index
// (sending_emails_created_page, mail_messages_tenant_page) and limit; the outer query merges the two pages. The cursor
// carries the direction, so equal timestamps across the two tables still page exactly once: at one instant sent rows
// come before received rows.
//
// Received mail follows listInboundMessages: manage credentials read every retained message, including unrouted mail;
// dashboard members read mail on live addresses; credentials that can't read inbound mail (domain-restricted or
// read-only keys) get sent mail only. Delivery details (envelope recipients, region, spam) follow readsDelivery: owner
// and admin dashboard sessions and manage API keys, never MCP grants or agent tokens.

const Address = z.object({ name: z.string().nullable(), address: z.string() });
const LogEntry = z.object({
  id: z.string().describe('Email ID for sent mail (getEmail); message ID for received mail (getInboundMessage).'),
  direction: z.enum(['sent', 'received']),
  untrustedContent: z.boolean().describe('Received mail and sent mailbox replies can contain external sender content.'),
  at: z.string().describe('When the email was created (sent) or received.'),
  status: z.string().describe('Sent: the email status. Received: received, or spam when flagged (spam is shown to administrators only).'),
  from: Address,
  to: z.array(z.string()).describe('Sent: the To recipients. Received: the addresses in the To header.'),
  subject: z.string(),
  stream: z.enum(['transactional', 'marketing']).nullable().describe('Sent mail only.'),
  campaignId: z.string().nullable(),
  simulated: z.boolean().describe('Sent through the SES mailbox simulator. Always false for received mail.'),
  attachmentCount: z.number().int().nullable().describe('Received mail only.'),
  threadId: z.string().nullable().describe('Received mail only.'),
  addresses: z.array(z.object({ id: z.string(), address: z.string() })).nullable().describe('Received mail only: the receiving addresses it was delivered to that the caller can read. Empty for unrouted mail.'),
  region: z.string().nullable().describe('Null for received mail unless the caller is an administrator.'),
  envelopeTo: z.array(z.string()).nullable().describe('Received mail, administrators only: the SMTP envelope recipients.'),
}).openapi('LogEntry');
const LogPage = z.object({
  data: z.array(LogEntry), nextCursor: z.string().nullable(),
  received: z.boolean().describe('Whether received mail is included: false for direction=sent, with a sent-only filter, or when the credential cannot read inbound mail.'),
}).openapi('LogPage');
const LogQuery = PageQuery.extend({
  direction: z.enum(['all', 'sent', 'received']).default('all'),
  search: z.string().trim().min(1).max(200).optional().describe('Sent mail: a literal, case-insensitive substring of the sender, recipients, subject or IDs. Received mail: a full-text match on sender, recipients, subject and body.'),
  status: Status.optional().describe('Sent mail only; received mail is left out when set.'),
  kind: z.enum(['transactional', 'marketing']).optional().describe('Sent mail only; received mail is left out when set.'),
  campaignId: z.string().max(120).optional().describe('Sent mail only; received mail is left out when set.'),
  region: z.string().min(1).max(40).optional(),
}).refine(q => q.direction !== 'received' || !(q.status || q.kind || q.campaignId), 'status, kind and campaignId filter sent mail and cannot be used with direction=received.').openapi('ListLogsQuery');

// Postgres keeps microseconds; the cursor keeps them too so a page boundary never skips a row.
const precise = (column: AnyPgColumn) => sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const Cursor = z.tuple([z.iso.datetime(), z.enum(['sent', 'received']), z.string().min(1).max(120), z.string()]);
function readCursor(value: string | undefined, binding: string) {
  if (!value) return null;
  try {
    const [at, direction, id, bound] = Cursor.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    if (bound !== binding) throw new Error();
    return { at, direction, id };
  } catch { throw new ApiError(422, 'INVALID_CURSOR', 'Use the returned cursor with the same filters.', 'cursor'); }
}

type Row = { direction: 'sent' | 'received'; untrusted: boolean; id: string; at: string; status: string; from_address: string; from_name: string | null; to: unknown[]; subject: string; stream: 'transactional' | 'marketing' | null; campaign_id: string | null; simulated: boolean; attachment_count: number | null; thread_id: string | null; addresses: { id: string; address: string }[] | null; region: string | null; envelope_to: string[] | null };

export function registerLogs(app: App, mailAccess: (a: Actor) => MailboxAccess | null) {
  app.openapi(createRoute({ method: 'get', path: '/v1/logs', operationId: 'listLogs', tags: ['Emails'], security, summary: 'List sent and received mail together',
    description: 'Sent and received mail in one list, newest first, with an opaque cursor bound to the filters. Sent mail is what listEmails returns (keys restricted to domains see their own domains); received mail is what listInboundMessages returns for the same credential: administrators see every received message, including unrouted mail, with delivery details; dashboard members see mail on receiving addresses; other credentials get sent mail only. status, kind and campaignId filter sent mail and leave received mail out.',
    request: { query: LogQuery }, responses: { 200: response(LogPage), ...errors } }), async c => {
    const a = actor(c), q = c.req.valid('query');
    if (q.region) region(c.env, q.region);
    const access = mailAccess(a);
    if (q.direction === 'received' && !access) throw a.domains.length ? new ApiError(403, 'UNRESTRICTED_KEY_REQUIRED', 'Received mail requires a credential without domain restrictions.') : new ApiError(403, 'ADMIN_REQUIRED', 'Received mail requires a dashboard session or a manage credential.');
    const binding = await pageBinding(a, 'logs', q), after = readCursor(q.cursor, binding), n = q.limit + 1;
    const sent = q.direction !== 'received', received = q.direction !== 'sent' && !!access && !(q.status || q.kind || q.campaignId);

    const sentPage = sent ? sql`(SELECT 'sent'::text AS direction, ${sentUntrustedContent} AS untrusted, ${emails.id} AS id, ${emails.createdAt} AS sort_at, ${precise(emails.createdAt)} AS at, ${emails.status} AS status,
        ${emails.from} AS from_address, ${emails.snapshot}->>'fromName' AS from_name, ${emails.to} AS "to", ${emails.subject} AS subject, ${emails.snapshot}->>'kind' AS stream,
        ${emails.campaignId} AS campaign_id, ${emails.simulated} AS simulated, NULL::int AS attachment_count, NULL::text AS thread_id, NULL::jsonb AS addresses, ${emails.region} AS region, NULL::jsonb AS envelope_to
      FROM ${emails} WHERE ${and(scope(emails, a), senderDomainWhere(emails.from, a.domains),
        after ? after.direction === 'sent' ? sql`(${emails.createdAt}, ${emails.id}) < (${after.at}::timestamptz, ${after.id})` : sql`${emails.createdAt} < ${after.at}::timestamptz` : undefined,
        q.campaignId ? sql`${emails.campaignId} = ${q.campaignId}` : undefined, q.status ? sql`${emails.status} = ${q.status}` : undefined,
        q.kind ? sql`${emails.snapshot}->>'kind' = ${q.kind}` : undefined, q.region ? sql`${emails.region} = ${q.region}` : undefined,
        q.search ? sql`sending_log_text(${emails.id},${emails.campaignId},${emails.providerId},${emails.from},${emails.subject},${emails.to} || ${emails.cc} || ${emails.bcc}) ILIKE ${literalSearch(q.search)}` : undefined)}
      ORDER BY ${emails.createdAt} DESC, ${emails.id} DESC LIMIT ${n})` : null;

    // Which messages: every retained one for administrators. Delivery details: only where getInboundMessage gives them.
    const delivery = !!access && readsDelivery(a, access);
    const receivedPage = received && access ? sql`(SELECT 'received'::text AS direction, true AS untrusted, ${messages.id} AS id, ${messages.receivedAt} AS sort_at, ${precise(messages.receivedAt)} AS at,
        ${delivery ? sql`CASE WHEN ${messages.spam} THEN 'spam' ELSE ${messages.status} END` : messages.status} AS status,
        ${messages.fromAddress} AS from_address, ${messages.fromName} AS from_name, coalesce((SELECT jsonb_agg(t->>'address') FROM jsonb_array_elements(${messages.to}) t), '[]'::jsonb) AS "to",
        ${messages.subject} AS subject, NULL::text AS stream, NULL::text AS campaign_id, false AS simulated, ${messages.attachmentCount} AS attachment_count, ${messages.threadId} AS thread_id,
        ${visibleAddresses(access)} AS addresses, ${delivery ? messages.region : sql`NULL::text`} AS region, ${delivery ? messages.envelopeTo : sql`NULL::jsonb`} AS envelope_to
      FROM ${messages} WHERE ${and(accessibleMessages(access, {}), sql`${messages.direction} = 'inbound'`,
        after ? after.direction === 'received' ? sql`(${messages.receivedAt}, ${messages.id}) < (${after.at}::timestamptz, ${after.id})` : sql`${messages.receivedAt} <= ${after.at}::timestamptz` : undefined,
        q.region ? sql`${messages.region} = ${q.region}` : undefined, q.search ? sql`mail_messages.search @@ websearch_to_tsquery('simple', ${q.search})` : undefined)}
      ORDER BY ${messages.receivedAt} DESC, ${messages.id} DESC LIMIT ${n})` : null;

    const pages = [sentPage, receivedPage].filter((part): part is SQL => part !== null);
    const { rows } = await c.env.db.execute<Row>(pages.length === 1 ? pages[0]!
      : sql`SELECT * FROM (${pages[0]} UNION ALL ${pages[1]}) log ORDER BY sort_at DESC, direction DESC, id DESC LIMIT ${n}`);
    const last = rows.length > q.limit ? rows[q.limit - 1] : undefined;
    return c.json({
      data: rows.slice(0, q.limit).map(row => ({
        id: row.id, direction: row.direction, untrustedContent: row.untrusted, at: new Date(row.at).toISOString(), status: row.status, from: { name: row.from_name, address: row.from_address },
        to: (row.to ?? []).map(String), subject: listedSubject(a, row).subject, stream: row.stream, campaignId: row.campaign_id, simulated: row.simulated, attachmentCount: row.attachment_count,
        threadId: row.thread_id, addresses: row.addresses, region: row.region, envelopeTo: row.envelope_to,
      })),
      nextCursor: last ? Buffer.from(JSON.stringify([last.at, last.direction, last.id, binding])).toString('base64url') : null,
      received,
    }, 200);
  });
}
