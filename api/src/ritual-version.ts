import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { checkBudget } from './auth.js';
import { errors, response, security, type Actor, type App, type DbExecutor } from './core.js';
import { ritualAdmin } from './rituals.js';

// The dashboard's live view of rituals, routes and endpoints, for a person editing next to an agent that saves over MCP.
// One long poll per open page: each tick is one statement of primary-key reads (the routing version every ritual and
// route save bumps, and when asked, the newest endpoint change in the audit trail's last two minutes), and the call
// answers as soon as either moves. Only who saved it is looked up, once, when something changed. The waited ticks are
// charged up front to the caller's per-minute request budget, as the inbox long polls are.

/** Server-side tick. A change shows within this, plus the request's round trip. */
const TICK_MS = 2500;
/** How far back an endpoint change is looked for. A page polls continuously, so it only needs the last tick or two. */
const ENDPOINT_WINDOW = sql`interval '2 minutes'`;

type Kind = 'member' | 'api_key' | 'mcp';
const ChangedBy = z.object({
  type: z.enum(['member', 'api_key', 'mcp']).describe('member is a person in the dashboard, api_key an API key, mcp an MCP client (or a temporary token it made).'),
  name: z.string().nullable().describe('The member’s name, the API key’s name or the MCP client and its profile label; null when it is gone. Never an email address.'),
  self: z.boolean().describe('The credential making this request made the change (another tab, say).'),
}).openapi('RitualChangeActor');
const VersionState = z.object({
  version: z.number().int().describe('The routing version. Routes and rituals share it, and it is the If-Match for saving either.'),
  endpoints: z.string().regex(/^\d+$/).describe('Marks the latest endpoint change seen. Pass it back as endpoints to wait for the next one.'),
  changed: z.boolean().describe('version or endpoints moved past what you passed as after and endpoints.'),
  actor: ChangedBy.nullable().describe('Who made the change returned: the save behind version, or else the latest endpoint change. Null when nothing changed.'),
}).openapi('RitualVersion');
const Query = z.object({
  after: z.coerce.number().int().min(0).max(2147483647).optional().describe('The version you have. The call waits until the version differs from it.'),
  endpoints: z.string().regex(/^\d{1,19}$/).optional().describe('The endpoints marker from the last response: also wait for an endpoint to be created, changed or deleted.'),
  wait: z.coerce.number().int().min(0).max(25).default(25).describe('Seconds to wait for a change (0–25). Ignored without after or endpoints.'),
}).strict();

/** Who a change came from, by the credential types the routing history and the audit trail record. */
const fromVersion = (w: string, version: number) => sql`SELECT CASE actor_type WHEN 'dashboard' THEN 'member' WHEN 'apiKey' THEN 'api_key' WHEN 'mcp' THEN 'mcp' WHEN 'agentToken' THEN 'mcp' END AS kind,
  CASE WHEN actor_type = 'dashboard' THEN substr(actor_id, 6) ELSE actor_id END AS id FROM mail_routing_versions WHERE workspace_id = ${w} AND version = ${version}`;
const fromAudit = (w: string, id: string) => sql`SELECT CASE e.actor_type WHEN 'member' THEN 'member' WHEN 'api_key' THEN 'api_key' WHEN 'mcp_grant' THEN 'mcp' WHEN 'agent_token' THEN 'mcp' END AS kind,
  CASE WHEN e.actor_type = 'agent_token' THEN (SELECT t.grant_id FROM agent_tokens t WHERE t.id = e.actor_id AND t.workspace_id = ${w}) ELSE e.actor_id END AS id
  FROM audit_events e WHERE e.workspace_id = ${w} AND e.id = ${id}::bigint AND e.actor_type IN ('member', 'api_key', 'mcp_grant', 'agent_token')`;
async function changedBy(db: DbExecutor, a: Actor, w: string, who: ReturnType<typeof sql>): Promise<z.infer<typeof ChangedBy> | null> {
  // Names only: a member's display name, a key's name in this workspace, or the client an approval was given to.
  const row = (await db.execute<{ kind: Kind | null; id: string | null; name: string | null; profile: string | null }>(sql`WITH who AS (${who})
    SELECT kind, id, CASE kind WHEN 'member' THEN (SELECT u.name FROM nightmail_users u WHERE u.id = who.id)
      WHEN 'api_key' THEN (SELECT k.name FROM api_keys k WHERE k.id = who.id AND k.workspace_id = ${w})
      WHEN 'mcp' THEN (SELECT g.client_id FROM nightmail_resource_grants g WHERE g.id = who.id) END AS name,
      CASE WHEN kind = 'mcp' THEN (SELECT g.profile FROM nightmail_resource_grants g WHERE g.id = who.id) END AS profile FROM who`)).rows[0];
  if (!row?.kind) return null;
  // An MCP client names itself: shown the way Settings shows it (clientLabel), with its profile label.
  const name = row.kind === 'mcp' && row.name !== null ? (await import('./mcp-auth.js')).clientLabel(row.name) || null : row.name?.trim() || null;
  const mine = a.credential === 'dashboard' ? ['member', a.keyId.slice('user_'.length)] : a.credential === 'apiKey' ? ['api_key', a.keyId] : ['mcp', a.keyId];
  return { type: row.kind, name: name && row.profile ? `${name} · ${row.profile}` : name, self: mine[0] === row.kind && mine[1] === row.id };
}

export function registerRitualVersion(app: App) {
  app.openapi(createRoute({
    method: 'get', path: '/v1/rituals/version', operationId: 'getRitualVersion', security, tags: ['Rituals'],
    summary: 'Read the rituals and routes version, or wait for it to change',
    description: 'Without after, returns the current version at once. With after (and endpoints, to include endpoint changes), waits up to wait seconds for a ritual, route or endpoint save and returns as soon as one commits, with who saved it. The dashboard keeps one of these open while you edit rituals so an agent’s saves appear live. Each waited 2.5 seconds counts as one request against the credential’s per-minute budget.',
    request: { query: Query },
    responses: { 200: response(VersionState), ...errors },
  }), async c => {
    const a = ritualAdmin(c), w = a.workspaceId, q = c.req.valid('query');
    const watching = q.after !== undefined || q.endpoints !== undefined, wait = watching ? q.wait : 0;
    // Every tick this call may take is charged before the first, like the inbox long polls (src/mailbox.ts poll()).
    const max = c.env.config.apiRateLimitPerMinute, ticks = 1 + Math.ceil(wait * 1000 / TICK_MS);
    const { rows: [debit] } = await c.env.db.execute<{ used: number }>(sql`INSERT INTO api_request_budgets AS b(workspace_id,key_id,window_start,used)
      VALUES(${w},${a.keyId},date_trunc('minute',now()),${ticks}) ON CONFLICT(workspace_id,key_id) DO UPDATE SET
      used=least(${max + 1},excluded.used+CASE WHEN b.window_start=excluded.window_start THEN b.used ELSE 0 END),window_start=excluded.window_start RETURNING used`);
    checkBudget(c, debit!.used, max);
    const mark = BigInt(q.endpoints ?? '0'), deadline = Date.now() + wait * 1000;
    for (;;) {
      const now = (await c.env.db.execute<{ version: number; endpoint: string | null }>(sql`SELECT coalesce((SELECT version FROM mail_routing_state WHERE workspace_id = ${w}), 0) AS version,
        ${q.endpoints === undefined && watching ? sql`NULL::text` : sql`(SELECT max(id)::text FROM audit_events WHERE workspace_id = ${w} AND at > now() - ${ENDPOINT_WINDOW} AND target_type = 'endpoint')`} AS endpoint`)).rows[0]!;
      const latest = now.endpoint === null ? 0n : BigInt(now.endpoint);
      const versionMoved = q.after !== undefined && now.version !== q.after, endpointMoved = q.endpoints !== undefined && latest > mark;
      if (versionMoved || endpointMoved || !watching || Date.now() >= deadline || c.req.raw.signal.aborted) {
        const changed = versionMoved || endpointMoved;
        // The first read names who saved the current version; a wait that timed out names nobody (nothing changed).
        const actor = !watching || versionMoved ? now.version ? await changedBy(c.env.db, a, w, fromVersion(w, now.version)) : null
          : endpointMoved ? await changedBy(c.env.db, a, w, fromAudit(w, String(latest))) : null;
        c.header('Cache-Control', 'no-store');
        return c.json({ version: now.version, endpoints: String(latest > mark ? latest : mark), changed, actor }, 200);
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(TICK_MS, Math.max(0, deadline - Date.now()))));
    }
  });
}
