import { createRoute, z } from '@hono/zod-openapi';
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ApiError, errors, id, json, response, security, type App, type Ctx, type MailboxAccess } from './core.js';

export function passwordDigest(pepper: string, value: string) {
  return createHmac('sha256', hkdfSync('sha256', pepper, '', 'bane:protocol-password:v1', 32))
    .update(value.replace(/[ -]/g, '').toLowerCase())
    .digest('hex');
}
const protocol = z.enum(['imap', 'smtp']);
const item = z.object({ id: z.string(), name: z.string(), protocols: z.array(protocol), createdAt: z.string() });
const base = '/v1/inboxes/{id}/app-passwords',
  params = z.object({ id: z.string().min(1).max(120) }),
  meta = { tags: ['Agent inboxes'], security };
export function registerInboxPasswords(app: App, access: (c: Ctx) => MailboxAccess) {
  const manager = (c: Ctx, issue = false) => {
    const v = access(c);
    if (!v.admin || v.mailboxIds || c.get('actor')?.role === 'member')
      throw new ApiError(403, 'ADMIN_REQUIRED', 'An unrestricted workspace manager must grant mail client access.');
    // A password outlives the token that asks for it, like an API key or an inbound key.
    if (issue && c.get('actor')?.credential === 'agentToken')
      throw new ApiError(403, 'CREDENTIAL_DELEGATION_FORBIDDEN', 'Temporary agent tokens cannot create mail client passwords.');
    return v.workspaceId;
  };
  app.openapi(
    createRoute({
      ...meta,
      method: 'post',
      path: base,
      operationId: 'createInboxAppPassword',
      summary:
        'Grant mail client access to a persistent inbox. Password shown once; a billable day starts immediately.',
      request: {
        params,
        body: json(
          z
            .object({
              name: z.string().trim().min(1).max(100),
              protocols: z.array(protocol).min(1).max(2),
              perDay: z.number().int().min(1).max(2000).optional(),
              perMonth: z.number().int().min(1).max(62000).optional(),
            })
            .strict(),
        ),
      },
      responses: { 201: response(item.extend({ password: z.string() })), ...errors },
    }),
    async (c) => {
      const wid = manager(c, true),
        bid = c.req.valid('param').id,
        q = c.req.valid('json'),
        kid = id('app'),
        password = Buffer.from(randomBytes(16)).toString('hex').match(/.{4}/g)!.join('-'),
        hash = passwordDigest(c.env.config.authSecret, password),
        protocols = [...new Set(q.protocols)];
      const actor = c.get('actor');
      const grant = actor?.grantId ?? null;
      const { rows } = await c.env.db.execute<{ created: string }>(
        sql`WITH allowed AS (UPDATE inbox_state s SET protocol_passwords=protocol_passwords+1, protocol_daily=coalesce(${q.perDay ?? null}::int,protocol_daily),protocol_monthly=coalesce(${q.perMonth ?? null}::int,protocol_monthly) FROM mailboxes b WHERE b.id=s.inbox_id AND b.workspace_id=${wid} AND b.id=${bid} AND b.kind='inbox' AND b.retention_mode='forever' AND b.delete_after IS NULL AND inbox_lock_visible(b.workspace_id,b.id,true) AND protocol_passwords<20 RETURNING s.inbox_id), issued AS (INSERT INTO inbox_app_passwords(id,inbox_id,name,hash,protocols) SELECT ${kid},inbox_id,${q.name},${hash},${sql.param(protocols)}::text[] FROM allowed RETURNING id,created_at), bound AS (INSERT INTO mail_grant_objects SELECT ${grant}::text,${wid},'protocol',id FROM issued WHERE ${grant}::text IS NOT NULL) SELECT created_at::text AS created FROM issued`,
      );
      if (!rows.length)
        throw new ApiError(
          409,
          'INBOX_UNAVAILABLE',
          'Choose an active persistent inbox with fewer than 20 app passwords.',
        );
      c.header('Cache-Control', 'no-store');
      return c.json({ id: kid, name: q.name, protocols, password, createdAt: rows[0]!.created }, 201);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path: base,
      operationId: 'listInboxAppPasswords',
      summary: 'List active app passwords without their secrets',
      request: { params },
      responses: { 200: response(z.object({ data: z.array(item) })), ...errors },
    }),
    async (c) => {
      const wid = manager(c),
        bid = c.req.valid('param').id;
      const r = await c.env.db.execute<z.infer<typeof item>>(
        sql`SELECT p.id,name,protocols,created_at::text AS "createdAt" FROM inbox_app_passwords p JOIN inbox_state s USING(inbox_id) WHERE s.workspace_id=${wid} AND inbox_id=${bid} AND revoked_at IS NULL ORDER BY created_at`,
      );
      return c.json({ data: r.rows }, 200);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'delete',
      path: base + '/{passwordId}',
      operationId: 'revokeInboxAppPassword',
      summary: 'Revoke a mail client password and invalidate sessions',
      request: { params: params.extend({ passwordId: z.string().min(1).max(120) }) },
      responses: { 200: response(z.object({ revoked: z.boolean() })), ...errors },
    }),
    async (c) => {
      const wid = manager(c),
        { id, passwordId } = c.req.valid('param');
      const { rows } = await c.env.db.execute<{ ok: boolean }>(
        sql`SELECT inbox_revoke_password(${wid},${id},${passwordId}) ok`,
      );
      if (!rows[0]?.ok) throw new ApiError(404, 'NOT_FOUND', 'No such active password.');
      return c.json({ revoked: true }, 200);
    },
  );
}
