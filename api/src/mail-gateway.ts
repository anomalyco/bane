/** Private protocol RPC. No OpenAPI/MCP registration. Caller cannot select a workspace,
 * inbox or bucket: the active protocol credential or API-signed object grant supplies it. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, type App, type Runtime } from './core.js';
import { boundRequestBody } from './request-body.js';
import { passwordDigest } from './inbox-passwords.js';
import { receivingPolicy } from './mailbox-ingest-input.js';
import { withMailObjects } from './mail-objects.js';

const bad = () => new ApiError(403, 'PROTOCOL_DENIED', 'Protocol access denied.');
const name = z.string().max(255),
  token = z.string().min(1).max(120);
const login = z.object({
  op: z.literal('login'),
  user: name,
  password: z.string().min(1).max(256),
  protocol: z.enum(['imap', 'smtp']),
});
const read = z.object({ op: z.literal('snapshot'), kid: token, path: name.nullable() });
const edit = z.object({
  op: z.literal('edit'),
  kid: token,
  action: z.enum(['create', 'rename', 'delete', 'subscribe']),
  folder: name,
  path: name.nullable(),
  sub: z.boolean().nullable(),
});
const mutate = z.object({
  op: z.literal('mutate'),
  kid: token,
  action: z.enum(['copy', 'move', 'expunge', 'flags']),
  folder: name,
  to: name.nullable(),
  uids: z.array(z.number().int().positive()).max(5000).nullable(),
  flags: z.array(z.string().max(64)).max(64),
  mode: z.enum(['add', 'remove', 'replace']),
});
const body = z.object({ op: z.literal('body'), handle: z.string().max(8192) });
const append = z.object({
  op: z.literal('append'),
  kid: token,
  folder: name,
  date: z.iso.datetime({ offset: true }),
  flags: z.array(z.string().max(64)).max(64),
  content: z.string().max(55924056),
});
const submit = z.object({
  op: z.literal('submit'),
  kid: token,
  from: z.email(),
  to: z.array(z.email()).min(1).max(50),
  content: z.string().max(22369624),
});
const rpc = z.discriminatedUnion('op', [login, read, edit, mutate, body, append, submit]);
const mac = (key: string, value: string) => createHmac('sha256', key).update(value).digest('hex');
function equal(a: string, b: string) {
  return /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export const principal = (runtime: Runtime, protocol: 'imap' | 'smtp', identity: ReturnType<typeof sql>) =>
  sql`SELECT b.workspace_id AS w,b.id AS b,p.id AS k FROM inbox_app_passwords p JOIN mailboxes b ON b.id=p.inbox_id WHERE ${identity} AND p.revoked_at IS NULL AND ${protocol}=ANY(p.protocols) AND b.kind='inbox' AND b.retention_mode='forever' AND b.delete_after IS NULL AND NOT EXISTS(SELECT FROM mail_grant_objects g WHERE g.kind='protocol' AND g.workspace_id=b.workspace_id AND g.resource=p.id AND NOT mail_receiving_grant(b.workspace_id,g.grant_id,${receivingPolicy(runtime.config)}::jsonb))`;
const folders = sql`(SELECT jsonb_agg(jsonb_build_object('key',f.role,'path',inbox_folder_path(f),'next',f.uid_next,'validity',f.uid_validity,'highest',f.highest_modseq,'subscribed',f.subscribed,'total',f.total,'unseen',f.unseen) ORDER BY role) FROM inbox_folders f WHERE f.inbox_id=a.b)`;
const fields = ['flagged', 'answered', 'draft', 'forwarded', 'junk', 'notJunk', 'mdnSent'] as const;
const names = ['\\Flagged', '\\Answered', '\\Draft', '$Forwarded', '$Junk', '$NotJunk', '$MDNSent'] as const;
type ObjectRef = { w: string; key: string; bucket: string; region: string; exp: number };
function handle(runtime: Runtime, data: ObjectRef) {
  const d = Buffer.from(JSON.stringify(data)).toString('base64url');
  return d + '.' + mac(runtime.config.authSecret, 'mailgw-body:' + d);
}
export function registerMailGateway(app: App) {
  app.post('/internal/v1/mail', async (c) => {
    const runtime = c.env,
      key = runtime.config.mailGatewayToken,
      ts = c.req.header('x-bane-timestamp') ?? '',
      hash = c.req.header('x-bane-content') ?? '',
      signature = c.req.header('x-bane-signature') ?? '';
    if (
      !key ||
      !/^\d{10}$/.test(ts) ||
      Math.abs(Date.now() / 1000 - Number(ts)) > 60 ||
      !/^\w{64}$/.test(hash) ||
      !equal(signature, mac(key, `POST\n/internal/v1/mail\n${ts}\n${hash}`))
    )
      throw bad();
    await boundRequestBody(c, 56 * 1024 * 1024);
    const raw = await c.req.text();
    if (createHash('sha256').update(raw).digest('hex') !== hash) throw bad();
    const q = rpc.safeParse(JSON.parse(raw));
    if (!q.success) throw new ApiError(422, 'INVALID_REQUEST', 'Invalid protocol RPC.');
    const p = q.data;
    if (p.op === 'login') {
      const auth = principal(runtime, p.protocol, sql`p.hash=${passwordDigest(runtime.config.authSecret, p.password)}`);
      const { rows } = await runtime.db.execute(
        sql`WITH a AS (${auth}) SELECT a.k AS kid,a.b AS inbox,ARRAY(SELECT address FROM mailbox_addresses WHERE mailbox_id=a.b AND workspace_id=a.w) AS addresses,${folders} AS folders FROM a WHERE a.b=${p.user} OR EXISTS(SELECT FROM mailbox_addresses WHERE mailbox_id=a.b AND workspace_id=a.w AND address=lower(${p.user}))`,
      );
      if (!rows[0]) throw bad();
      return c.json(rows[0]);
    }
    if (p.op === 'body') {
      const [d, s] = p.handle.split('.');
      if (!d || !s || !equal(s, mac(runtime.config.authSecret, 'mailgw-body:' + d))) throw bad();
      const v = JSON.parse(Buffer.from(d, 'base64url').toString()) as ObjectRef;
      if (v.exp < Date.now()) throw bad();
      const stream = await withMailObjects(runtime, v.w, v.region, v.bucket, (o) => o.get(v.key));
      if (!stream) throw new ApiError(404, 'MISSING_BODY', 'Body unavailable.');
      return new Response(stream, { headers: { 'content-type': 'application/octet-stream' } });
    }
    if (p.op === 'append' || p.op === 'submit') {
      const { contentWrite } = await import('./protocol-content.js');
      return c.json(await contentWrite(c, p));
    }
    const auth = principal(runtime, 'imap', sql`p.id=${p.kid}`);
    if (p.op === 'snapshot') {
      type E = {
        uid: number;
        modseq: number;
        date: string;
        bits: number;
        seen: boolean;
        deleted: boolean;
        labels: string[];
        size: number;
        key: string | null;
        bucket: string | null;
        region: string;
        mid: string;
      };
      const r = (
        await runtime.db.execute<{ w: string; folders: unknown; entries: E[] }>(
          sql`WITH a AS (${auth}) SELECT a.w,${folders} folders,coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY uid) FROM (SELECT e.uid,e.modseq,e.internal_date AS date,l.flags bits,l.read seen,e.deleted,l.labels,coalesce(m.size_bytes,0) size,m.raw_key key,m.raw_bucket bucket,m.region,m.id mid FROM inbox_folders f JOIN inbox_entries e USING(inbox_id,role) JOIN mailbox_messages l ON l.mailbox_id=e.inbox_id AND l.message_id=e.message_id JOIN mail_messages m ON m.id=l.message_id AND m.workspace_id=a.w WHERE e.inbox_id=a.b AND inbox_folder_path(f)=${p.path} AND l.held_reason IS NULL ORDER BY uid LIMIT 50001)x),'[]') AS entries FROM a`,
        )
      ).rows[0];
      if (!r) throw bad();
      if (r.entries.length > 50000) throw new ApiError(413, 'FOLDER_LIMIT', 'Folder exceeds snapshot limit.');
      return c.json({
        folders: r.folders,
        entries: r.entries.map((e) => ({
          uid: e.uid,
          modseq: e.modseq,
          date: e.date,
          size: e.size,
          flags: [
            ...e.labels.filter((l) => /^[A-Za-z0-9_$-]{1,64}$/.test(l)),
            ...names.filter((_, i) => e.bits & (1 << i)),
            ...(e.seen ? ['\\Seen'] : []),
            ...(e.deleted ? ['\\Deleted'] : []),
          ],
          handle:
            e.key && e.bucket
              ? handle(runtime, { w: r.w, key: e.key, bucket: e.bucket, region: e.region, exp: Date.now() + 300000 })
              : null,
        })),
      });
    }
    if (p.op === 'edit') {
      const row = (
        await runtime.db.execute<{ r: { error?: string } }>(
          sql`WITH a AS (${auth}) SELECT inbox_edit_folder(a.w,a.b,${p.action},${p.folder},${p.path},${p.sub}) r FROM a`,
        )
      ).rows[0];
      if (!row) throw bad();
      if (row.r.error) throw new ApiError(409, 'FOLDER_REFUSED', 'Folder mutation refused.');
      return c.json(row.r);
    }
    // A single statement takes the phase-2 inbox fence, resolves UIDs and performs the batch.
    const flags = Object.fromEntries(
      [...fields, 'read', 'deleted'].flatMap((k, i) => {
        const on = p.flags.some(
          (f) => f.toLowerCase() === (names[i] ?? (i === 7 ? '\\Seen' : '\\Deleted')).toLowerCase(),
        );
        return p.mode === 'replace' || on ? [[k, on && p.mode !== 'remove']] : [];
      }),
    );
    const labels = p.flags.filter(
      (x) => !x.startsWith('\\') && !names.some((n) => n.toLowerCase() === x.toLowerCase()),
    );
    if (labels.some((x) => !/^[$\w-]{1,64}$/.test(x) || ['unverified', 'spam', 'guard-allowed'].includes(x)))
      throw new ApiError(422, 'INVALID_FLAG', 'Invalid keyword.');
    const row = (
      await runtime.db.execute<{ r: { pairs: number[][]; validity: number; error?: string } }>(
        sql`WITH a AS (${auth}) SELECT mailgw_mutate(a.w,a.b,${p.folder},${p.to},${p.action},${sql.param(p.uids)}::bigint[],${p.mode},${JSON.stringify(flags)}::jsonb,${sql.param(labels)}::text[]) r FROM a`,
      )
    ).rows[0];
    if (!row) throw bad();
    if (row.r.error) throw new ApiError(409, 'MUTATION_REFUSED', 'Mutation refused.');
    return c.json(row.r);
  });
}
