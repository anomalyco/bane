import { gatewayLane } from './protocol-admission.js';
/** Private protocol RPC. No OpenAPI/MCP registration. Caller cannot select a workspace,
 * inbox or bucket: the active protocol credential or API-signed object grant supplies it. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, type App, type Runtime } from './core.js';
import { boundRequestBody } from './request-body.js';
import { passwordDigest } from './inbox-passwords.js';
import { receivingPolicy } from './mailbox-ingest-input.js';
import { readMailBytes, withMailObjects } from './mail-objects.js';

const bad = () => new ApiError(403, 'PROTOCOL_DENIED', 'Protocol access denied.');
const name = z.string().max(255),
  token = z.string().min(1).max(120);
const login = z.object({
  op: z.literal('login'),
  user: name,
  password: z.string().min(1).max(256),
  protocol: z.enum(['imap', 'smtp']),
});
const read = z.object({
  op: z.literal('snapshot'),
  kid: token,
  path: name.nullable(),
  since: z.number().int().nonnegative().default(0),
  after: z.number().int().nonnegative().default(0),
});
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
const body = z.object({
  op: z.literal('body'),
  kid: token,
  handle: z.string().max(8192),
  headers: z.boolean().optional(),
});
const subjectSearch = z.object({
  op: z.literal('subject'),
  kid: token,
  folder: name,
  term: z.string().min(1).max(1024),
});
const submit = z.object({
  op: z.literal('submit'),
  kid: token,
  from: z.email(),
  to: z.array(z.email()).min(1).max(50),
  content: z.string().max(22369624),
});
const projections = z.object({
  op: z.literal('projections'),
  kid: token,
  folder: name,
  uids: z.array(z.number().int().positive()).min(1).max(256),
});
const rpc = z.discriminatedUnion('op', [login, read, edit, mutate, body, subjectSearch, submit, projections]);
const mac = (key: string, value: string) => createHmac('sha256', key).update(value).digest('hex');
function equal(a: string, b: string) {
  return /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export const principal = (runtime: Runtime, protocol: 'imap' | 'smtp', identity: ReturnType<typeof sql>) =>
  sql`SELECT b.workspace_id AS w,b.id AS b,p.id AS k FROM inbox_app_passwords p JOIN mailboxes b ON b.id=p.inbox_id WHERE ${identity} AND p.revoked_at IS NULL AND ${protocol}=ANY(p.protocols) AND b.kind='inbox' AND b.retention_mode='forever' AND b.delete_after IS NULL AND NOT EXISTS(SELECT FROM mail_grant_objects g WHERE g.kind='protocol' AND g.workspace_id=b.workspace_id AND g.resource=p.id AND NOT mail_receiving_grant(b.workspace_id,g.grant_id,${receivingPolicy(runtime.config)}::jsonb))`;
const folders = sql`(SELECT jsonb_agg(jsonb_build_object('key',f.role,'path',inbox_folder_path(f),'next',f.uid_next,'validity',f.uid_validity,'highest',f.highest_modseq,'subscribed',f.subscribed,'total',f.total,'unseen',f.unseen) ORDER BY role) FROM inbox_folders f WHERE f.inbox_id=a.b)`;
const fields = ['flagged', 'answered', 'draft', 'forwarded', 'junk', 'notJunk', 'mdnSent'] as const;
const names = ['\\Flagged', '\\Answered', '\\Draft', '$Forwarded', '$Junk', '$NotJunk', '$MDNSent'] as const;
type ObjectRef = {
  w: string;
  kid: string;
  mid: string;
  key: string;
  bucket: string;
  region: string;
  header: number | null;
  size: number;
  exp: number;
};
function handle(runtime: Runtime, data: ObjectRef) {
  const d = Buffer.from(JSON.stringify(data)).toString('base64url');
  return d + '.' + mac(runtime.config.authSecret, 'mailgw-body:' + d);
}
export function registerMailGateway(app: App) {
  app.post('/internal/v1/mail', async (c) => {
    const runtime = c.env,
      hash = c.req.header('x-bane-content') ?? '';
    if (!gatewayLane(c.req.method, c.req.path, c.req.raw.headers, runtime.config.mailGatewayToken)) throw bad();
    const meta = c.req.header('x-bane-append');
    if (meta !== undefined) {
      const { streamedAppend } = await import('./protocol-append.js');
      return c.json(await streamedAppend(c, meta, hash));
    }
    await boundRequestBody(c, 23 * 1024 * 1024);
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
      if (v.kid !== p.kid) throw bad();
      if (v.exp < Date.now()) {
        // Recheck only this immutable object. Do not rebuild a large folder just to renew a grant.
        const auth = principal(runtime, 'imap', sql`p.id=${p.kid}`);
        const found = await runtime.db.execute(
          sql`WITH a AS (${auth}) SELECT FROM a JOIN mailbox_messages l ON l.mailbox_id=a.b AND l.workspace_id=a.w JOIN mail_messages m ON m.id=l.message_id AND m.workspace_id=a.w WHERE l.held_reason IS NULL AND m.id=${v.mid} AND m.raw_key=${v.key} AND m.raw_bucket=${v.bucket}`,
        );
        if (!found.rowCount) throw bad();
      }
      const length = Math.min(v.size, v.header ?? 65536);
      if (p.headers && length > 65536) throw new ApiError(413, 'HEADER_LIMIT', 'Header too large.');
      if (p.headers && !length) return new Response(null);
      const stream = await withMailObjects(runtime, v.w, v.region, v.bucket, (o) =>
        o.get(v.key, p.headers ? { offset: 0, length } : undefined),
      );
      if (!stream) throw new ApiError(404, 'MISSING_BODY', 'Body unavailable.');
      if (p.headers && v.header === null) {
        const bytes = Buffer.from(await readMailBytes(stream, length, 65536));
        const end = bytes.indexOf('\r\n\r\n');
        if (end < 0 && v.size > length && !bytes.subarray(0, 2).equals(Buffer.from('\r\n')))
          throw new ApiError(413, 'HEADER_LIMIT', 'Header too large.');
        const n = bytes.subarray(0, 2).equals(Buffer.from('\r\n')) ? 2 : end < 0 ? length : end + 4;
        return new Response(bytes.subarray(0, n), { headers: { 'content-type': 'application/octet-stream' } });
      }
      return new Response(stream, { headers: { 'content-type': 'application/octet-stream' } });
    }
    if (p.op === 'submit') {
      const { contentWrite } = await import('./protocol-content.js');
      return c.json(await contentWrite(c, p));
    }
    const auth = principal(runtime, 'imap', sql`p.id=${p.kid}`);
    if (p.op === 'projections') {
      const { previewPage } = await import('./protocol-preview.js');
      const row = (
        await runtime.db.execute<{ w: string; items: Parameters<typeof previewPage>[2] }>(
          sql`WITH a AS (${auth}) SELECT a.w,ARRAY(SELECT jsonb_build_object('uid',e.uid,'mid',m.id,'key',m.raw_key,'bucket',m.raw_bucket,'region',m.region,'size',m.size_bytes,'header',m.mime->'headerLength','raw',v.prefix,'complete',v.complete) FROM inbox_entries e JOIN mailbox_messages l ON l.mailbox_id=e.inbox_id AND l.message_id=e.message_id JOIN mail_messages m ON m.id=e.message_id AND m.workspace_id=a.w LEFT JOIN mailgw_previews v ON v.mid=m.id AND v.object_key=m.raw_key WHERE l.held_reason IS NULL AND e.inbox_id=a.b AND e.role=${p.folder} AND e.uid=ANY(${sql.param(p.uids)}::bigint[])) AS items FROM a`,
        )
      ).rows[0];
      if (!row) throw bad();
      return c.json(await previewPage(runtime, row.w, row.items));
    }
    if (p.op === 'subject') {
      const row = (
        await runtime.db.execute<{ uids: number[] }>(
          sql`WITH a AS (${auth}) SELECT ARRAY(SELECT e.uid::float8 FROM inbox_entries e JOIN mailbox_messages l ON l.mailbox_id=e.inbox_id AND l.message_id=e.message_id JOIN mail_messages m ON m.id=e.message_id AND m.workspace_id=a.w WHERE e.inbox_id=a.b AND l.held_reason IS NULL AND e.role=${p.folder} AND strpos(lower(m.subject),lower(${p.term}))>0 ORDER BY uid LIMIT 100001) uids FROM a`,
        )
      ).rows[0];
      if (!row) throw bad();
      if (row.uids.length > 100000) throw new ApiError(413, 'SEARCH_LIMIT', 'Narrow the search.');
      return c.json(row.uids);
    }
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
        header: number | null;
      };
      const r = (
        await runtime.db.execute<{ w: string; folders: unknown; entries: E[]; gone: { uid: number }[]; floor: string }>(
          sql`WITH a AS (${auth}) SELECT a.w,${folders} folders,(SELECT changes_floor::text FROM inbox_state WHERE inbox_id=a.b) floor,coalesce((SELECT jsonb_agg(x ORDER BY uid) FROM (SELECT v.uid FROM inbox_vanished v JOIN inbox_folders f USING(inbox_id,role) WHERE ${p.since}::bigint>0 AND v.inbox_id=a.b AND inbox_folder_path(f)=${p.path} AND v.modseq>${p.since} AND v.uid>${p.after} ORDER BY uid LIMIT 2049)x),'[]') AS gone,coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY uid) FROM (SELECT e.uid,e.modseq,e.internal_date AS date,l.flags bits,l.read seen,e.deleted,l.labels,coalesce(m.size_bytes,0) size,m.raw_key key,m.raw_bucket bucket,m.region,m.id mid,(m.mime->>'headerLength')::int header FROM inbox_folders f JOIN inbox_entries e USING(inbox_id,role) JOIN mailbox_messages l ON l.mailbox_id=e.inbox_id AND l.message_id=e.message_id JOIN mail_messages m ON m.id=l.message_id AND m.workspace_id=a.w WHERE e.inbox_id=a.b AND inbox_folder_path(f)=${p.path} AND l.held_reason IS NULL AND e.uid>${p.after} AND e.modseq>${p.since} ORDER BY uid LIMIT 2049)x),'[]') AS entries FROM a`,
        )
      ).rows[0];
      if (!r) throw bad();
      const next = Math.min(
        r.entries.length > 2048 ? r.entries[2047]!.uid : Infinity,
        r.gone.length > 2048 ? r.gone[2047]!.uid : Infinity,
      );
      const gone = r.gone.filter((v) => v.uid <= next).map((v) => v.uid);
      return c.json({
        folders: r.folders,
        floor: Number(r.floor),
        gone,
        more: Number.isFinite(next) ? next : null,
        entries: r.entries
          .filter((e) => e.uid <= next)
          .map((e) => ({
            uid: e.uid,
            modseq: e.modseq,
            date: e.date,
            size: e.size,
            flags: [
              ...e.labels.filter(
                (l) => /^[A-Za-z0-9_$-]{1,64}$/.test(l) && !['unverified', 'spam', 'guard-allowed'].includes(l),
              ),
              ...names.filter((_, i) => e.bits & (1 << i)),
              ...(e.seen ? ['\\Seen'] : []),
              ...(e.deleted ? ['\\Deleted'] : []),
            ],
            handle:
              e.key && e.bucket
                ? handle(runtime, {
                    w: r.w,
                    kid: p.kid,
                    mid: e.mid,
                    key: e.key,
                    bucket: e.bucket,
                    region: e.region,
                    header: e.header,
                    size: e.size,
                    exp: Date.now() + 300000,
                  })
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
