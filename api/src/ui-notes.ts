import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { ApiError, digest, errors, id, json, logError, notFound, randomSecret, response, security, timed, type App, type Ctx, type DbExecutor, type Runtime } from './core.js';
import { auditContext, auditInsert, operatorRequired, type AuditContext } from './audit.js';
import { operatorActor } from './operator.js';
import { uiNotesAllowed } from './operator-identity.js';
import { ownSecretPattern, secretPrefixes, shownPrefix } from './brand.js';

// UI notes: Nightmail staff (the platform operator role, #115) ⌘-click anything in the dashboard and leave a design or bug
// note on it, with where it was, a locator for the element, its computed styles and a screenshot crop; an agent lists
// the open ones, fixes them and sets their status (scripts/ui-notes.ts). Notes are about the app, so they belong to the
// deployment, not a workspace. Every change is in the audit trail (internal rows: workspace null, the operator as user).
//
// Who: only the people in UI_NOTES_SUBJECTS (by issuer subject; today Ryan alone), and only while they hold the
// operator role. Every other operator gets 404 on every route, and so does everyone when the list is empty: the
// feature is off. A script uses a UI notes key (nm_notes_…), made by such a person for themself: it works only on GET
// /v1/operator/ui-notes[/{id}] and PATCH /v1/operator/ui-notes/{id} (status, PR link and resolution), only while its
// operator still holds the operator role, and never for anything else (support.ts operatorGate admits it on exactly
// those routes; every other operator route still refuses any bearer token).
//
// Screenshots are private objects in the attachments bucket (ui-notes/<note id>), served only through a signed link
// that expires after five minutes (GET /v1/ui-notes/screenshots/<token>): the dashboard's <img> and the script read it
// without a credential, and an expired, forged or deleted note's link is a 404.
// Hidden from the public OpenAPI document, SDK and llms docs (hide: true).

const tags = ['Operator'];
const Kind = z.enum(['alignment', 'spacing', 'copy', 'bug', 'motion', 'mobile', 'other']);
const Severity = z.enum(['low', 'medium', 'high']);
const Status = z.enum(['open', 'in_progress', 'fixed', 'wontfix']);
const NoteId = z.string().regex(/^uin_[0-9a-f]{32}$/);
const KeyIdParam = z.object({ id: z.string().regex(/^unk_[0-9a-f]{32}$/) });
const Text = (max: number) => z.string().max(max);
const Box = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0), height: z.number().finite().min(0), scrollX: z.number().finite(), scrollY: z.number().finite() }).strict();
const Element = z.object({
  selector: Text(1000).min(1).describe('A CSS selector that finds the element again.'),
  alternatives: z.array(Text(1000).min(1)).max(6).default([]).describe('Other selectors for it, most specific first.'),
  testId: Text(200).nullable().default(null), component: Text(120).nullable().default(null).describe('The nearest component: data-component, or a React name in development builds.'),
  components: z.array(Text(120)).max(8).default([]).describe('Enclosing components, outermost first.'),
  tag: Text(40).min(1), role: Text(60).nullable().default(null), label: Text(300).nullable().default(null), text: Text(300).nullable().default(null).describe('Its text, truncated, with addresses masked.'),
  box: Box.describe('Its bounding box in CSS pixels (viewport coordinates) and the page scroll.'),
  styles: z.record(z.string().regex(/^[a-z-]{1,40}$/), Text(200)).refine(styles => Object.keys(styles).length <= 40, 'At most 40 styles.').describe('Computed styles: font, size, line height, padding, margin, colour, alignment.'),
}).strict();
const Context = z.object({
  viewport: z.object({ width: z.number().int().min(0).max(100_000), height: z.number().int().min(0).max(100_000) }).strict(),
  dpr: z.number().finite().min(0).max(16), theme: z.enum(['light', 'dark']), device: z.enum(['phone', 'tablet', 'desktop']), pointer: z.enum(['fine', 'coarse']),
  build: Text(64).min(1).describe('The dashboard build (commit) the note was left on.'), title: Text(200).optional(),
}).strict();
const Person = z.object({ id: z.string(), name: z.string().nullable() }).nullable();
const Screenshot = z.object({ url: z.string().describe('A signed link, valid for five minutes.'), expiresAt: z.string(), contentType: z.string(), bytes: z.number().int(), width: z.number().int().nullable(), height: z.number().int().nullable() }).nullable();
const Note = z.object({
  id: z.string(), body: z.string(), kind: Kind, severity: Severity.nullable(), status: Status, prUrl: z.string().nullable(), resolution: z.string().nullable(),
  page: z.object({ url: z.string(), path: z.string(), route: z.string().describe('The route pattern, IDs replaced (/campaigns/:id/edit): pins match on it.') }),
  context: Context, element: Element, screenshot: Screenshot, author: Person, updatedBy: Person,
  createdAt: z.string(), updatedAt: z.string(), resolvedAt: z.string().nullable(),
}).openapi('UiNote');
type NoteView = z.infer<typeof Note>;
const NoteKey = z.object({ id: z.string(), name: z.string(), prefix: z.string(), createdAt: z.string(), expiresAt: z.string(), lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable() }).openapi('UiNoteKey');

// Addresses never leave the page in full (lib/private-address.ts in the dashboard masks them before sending): this is
// the API's own pass over everything captured, encoded addresses in URLs included. So is removing anything that looks
// like a credential: a note can't be left inside a secret-bearing screen (data-sensitive), and this catches a secret
// shown anywhere else. The same patterns as the dashboard's lib/capture-text.ts. The note's own text is the author's.
const ADDRESS = /[^\s<>()[\]"',;:/?#&=]+(?:@|%40)[^\s<>()[\]"',;:/?#&=]+\.[^\s<>()[\]"',;:/?#&=]+/gi;
export const maskAddresses = (value: string) => value.replace(ADDRESS, match => [...match].slice(0, 2).join('') + '•••');
const SECRET = [
  ownSecretPattern, /\bwhsec_[A-Za-z0-9+/=_-]{12,}/g, /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, /\b(?:sk|rk)_[A-Za-z0-9]{20,}/g,
  /\b(?:cus|pi|pm|seti|sub|in|ch|cs|acct|price|prod|si|txn|re|po|evt)_(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{14,}/g, /\b(?:[0-9a-f]{4}-){7}[0-9a-f]{4}\b/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];
const RESOURCE_ID = /^[a-z]{2,8}_[0-9a-f]{32}$/;
const entropy = (text: string) => { const counts = new Map<string, number>(); for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1); let bits = 0; for (const n of counts.values()) { const p = n / text.length; bits -= p * Math.log2(p); } return bits; };
const highEntropy = (run: string) => run.length >= 32 && /\d/.test(run) && /[A-Za-z]/.test(run) && !RESOURCE_ID.test(run) && (/^[0-9a-f]+$/i.test(run) || entropy(run) >= 3.5);
/** Text with every credential-looking run (Nightmail keys, webhook secrets, Stripe keys, app passwords, JWTs, long random tokens) replaced. */
export function redactSecrets(input: string) {
  // Invisible characters (U+FEFF, zero-width spaces and joiners, soft hyphens, bidi marks) render as nothing, so they
  // would hide carol\uFEFF@example.net from both patterns: they are dropped first.
  const text = input.replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu, '');
  const spans: [number, number][] = [];
  for (const pattern of SECRET) for (const match of text.matchAll(pattern)) spans.push([match.index, match.index + match[0].length]);
  for (const match of text.matchAll(/[A-Za-z0-9_+=-]{32,}/g)) if (highEntropy(match[0])) spans.push([match.index, match.index + match[0].length]);
  let out = '', from = 0;
  for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) { if (end <= from) continue; out += text.slice(from, Math.max(from, start)) + '[secret]'; from = end; }
  return out + text.slice(from);
}
function masked<T>(value: T): T {
  if (typeof value === 'string') return maskAddresses(redactSecrets(value)) as T;
  if (Array.isArray(value)) return value.map(masked) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, masked(entry)])) as T;
  return value;
}

// ---------- screenshot links ----------

const SHOT_SECONDS = 300;
const shotKeys = new Map<string, Buffer>();
const shotTag = (secret: string, data: string) => {
  const key = shotKeys.get(secret) ?? Buffer.from(hkdfSync('sha256', secret, '', 'bane:ui-note-screenshot:v1', 32));
  shotKeys.set(secret, key);
  return createHmac('sha256', key).update(data).digest('base64url');
};
/** A link to a note's screenshot that works without a credential for five minutes. */
export function screenshotLink(runtime: Pick<Runtime, 'config'>, noteId: string, key: string, now = Date.now()) {
  const e = Math.floor(now / 1000) + SHOT_SECONDS, data = Buffer.from(JSON.stringify({ n: noteId, k: key, e })).toString('base64url');
  return { url: `${runtime.config.publicUrl}/v1/ui-notes/screenshots/${data}.${shotTag(runtime.config.authSecret, data)}`, expiresAt: new Date(e * 1000).toISOString() };
}
const IMAGE_TYPES = { 'image/webp': (b: Uint8Array) => b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP',
  'image/png': (b: Uint8Array) => b.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v),
  'image/jpeg': (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff } as const;
type ImageType = keyof typeof IMAGE_TYPES;
const MAX_SHOT_BYTES = 2 * 1024 * 1024;
const shotKey = (noteId: string) => `ui-notes/${noteId}`;

// ---------- who ----------

type Caller = { userId: string; context: AuditContext; key: boolean };
/** An allowed operator (sessionOperator), or the UI notes key the gate admitted (its owner is checked the same way). */
async function caller(c: Ctx): Promise<Caller> {
  const a = c.get('actor');
  if (a?.credential === 'uiNotesKey' && a.userId) return { userId: a.userId, key: true, context: auditContext(c) };
  return sessionOperator(c);
}
/**
 * A signed-in operator (the operator role) whose issuer subject is in UI_NOTES_SUBJECTS: creating, deleting, screenshots
 * and keys. Any other operator, and everyone when the list is empty, gets 404, as if the routes weren't there. A key
 * gets 403 (operatorActor).
 */
async function sessionOperator(c: Ctx): Promise<Caller> {
  const operator = await operatorActor(c, 'operator:read');
  if (!(await uiNotesAllowed(c.env.db, c.env.config.uiNotesSubjects, operator.userId))) notFound('Endpoint');
  return { userId: operator.userId, key: false, context: { ...auditContext(c), actor: { type: 'operator', id: operator.userId, userId: operator.userId, via: 'console' } } };
}

/** The only requests a UI notes key may make: list and read notes, and change one (support.ts operatorGate). */
export const notesKeyRoute = (method: string, path: string) =>
  (method === 'GET' && /^\/v1\/operator\/ui-notes(?:\/uin_[0-9a-f]{32})?$/.test(path)) || (method === 'PATCH' && /^\/v1\/operator\/ui-notes\/uin_[0-9a-f]{32}$/.test(path));
const NOTES_KEY = /^Bearer ((?:nm|bane)_notes_[0-9a-f]{64})$/; // bane_: remove after rename cleanup
/**
 * Authenticates a UI notes key for operatorGate, or refuses with the gate's own 403: a live, unexpired, unrevoked key
 * whose operator still holds the operator role, within its minute budget. One statement reads and touches it.
 */
export async function authenticateNotesKey(c: Ctx) {
  const token = NOTES_KEY.exec(c.req.header('authorization') ?? '')?.[1], subjects = c.env.config.uiNotesSubjects ?? [];
  if (!token || !subjects.length) throw operatorRequired();
  const hash = await digest(token);
  const { rows: [key] } = await timed(c, 'notes-key-db', () => c.env.db.execute<{ id: string; user_id: string; name: string | null }>(sql`WITH k AS (
      SELECT k.id, k.user_id, u.name FROM ui_note_keys k JOIN platform_operators p ON p.user_id = k.user_id AND p.role = 'operator' JOIN bane_users u ON u.id = k.user_id
      WHERE k.hash = ${hash} AND k.revoked_at IS NULL AND k.expires_at > now()
        AND EXISTS (SELECT FROM bane_oidc_identities i WHERE i.user_id = k.user_id AND (i.issuer, i.subject) IN (${sql.join(subjects.map(s => sql`(${s.issuer}, ${s.subject})`), sql`, `)}))
    ), touched AS (UPDATE ui_note_keys t SET last_used_at = now() FROM k WHERE t.id = k.id AND (t.last_used_at IS NULL OR t.last_used_at < now() - interval '1 minute'))
    SELECT * FROM k`));
  if (!key) throw operatorRequired();
  const { chargeGrantBudget, checkBudget } = await import('./auth.js');
  checkBudget(c, await timed(c, 'budget-db', () => chargeGrantBudget(c.env, 'platform', key.id)), c.env.config.apiRateLimitPerMinute);
  c.set('actor', { workspaceId: '', permissions: [], domains: [], keyId: key.id, credential: 'uiNotesKey', userId: key.user_id, name: key.name ?? undefined });
}

// ---------- reading ----------

const isoAt = (column: ReturnType<typeof sql>) => sql`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const noteColumns = sql`n.id, n.body, n.kind, n.severity, n.status, n.pr_url, n.resolution, n.url, n.path, n.route, n.context, n.element, n.screenshot_key, n.screenshot,
  ${isoAt(sql`n.created_at`)} AS created_at, ${isoAt(sql`n.updated_at`)} AS updated_at, ${isoAt(sql`n.resolved_at`)} AS resolved_at,
  CASE WHEN n.author_id IS NOT NULL THEN json_build_object('id', n.author_id, 'name', (SELECT name FROM bane_users WHERE id = n.author_id)) END AS author,
  CASE WHEN n.updated_by IS NOT NULL THEN json_build_object('id', n.updated_by, 'name', (SELECT name FROM bane_users WHERE id = n.updated_by)) END AS updated_by_person`;
type NoteRow = { id: string; body: string; kind: NoteView['kind']; severity: NoteView['severity']; status: NoteView['status']; pr_url: string | null; resolution: string | null; url: string; path: string; route: string;
  context: NoteView['context']; element: NoteView['element']; screenshot_key: string | null; screenshot: { contentType: string; bytes: number; width: number | null; height: number | null } | null;
  created_at: string; updated_at: string; resolved_at: string | null; author: NoteView['author']; updated_by_person: NoteView['updatedBy'] };
function view(runtime: Pick<Runtime, 'config'>, row: NoteRow): NoteView {
  return { id: row.id, body: row.body, kind: row.kind, severity: row.severity, status: row.status, prUrl: row.pr_url, resolution: row.resolution,
    page: { url: row.url, path: row.path, route: row.route }, context: row.context, element: row.element,
    screenshot: row.screenshot_key && row.screenshot ? { ...screenshotLink(runtime, row.id, row.screenshot_key), contentType: row.screenshot.contentType, bytes: row.screenshot.bytes, width: row.screenshot.width ?? null, height: row.screenshot.height ?? null } : null,
    author: row.author, updatedBy: row.updated_by_person, createdAt: row.created_at, updatedAt: row.updated_at, resolvedAt: row.resolved_at };
}
async function loadNote(db: DbExecutor, noteId: string) {
  return (await db.execute<NoteRow>(sql`SELECT ${noteColumns} FROM ui_notes n WHERE n.id = ${noteId}`)).rows[0] ?? notFound('UI note');
}
const list = <T extends z.ZodTypeAny>(item: T) => z.string().max(200).optional().transform((value, ctx) => {
  if (!value) return undefined;
  const parsed = z.array(item).safeParse(value.split(',').map(part => part.trim()).filter(Boolean));
  if (!parsed.success) { ctx.addIssue({ code: 'custom', message: 'Use a comma-separated list of allowed values.' }); return z.NEVER; }
  return parsed.data as z.infer<T>[];
});
const Cursor = z.string().max(200).optional().describe('nextCursor from the previous page.');
function readCursor(cursor?: string) {
  if (!cursor) return null;
  const [at, noteId] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!at || !noteId || !Number.isFinite(Date.parse(at)) || !NoteId.safeParse(noteId).success) throw new ApiError(422, 'INVALID_CURSOR', 'Use nextCursor from the previous page.', 'cursor');
  return { at, id: noteId };
}

// ---------- writing ----------

const CreateNote = z.object({
  body: z.string().trim().min(1).max(4000), kind: Kind, severity: Severity.nullable().default(null),
  url: z.string().max(2000).url().refine(value => /^https?:\/\//i.test(value), 'Use the page’s http(s) URL.'),
  route: z.string().max(300).regex(/^\/\S*$/, 'A route starts with / and has no spaces.'),
  context: Context, element: Element,
}).strict().openapi('CreateUiNote');
const UpdateNote = z.object({
  body: z.string().trim().min(1).max(4000).optional(), kind: Kind.optional(), severity: Severity.nullable().optional(), status: Status.optional(),
  prUrl: z.string().trim().max(500).url().regex(/^https:\/\//, 'Use an https:// link.').nullable().optional().describe('The pull request that fixes it.'),
  resolution: z.string().trim().max(2000).nullable().optional().describe('What was done, or why not.'),
}).strict().refine(value => Object.keys(value).length > 0, 'Change at least one field.').openapi('UpdateUiNote');
const KEY_FIELDS = new Set(['status', 'prUrl', 'resolution']);
const summary = (row: Pick<NoteRow, 'kind' | 'severity' | 'status' | 'pr_url' | 'route'>) => ({ kind: row.kind, severity: row.severity, status: row.status, prUrl: row.pr_url, route: row.route });

export function registerUiNotes(app: App) {
  app.openapi(createRoute({ hide: true, tags, security, method: 'get', path: '/v1/operator/ui-notes', operationId: 'operatorListUiNotes',
    description: 'UI notes across the dashboard, newest first, each with a five-minute screenshot link. A UI notes key may call this.',
    request: { query: z.object({ status: list(Status), kind: list(Kind), route: z.string().max(300).optional(), q: z.string().trim().max(200).optional(), cursor: Cursor, limit: z.coerce.number().int().min(1).max(200).default(100) }) },
    responses: { 200: response(z.object({ data: z.array(Note), nextCursor: z.string().nullable() })), ...errors } }), async c => {
    await caller(c);
    const q = c.req.valid('query'), after = readCursor(q.cursor), search = q.q ? `%${q.q.replace(/[\\%_]/g, m => '\\' + m)}%` : null;
    const { rows } = await c.env.db.execute<NoteRow>(sql`SELECT ${noteColumns} FROM ui_notes n WHERE true
      ${q.status ? sql`AND n.status = ANY(${sql.param(q.status)}::text[])` : sql``} ${q.kind ? sql`AND n.kind = ANY(${sql.param(q.kind)}::text[])` : sql``}
      ${q.route ? sql`AND n.route = ${q.route}` : sql``} ${search ? sql`AND (n.body ILIKE ${search} OR n.path ILIKE ${search})` : sql``}
      ${after ? sql`AND (n.created_at, n.id) < (${after.at}::timestamptz, ${after.id})` : sql``}
      ORDER BY n.created_at DESC, n.id DESC LIMIT ${q.limit + 1}`);
    const page = rows.slice(0, q.limit), last = page.at(-1);
    return c.json({ data: page.map(row => view(c.env, row)), nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.created_at}|${last.id}`).toString('base64url') : null }, 200);
  });
  app.openapi(createRoute({ hide: true, tags, security, method: 'get', path: '/v1/operator/ui-notes/{id}', operationId: 'operatorGetUiNote', description: 'One UI note. A UI notes key may call this.',
    request: { params: z.object({ id: NoteId }) }, responses: { 200: response(Note), ...errors } }), async c => {
    await caller(c);
    return c.json(view(c.env, await loadNote(c.env.db, c.req.valid('param').id)), 200);
  });
  app.openapi(createRoute({ hide: true, tags, security, method: 'post', path: '/v1/operator/ui-notes', operationId: 'operatorCreateUiNote',
    description: 'Leaves a note on an element of the dashboard. Upload its screenshot next with PUT /v1/operator/ui-notes/{id}/screenshot.',
    request: { body: json(CreateNote) }, responses: { 201: response(Note), ...errors } }), async c => {
    const who = await sessionOperator(c), input = c.req.valid('json'), noteId = id('uin');
    const url = new URL(input.url), page = masked({ url: input.url.slice(0, 2000), path: `${url.pathname}${url.search}`.slice(0, 2000), route: input.route });
    const context = masked(input.context), element = masked(input.element);
    // Bytes, well inside the table's limits (jsonb's text form adds a space after every : and ,).
    if (Buffer.byteLength(JSON.stringify(element)) > 16_000 || Buffer.byteLength(JSON.stringify(context)) > 4000) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'The captured element is too large.', 'element');
    const { rows: [created] } = await c.env.db.execute<{ id: string }>(sql`WITH n AS (INSERT INTO ui_notes(id, author_id, updated_by, body, kind, severity, url, path, route, context, element)
        VALUES (${noteId}, ${who.userId}, ${who.userId}, ${input.body}, ${input.kind}, ${input.severity}, ${page.url}, ${page.path}, ${page.route}, ${JSON.stringify(context)}::jsonb, ${JSON.stringify(element)}::jsonb) RETURNING id),
      a AS (${auditInsert(who.context, { action: 'ui_note.create', workspaceId: null, target: { type: 'ui_note', id: noteId }, after: { kind: input.kind, severity: input.severity, route: page.route } }, { from: sql`n` })})
      SELECT id FROM n`);
    return c.json(view(c.env, await loadNote(c.env.db, created!.id)), 201);
  });
  app.openapi(createRoute({ hide: true, tags, security, method: 'patch', path: '/v1/operator/ui-notes/{id}', operationId: 'operatorUpdateUiNote',
    description: 'Edits a note or sets its status and fixing PR. A UI notes key may set status, prUrl and resolution.',
    request: { params: z.object({ id: NoteId }), body: json(UpdateNote) }, responses: { 200: response(Note), ...errors } }), async c => {
    const who = await caller(c), input = c.req.valid('json'), noteId = c.req.valid('param').id;
    if (who.key && Object.keys(input).some(field => !KEY_FIELDS.has(field))) throw new ApiError(403, 'UI_NOTES_KEY_SCOPE', 'A UI notes key can set status, prUrl and resolution only.');
    await c.env.db.transaction(async tx => {
      const { rows: [before] } = await tx.execute<NoteRow>(sql`SELECT n.kind, n.severity, n.status, n.pr_url, n.route FROM ui_notes n WHERE n.id = ${noteId} FOR UPDATE`);
      if (!before) notFound('UI note');
      const set = (field: keyof typeof input) => input[field] !== undefined;
      const { rows: [after] } = await tx.execute<NoteRow>(sql`UPDATE ui_notes SET
          body = ${set('body') ? sql`${input.body!}` : sql`body`}, kind = ${set('kind') ? sql`${input.kind!}` : sql`kind`},
          severity = ${set('severity') ? sql`${input.severity ?? null}` : sql`severity`}, status = ${set('status') ? sql`${input.status!}` : sql`status`},
          pr_url = ${set('prUrl') ? sql`${input.prUrl ?? null}` : sql`pr_url`}, resolution = ${set('resolution') ? sql`${input.resolution || null}` : sql`resolution`},
          resolved_at = CASE WHEN ${set('status') ? sql`${input.status!}` : sql`status`} IN ('fixed','wontfix') THEN coalesce(resolved_at, now()) END,
          updated_at = now(), updated_by = ${who.userId}
        WHERE id = ${noteId} RETURNING kind, severity, status, pr_url, route`);
      await tx.execute(auditInsert(who.context, { action: 'ui_note.update', workspaceId: null, target: { type: 'ui_note', id: noteId }, before: summary(before!), after: summary(after!),
        details: { fields: Object.keys(input) } }));
    });
    return c.json(view(c.env, await loadNote(c.env.db, noteId)), 200);
  });
  app.openapi(createRoute({ hide: true, tags, security, method: 'delete', path: '/v1/operator/ui-notes/{id}', operationId: 'operatorDeleteUiNote',
    request: { params: z.object({ id: NoteId }) }, responses: { 200: response(z.object({ id: z.string(), deleted: z.literal(true) })), ...errors } }), async c => {
    const who = await sessionOperator(c), noteId = c.req.valid('param').id;
    const { rows: [gone] } = await c.env.db.execute<{ id: string; screenshot_key: string | null }>(sql`WITH n AS (DELETE FROM ui_notes WHERE id = ${noteId} RETURNING id, kind, severity, status, pr_url, route, screenshot_key),
      a AS (${auditInsert(who.context, { action: 'ui_note.delete', workspaceId: null, target: { type: 'ui_note', id: noteId },
        before: sql`jsonb_build_object('kind', n.kind, 'severity', n.severity, 'status', n.status, 'route', n.route)` }, { from: sql`n` })})
      SELECT id, screenshot_key FROM n`);
    if (!gone) notFound('UI note');
    // The row is gone, so its signed links already answer 404; the object is removed best-effort.
    if (gone.screenshot_key) await c.env.storage.delete(gone.screenshot_key).catch(error => logError(error, { requestId: c.get('requestId'), code: 'UI_NOTE_SCREENSHOT_DELETE_FAILED' }, 'warn'));
    return c.json({ id: gone.id, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ hide: true, tags, security, method: 'put', path: '/v1/operator/ui-notes/{id}/screenshot', operationId: 'operatorPutUiNoteScreenshot',
    description: 'Stores the note’s screenshot: the request body is a WebP, PNG or JPEG image of at most 2 MiB, with its Content-Type. Replaces any earlier one.',
    request: { params: z.object({ id: NoteId }), query: z.object({ width: z.coerce.number().int().min(1).max(20_000).optional(), height: z.coerce.number().int().min(1).max(20_000).optional() }) },
    responses: { 200: response(Note), ...errors } }), async c => {
    const who = await sessionOperator(c), noteId = c.req.valid('param').id, size = c.req.valid('query');
    const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase() as ImageType;
    if (!Object.hasOwn(IMAGE_TYPES, type)) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send a WebP, PNG or JPEG image with its Content-Type.');
    if (Number(c.req.header('content-length')) > MAX_SHOT_BYTES) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'A screenshot is at most 2 MiB.');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > MAX_SHOT_BYTES) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'A screenshot is at most 2 MiB.');
    if (!IMAGE_TYPES[type](bytes)) throw new ApiError(422, 'INVALID_IMAGE', 'The body is not the image its Content-Type names.');
    if (!(await c.env.db.execute(sql`SELECT FROM ui_notes WHERE id = ${noteId}`)).rowCount) notFound('UI note');
    const key = shotKey(noteId), meta = { contentType: type, bytes: bytes.length, width: size.width ?? null, height: size.height ?? null };
    try { await c.env.storage.put(key, bytes, type, AbortSignal.timeout(15_000)); }
    catch (error) { logError(error, { requestId: c.get('requestId'), code: 'UI_NOTE_SCREENSHOT_STORE_FAILED' }, 'warn'); throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Couldn’t store the screenshot. Try again.', undefined, true); }
    const { rows: [stored] } = await c.env.db.execute<{ id: string }>(sql`WITH n AS (UPDATE ui_notes SET screenshot_key = ${key}, screenshot = ${JSON.stringify(meta)}::jsonb, updated_at = now(), updated_by = ${who.userId}
        WHERE id = ${noteId} RETURNING id),
      a AS (${auditInsert(who.context, { action: 'ui_note.screenshot', workspaceId: null, target: { type: 'ui_note', id: noteId }, after: meta }, { from: sql`n` })})
      SELECT id FROM n`);
    if (!stored) { await c.env.storage.delete(key).catch(() => {}); notFound('UI note'); }
    return c.json(view(c.env, await loadNote(c.env.db, noteId)), 200);
  });
  // The signed screenshot link: the token is the credential (screenshotLink), so the API gate lets it through (app.ts).
  app.get('/v1/ui-notes/screenshots/:token', async c => {
    const missing = () => new ApiError(404, 'NOT_FOUND', 'This screenshot link is invalid or has expired.');
    const token = c.req.param('token');
    if (!c.env.config.multiTenant || !c.env.config.uiNotesSubjects?.length || token.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw missing();
    const [data, mac] = token.split('.') as [string, string];
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(shotTag(c.env.config.authSecret, data)))) throw missing();
    let claims: { n?: unknown; k?: unknown; e?: unknown };
    try { claims = JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { throw missing(); }
    if (!Number.isSafeInteger(claims.e) || (claims.e as number) <= Date.now() / 1000 || typeof claims.n !== 'string' || typeof claims.k !== 'string') throw missing();
    const { rows: [row] } = await c.env.db.execute<{ screenshot_key: string | null; type: string | null }>(sql`SELECT screenshot_key, screenshot->>'contentType' AS type FROM ui_notes WHERE id = ${claims.n}`);
    if (!row || row.screenshot_key !== claims.k || !row.type || !Object.hasOwn(IMAGE_TYPES, row.type)) throw missing();
    const object = await c.env.storage.get(claims.k);
    if (!object) throw missing();
    return new Response(new Blob([object.body as Uint8Array<ArrayBuffer>]), { headers: { 'Content-Type': row.type, 'Content-Disposition': 'inline', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "sandbox; default-src 'none'", 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-site' } });
  });

  // ---------- keys ----------
  const keyColumns = sql`id, name, prefix, ${isoAt(sql`created_at`)} AS "createdAt", ${isoAt(sql`expires_at`)} AS "expiresAt", ${isoAt(sql`last_used_at`)} AS "lastUsedAt", ${isoAt(sql`revoked_at`)} AS "revokedAt"`;
  app.openapi(createRoute({ hide: true, tags, security, method: 'get', path: '/v1/operator/ui-note-keys', operationId: 'operatorListUiNoteKeys', description: 'Your own UI notes keys, newest first.',
    responses: { 200: response(z.object({ data: z.array(NoteKey) })), ...errors } }), async c => {
    const who = await sessionOperator(c);
    const { rows } = await c.env.db.execute<z.infer<typeof NoteKey>>(sql`SELECT ${keyColumns} FROM ui_note_keys WHERE user_id = ${who.userId} ORDER BY created_at DESC LIMIT 50`);
    return c.json({ data: rows }, 200);
  });
  app.openapi(createRoute({ hide: true, tags, security, method: 'post', path: '/v1/operator/ui-note-keys', operationId: 'operatorCreateUiNoteKey',
    description: 'A key for a script or agent to read UI notes and set their status as you, while you hold the operator role. The secret is shown once.',
    request: { body: json(z.object({ name: z.string().trim().min(1).max(100), expiresInDays: z.number().int().min(1).max(90).default(30) }).strict()) },
    responses: { 201: response(NoteKey.extend({ secret: z.string() })), ...errors } }), async c => {
    const who = await sessionOperator(c), input = c.req.valid('json'), secret = randomSecret(secretPrefixes.notesKey), keyId = id('unk');
    const { rows: [key] } = await c.env.db.execute<z.infer<typeof NoteKey>>(sql`WITH k AS (INSERT INTO ui_note_keys(id, user_id, name, hash, prefix, expires_at)
        VALUES (${keyId}, ${who.userId}, ${input.name}, ${await digest(secret)}, ${shownPrefix(secret)}, now() + make_interval(days => ${input.expiresInDays})) RETURNING *),
      a AS (${auditInsert(who.context, { action: 'ui_note_key.create', workspaceId: null, target: { type: 'ui_note_key', id: keyId },
        after: sql`jsonb_build_object('name', k.name, 'prefix', k.prefix, 'expiresAt', k.expires_at)` }, { from: sql`k` })})
      SELECT ${keyColumns} FROM k`);
    return c.json({ ...key!, secret }, 201);
  });
  app.openapi(createRoute({ hide: true, tags, security, method: 'post', path: '/v1/operator/ui-note-keys/{id}/revoke', operationId: 'operatorRevokeUiNoteKey',
    request: { params: KeyIdParam }, responses: { 200: response(z.object({ id: z.string(), revoked: z.literal(true) })), ...errors } }), async c => {
    const who = await sessionOperator(c), keyId = c.req.valid('param').id;
    const { rows: [key] } = await c.env.db.execute<{ id: string }>(sql`WITH k AS (UPDATE ui_note_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = ${keyId} AND user_id = ${who.userId}
        RETURNING id, name, prefix, revoked_at = now() AS fresh),
      a AS (${auditInsert(who.context, { action: 'ui_note_key.revoke', workspaceId: null, target: { type: 'ui_note_key', id: keyId }, before: sql`jsonb_build_object('name', k.name, 'prefix', k.prefix)` }, { from: sql`k`, where: sql`k.fresh` })})
      SELECT id FROM k`);
    if (!key) notFound('UI notes key');
    return c.json({ id: key!.id, revoked: true as const }, 200);
  });
}
