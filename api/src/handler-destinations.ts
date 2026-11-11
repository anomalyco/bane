import { createRoute, z } from '@hono/zod-openapi';
import { sql, and, eq } from 'drizzle-orm';
import {
  ApiError,
  digest,
  errors,
  id,
  json,
  randomSecret,
  response,
  security,
  type App,
  type ClaimedWebhook,
  type Runtime,
} from './core.js';
import { mailboxes, mailMessages, mailboxWebhooks, retainedMail } from './db/mailbox.js';
import { handlerAdmin } from './handlers.js';
import { encrypt, decrypt, webhookSecret, postWebhook } from './operations.js';
import { webhookSecretBinding } from './mailbox-events.js';
import { lockMailboxLane } from './mailbox-store.js';
import { sendFromMailbox } from './mailbox-send.js';
import { invitationRecipient } from './google-auth.js';

const endpoint = '/v1/routing/handler-destinations',
  key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  meta = { security, tags: ['Handlers'] };
const summary = z.object({ ref: z.string(), verified: z.boolean() });
const connectorInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('slack'), key, url: z.string().max(2048) }),
  z.object({ type: z.literal('discord'), key, url: z.string().max(2048) }),
  z.object({ type: z.literal('forward'), key, address: z.email().max(254).toLowerCase(), senderInbox: z.string().max(120) }),
]);
export function pinnedUrl(type: string, value: string) {
  const pattern =
    type === 'slack'
      ? /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/
      : /^https:\/\/discord\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/;
  if (!pattern.test(value) || value.trim() !== value)
    throw new ApiError(422, 'INVALID_CONNECTOR', 'Use the incoming webhook URL issued by this connector.');
  return value;
}
export function renderChat(type: string, body: unknown) {
  const fail = () =>
    new ApiError(422, 'INVALID_CONNECTOR_MESSAGE', type === 'slack' ? 'Use {text: "…"}.' : 'Use {content: "…"}.');
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) throw fail();
  const k = type === 'slack' ? 'text' : 'content',
    s = (body as Record<string, unknown>)[k];
  if (typeof s !== 'string' || !s.length) throw fail();
  return type === 'slack'
    ? {
        text: s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').slice(0, 3000),
        mrkdwn: false,
        unfurl_links: false,
        unfurl_media: false,
      }
    : { content: s.replace(/([\\*_~`|>])/g, '\\$1').slice(0, 2000), allowed_mentions: { parse: [] } };
}
export function registerHandlerDestinations(app: App) {
  const policy=z.object({ref:z.string().max(128),perMinute:z.number().int().min(1).max(6000),retryOnTimeout:z.boolean(),idempotent:z.boolean().default(false)}).strict();
  app.openapi(createRoute({...meta,method:'put',path:endpoint+'/policy',operationId:'setHandlerDeliveryPolicy',summary:'Set destination calls per minute and unknown-outcome retry policy; only declare idempotency for a webhook that implements Idempotency-Key',request:{body:json(policy)},responses:{200:response(policy),...errors}}),async c=>{const w=handlerAdmin(c,true).workspaceId,q=c.req.valid('json');if(q.idempotent&&!q.ref.startsWith('webhook:'))throw new ApiError(422,'UNSUPPORTED_IDEMPOTENCY','Only custom webhooks can declare idempotency support.');const result=await c.env.db.execute(sql`INSERT INTO mail_action_policies(workspace_id,hook_id,per_minute,retry_on_timeout,idempotent) SELECT ${w},id,${q.perMinute},${q.retryOnTimeout},${q.idempotent} FROM mailbox_webhooks WHERE workspace_id=${w} AND (('webhook:'||key=${q.ref} AND NOT starts_with(id,'con_')) OR id=(SELECT hook_id FROM mail_handler_destinations WHERE workspace_id=${w} AND ref=${q.ref})) ON CONFLICT(workspace_id,hook_id) DO UPDATE SET per_minute=excluded.per_minute,retry_on_timeout=excluded.retry_on_timeout,idempotent=excluded.idempotent RETURNING 1`);if(!result.rowCount)throw new ApiError(404,'NOT_FOUND','Unknown destination.');return c.json(q,200)});
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path: endpoint,
      operationId: 'listHandlerDestinations',
      responses: { 200: response(z.object({ data: z.array(summary) })), ...errors },
    }),
    async (c) => {
      const w = handlerAdmin(c).workspaceId;
      return c.json(
        {
          data: (
            await c.env.db.execute<{ ref: string; verified: boolean }>(
              sql`SELECT ref,verified FROM mail_handler_destinations WHERE workspace_id=${w} UNION ALL SELECT 'webhook:'||key,true FROM mailbox_webhooks WHERE workspace_id=${w} AND key IS NOT NULL AND NOT starts_with(id,'con_') UNION ALL SELECT 'inbox:'||key,true FROM mailboxes WHERE workspace_id=${w} AND key IS NOT NULL ORDER BY ref`,
            )
          ).rows,
        },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'post',
      path: endpoint,
      operationId: 'createHandlerDestination',
      summary: 'Add a write-only chat credential or send a forward verification request to its recipient',
      request: { body: json(connectorInput) },
      responses: { 201: response(summary), ...errors },
    }),
    async (c) => {
      const a = handlerAdmin(c, true),
        q = c.req.valid('json'),
        w = a.workspaceId,
        ref = q.type + ':' + q.key,
        hook = id('con'),
        token = randomSecret('verify_'),
        value = q.type === 'forward' ? q.address : pinnedUrl(q.type, q.url);
      await c.env.db.transaction(async (tx) => {
        await lockMailboxLane(tx, w, 'address');
        const count = (
          await tx.execute<{ n: number; exists: boolean }>(
            sql`SELECT count(*)::int AS n,coalesce(bool_or(ref=${ref}),false) AS exists FROM mail_handler_destinations WHERE workspace_id=${w}`,
          )
        ).rows[0];
        if (count.exists || count.n >= 50)
          throw new ApiError(
            409,
            'DESTINATION_CONFLICT',
            'Choose an unused key; at most 50 connector and forward destinations.',
          );
        await tx.insert(mailboxWebhooks).values({
          id: hook,
          workspaceId: w,
          name: ref,
          url: 'https://handler.invalid/',
          eventTypes: [],
          encryptedSecret: await encrypt(c.env, webhookSecret(), webhookSecretBinding(w, hook)),
        });
        await tx.execute(
          sql`INSERT INTO mail_handler_destinations(workspace_id,ref,hook_id,encrypted_value,verified,proof_hash,expires_at) VALUES(${w},${ref},${hook},${await encrypt(c.env, value, w + ':destination:' + hook)},${q.type !== 'forward'},${q.type === 'forward' ? await digest(token) : null},now()+interval '24 hours')`,
        );
        if (q.type === 'forward') {
          const [box] = await tx
            .select()
            .from(mailboxes)
            .where(and(eq(mailboxes.id, q.senderInbox), eq(mailboxes.workspaceId, w)));
          if (!box || box.kind === 'inbox' || box.expiresAt)
            throw new ApiError(422, 'INVALID_SENDER', 'Select a permanent receiving address for the verification request.');
          await checkExternal(tx, w, value);
          await debit(tx, w, 'forward-verification', 20, 'day');
          await debit(tx, w, 'forward-verification:' + (await digest(value)), 3, 'day');
          await sendFromMailbox(c.env, tx, {
            actor: a,
            scope: { workspaceId: w },
            mailbox: box,
            from: box.address,
            to: [value],
            cc: [],
            bcc: [],
            replyTo: [],
            subject: 'Confirm email forwarding',
            text: `${box.address} requested permission to forward mail to you. To approve, sign in as ${value} and open this link within 24 hours:\n${c.env.config.publicUrl.replace(/\/$/, '')}/v1/routing/forward-confirm/${token}\nIgnore this message to decline.`,
            inReplyTo: null,
            references: [],
            headers: [],
            attachments: [],
          });
        }
      });
      return c.json({ ref, verified: q.type !== 'forward' }, 201);
    },
  );
  // GET never consumes a verification link (mail scanners follow links). The outgoing archive is
  // readable by admins: proof requires BOTH the link and the recipient's verified login.
  const confirm = '/v1/routing/forward-confirm/:token';
  app.get(confirm, (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'");
    return c.html(
      '<h1>Approve incoming forwards</h1><p>Sign in to Bane as the recipient before confirming. Ignore this request to decline.</p><form method="post"><button>Allow forwarding to me</button></form>',
    );
  });
  app.post(confirm, async (c) => {
    const user = await invitationRecipient(c.env, c.req.raw.headers);
    await confirmForward(c.env, c.req.param('token'), user.email);
    return c.text('Forwarding approved.');
  });
}
/** Caller authenticated this address with a verified, origin-checked dashboard session. */
export async function confirmForward(runtime: Runtime, token: string, verifiedEmail: string) {
  const hash = await digest(token);
  await runtime.db.transaction(async (tx) => {
    const r = (
      await tx.execute<{ workspace_id: string; hook_id: string; encrypted_value: string }>(
        sql`SELECT workspace_id,hook_id,encrypted_value FROM mail_handler_destinations WHERE proof_hash=${hash} AND expires_at>now() AND NOT verified FOR UPDATE`,
      )
    ).rows[0];
    if (
      !r ||
      (await decrypt(runtime, r.encrypted_value, r.workspace_id + ':destination:' + r.hook_id)) !==
        verifiedEmail.toLowerCase()
    )
      throw new ApiError(403, 'VERIFICATION_REQUIRED', 'Use the unexpired link while signed in as its recipient.');
    await tx.execute(sql`UPDATE mail_handler_destinations SET verified=true,proof_hash=NULL WHERE proof_hash=${hash}`);
  });
}
async function checkExternal(tx: Pick<Runtime['db'], 'execute'>, w: string, address: string) {
  if (
    (
      await tx.execute(
        sql`SELECT FROM mailbox_domains WHERE workspace_id=${w} AND coalesce(receiving_host,name)=split_part(${address},'@',2) LIMIT 1`,
      )
    ).rowCount
  )
    throw new ApiError(422, 'FORWARD_LOOP', 'Cannot forward to a receiving host of this workspace.');
}
async function debit(tx: Pick<Runtime['db'], 'execute'>, w: string, key: string, limit: number, window: 'day' | 'hour') {
  const charge =
    await tx.execute(sql`INSERT INTO api_request_budgets AS b(workspace_id,key_id,window_start,used) VALUES(${w},${key},date_trunc(${window},now()),1)
    ON CONFLICT(workspace_id,key_id) DO UPDATE SET used=CASE WHEN b.window_start=excluded.window_start THEN b.used+1 ELSE 1 END,window_start=excluded.window_start
    WHERE b.window_start<>excluded.window_start OR b.used<${limit} RETURNING 1`);
  if (!charge.rowCount)
    throw new ApiError(429, 'FORWARD_LIMIT', 'Forwarding budget reached for this window.', undefined, true);
}
export async function deliverConnector(runtime: Runtime, w: string, h: ClaimedWebhook) {
  const event = h.payload as {
      messageId: string;
      type: string;
      handlerBody?: unknown;
      data: { recipients?: string[]; junk?: boolean };
    },
    hook = h.webhook_id;
  const d = (
    await runtime.db.execute<{ ref: string; encrypted_value: string }>(
      sql`SELECT ref,encrypted_value FROM mail_handler_destinations WHERE workspace_id=${w} AND hook_id=${hook} AND verified`,
    )
  ).rows[0];
  if (!d || event.type !== 'message.received' || event.data.junk || !event.data.recipients?.length)
    throw new ApiError(422, 'CONNECTOR_UNAVAILABLE', 'Only verified, routed non-junk deliveries can leave.');
  const type = d.ref.split(':')[0],
    value = await decrypt(runtime, d.encrypted_value, w + ':destination:' + hook);
  if (type !== 'forward') {
    const body = JSON.stringify(renderChat(type, event.handlerBody));
    return postWebhook(runtime,pinnedUrl(type,value),{},body,null,w+':destination:'+hook);
  }
  await runtime.db.transaction(async (tx) => {
    await checkExternal(tx, w, value);
    const [m] = await tx
      .select()
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.workspaceId, w),
          eq(mailMessages.id, event.messageId),
          eq(mailMessages.direction, 'inbound'),
          retainedMail(),
        ),
      );
    if (
      !m ||
      (m.verdicts as { forwardSafe?: boolean }).forwardSafe !== true ||
      m.automated ||
      m.spam ||
      m.status !== 'received' ||
      m.verdicts.virus !== 'PASS' ||
      m.headers.some((h) => ['auto-submitted', 'x-bane-loop', 'list-id', 'precedence'].includes(h.name.toLowerCase())) ||
      m.headers.filter((h) => h.name.toLowerCase() === 'received').length >= 25
    )
      throw new ApiError(422, 'FORWARD_BLOCKED', 'Automated, junk, unparsed, looped or unscanned mail is never forwarded.');
    const recipient = event.data.recipients![0];
    const [box] = await tx
      .select()
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.workspaceId, w),
          sql`id=(SELECT mailbox_id FROM mailbox_addresses WHERE workspace_id=${w} AND address IN (${recipient},regexp_replace(${recipient},'[+][^@]*@','@')) ORDER BY (address=${recipient}) DESC LIMIT 1)`,
        ),
      );
    if (!box || box.kind === 'inbox' || box.expiresAt)
      throw new ApiError(422, 'FORWARD_SENDER_REQUIRED', 'Forward from a permanent receiving address.');
    if (
      !(await tx.execute(sql`INSERT INTO mail_forward_once VALUES(${w},${m.id},${hook}) ON CONFLICT DO NOTHING RETURNING 1`))
        .rowCount
    )
      return;
    // Reject any incoming loop token (including tokens from other installations). Stricter than three hops.
    await debit(tx, w, 'forward-daily', 1000, 'day');
    await debit(tx, w, 'forward-hourly:' + hook, 200, 'hour');
    const loop = await crypto.subtle.importKey(
      'raw',
      Buffer.from(runtime.config.encryptionKey, 'hex'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const token = Buffer.from(await crypto.subtle.sign('HMAC', loop, new TextEncoder().encode(w + ':' + m.id))).toString(
      'base64url',
    );
    await sendFromMailbox(runtime, tx, {
      actor: { workspaceId: w, keyId: 'forward:' + hook, permissions: ['send'], domains: [] },
      scope: { workspaceId: w },
      mailbox: box,
      from: box.address,
      fromName: `${(
        ((m.verdicts as { handlerVerified?: boolean }).handlerVerified && m.fromName) ||
        m.fromAddress ||
        'Sender'
      )
        .replaceAll('@', ' at ')
        .replace(/[\x00-\x1f<>\x7f]/g, ' ')
        .slice(
          0,
          100,
        )} via ${(box.displayName || box.address.split('@')[0]).replace(/[\x00-\x1f@<>\x7f]/g, ' ').slice(0, 80)}`,
      to: [value],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: 'Fwd: ' + m.subject.slice(0, 200),
      text: (m.text || m.snippet || '(No plain text)').slice(0, 64000),
      screen: true,
      inReplyTo: null,
      references: [],
      autoSubmitted: 'auto-generated',
      headers: [{ name: 'X-Bane-Loop', value: 'v1.1.' + token }],
      attachments: [],
    });
  });
  return { status: 202 };
}
