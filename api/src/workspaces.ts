import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, sql } from 'drizzle-orm';
import { ApiError, dashboardSession, errors, id, IdParams, json, notFound, response, type App, type Ctx, type DbExecutor } from './core.js';
import { baneUsers } from './db/users.js';
import { workspaceMembers, workspaces } from './db/workspaces.js';
import { invitationRecipient, verifiedDashboardUser } from './dashboard-auth.js';

export const WorkspaceRole = z.enum(['owner', 'admin', 'member']);
type Role = z.infer<typeof WorkspaceRole>;
export const Workspace = z.object({ id: z.string(), name: z.string(), slug: z.string(), role: WorkspaceRole }).openapi('Workspace');
const Member = z.object({ id: z.string(), userId: z.string(), email: z.string(), name: z.string(), role: WorkspaceRole }).openapi('WorkspaceMember');
const Invitation = z.object({ id: z.string(), workspaceId: z.string(), email: z.string(), role: WorkspaceRole, expiresAt: z.string(), acceptUrl: z.string().url() }).openapi('WorkspaceInvitation');
const InvitationPreview = z.object({ id: z.string(), workspaceId: z.string(), workspaceName: z.string(), workspaceSlug: z.string(), inviterName: z.string(), inviterEmail: z.string(), role: WorkspaceRole, expiresAt: z.string(), status: z.enum(['pending', 'accepted']) }).openapi('WorkspaceInvitationPreview');
const Invite = z.object({ email: z.email().toLowerCase(), role: WorkspaceRole }).strict().openapi('InviteWorkspaceMember');
const Removed = z.object({ id: z.string(), deleted: z.literal(true) });
const security: Record<string, string[]>[] = [{ dashboardSession: [] }, { secureDashboardSession: [] }];
const tags = ['Workspaces'];
const base = '/v1/workspaces/current';

// Accept only the invitation the verified recipient followed. Never overwrite an existing role.
export async function claimInvitation(db: DbExecutor, userId: string, email: string, invitationId: string) {
  const result = await db.execute<{ workspace_id: string }>(sql`WITH pending AS (
    SELECT i.id FROM workspace_invitations i JOIN workspace_members inviter ON inviter.workspace_id = i.workspace_id AND inviter.user_id = i.inviter_id
    WHERE i.email = ${email.toLowerCase()} AND i.status = 'pending' AND i.expires_at > now() AND i.role IN ('owner','admin','member')
      AND (inviter.role = 'owner' OR (inviter.role = 'admin' AND i.role <> 'owner'))
      AND i.id = ${invitationId} FOR UPDATE OF i FOR SHARE OF inviter
  ), claimed AS (
    UPDATE workspace_invitations i SET status = 'accepted' FROM pending WHERE i.id = pending.id RETURNING i.workspace_id, i.role
  ), joined AS (
    INSERT INTO workspace_members (id, workspace_id, user_id, role) SELECT ${id('mem')}, workspace_id, ${userId}, role FROM claimed
    ON CONFLICT (workspace_id, user_id) DO NOTHING
  ) UPDATE bane_users u SET selected_workspace_id = claimed.workspace_id FROM claimed WHERE u.id = ${userId} RETURNING claimed.workspace_id`);
  return result.rows[0]?.workspace_id;
}

// The invitation the verified recipient followed is still claimable (the same conditions as
// claimInvitation). Reading it changes nothing.
export async function pendingInvitation(db: DbExecutor, email: string, invitationId: string) {
  const result = await db.execute(sql`SELECT FROM workspace_invitations i JOIN workspace_members inviter ON inviter.workspace_id = i.workspace_id AND inviter.user_id = i.inviter_id
    WHERE i.id = ${invitationId} AND i.email = ${email.toLowerCase()} AND i.status = 'pending' AND i.expires_at > now() AND i.role IN ('owner','admin','member')
      AND (inviter.role = 'owner' OR (inviter.role = 'admin' AND i.role <> 'owner'))`);
  return !!result.rowCount;
}

// Called only in the transaction that *inserts* the OIDC user. Ordinary dashboard requests,
// refreshes and dispatch cannot bootstrap a removed member or create a second organization.
// Nobody joins during sign-in (M9). An account whose only way in is the invitation it followed is
// created with no membership; its session can only review and accept that invitation.
export async function onboardNewUser(db: DbExecutor, user: { id: string; name: string; email: string }, allowSignup: boolean, region: string, invitationId: string | null) {
  if (!allowSignup) return !!invitationId && await pendingInvitation(db, user.email, invitationId);
  await insertOwnedWorkspace(db, user.id, `${(user.name.trim() || user.email.split('@')[0]!).slice(0, 105)}'s Organization`, region);
  return true;
}

// One statement: the workspace, its regional settings and the owner membership. With `ownedBelow`,
// nothing is inserted once the user already owns that many workspaces (the caller holds the user lock)
// or is no longer a member of `memberOf`, the workspace the request authenticated through.
async function insertOwnedWorkspace(db: DbExecutor, userId: string, name: string, region: string, limit?: { ownedBelow: number; memberOf: string }) {
  const workspaceId = id('ws');
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0,30).replace(/^-|-$/g, '') || 'workspace'}-${workspaceId.slice(3)}`;
  const result = await db.execute<{ id: string; name: string; slug: string }>(sql`WITH created AS (
    INSERT INTO workspaces(id, name, slug, quota_sponsor) SELECT ${workspaceId}, ${name}, ${slug}, ${userId}
    ${limit === undefined ? sql`` : sql`WHERE (SELECT count(*) FROM workspace_members WHERE user_id = ${userId} AND role = 'owner') < ${limit.ownedBelow}
      AND EXISTS(SELECT 1 FROM workspace_members WHERE user_id = ${userId} AND workspace_id = ${limit.memberOf})`}
    RETURNING id, name, slug
  ), region_settings AS (
    INSERT INTO ses_installation_settings(workspace_id, installation_id, default_region, enabled_regions)
    SELECT id, ${id('install')}, ${region}, ${JSON.stringify([region])}::jsonb FROM created
  ), owner AS (
    INSERT INTO workspace_members(id, workspace_id, user_id, role) SELECT ${id('mem')}, id, ${userId}, 'owner' FROM created
  ) SELECT id, name, slug FROM created`);
  return result.rows[0];
}
const maxOwnedWorkspaces = 10;

/** Every workspace the user belongs to, with their role, by name: one statement. Read by GET /v1/me and the deprecated GET /v1/workspaces. */
export async function memberships(db: DbExecutor, userId: string) {
  const rows = await db.select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug, role: workspaceMembers.role }).from(workspaceMembers).innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId)).where(eq(workspaceMembers.userId, userId)).orderBy(workspaces.name, workspaces.id);
  return rows.map(row => Workspace.parse(row));
}

// Serialize governance writes per workspace. Read the caller and owner count *after* locking:
// concurrent demotions cannot authorize each other on an old snapshot or remove both owners.
function administer<T>(c: Ctx, action: (db: DbExecutor, workspaceId: string, userId: string, role: 'owner' | 'admin') => Promise<T>) {
  const { workspaceId, userId } = dashboardSession(c, true);
  return c.env.db.transaction(async db => {
    await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for('no key update');
    const [member] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    if (member?.role !== 'owner' && member?.role !== 'admin') throw new ApiError(403, 'PERMISSION_DENIED', 'Workspace administration requires an owner or admin.');
    return action(db, workspaceId, userId, member.role);
  });
}
const ownerRequired = () => new ApiError(403, 'OWNER_REQUIRED', 'Only an owner can change workspace ownership.');
function changeMember(c: Ctx, memberId: string, newRole?: Role) {
  return administer(c, async (db, wid, _uid, role) => {
    const filter = and(eq(workspaceMembers.workspaceId, wid), eq(workspaceMembers.id, memberId));
    const [member] = await db.select({ role: workspaceMembers.role, otherOwner: sql<boolean>`EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id = ${wid} AND role = 'owner' AND id <> ${memberId})` }).from(workspaceMembers).where(filter);
    if (!member) return notFound('Member');
    if ((member.role === 'owner' || newRole === 'owner') && role !== 'owner') throw ownerRequired();
    if (member.role === 'owner' && newRole !== 'owner' && !member.otherOwner) throw new ApiError(409, 'LAST_OWNER', 'Promote another owner before removing or demoting the last owner.');
    if (newRole) await db.update(workspaceMembers).set({ role: newRole }).where(filter);
    else await db.delete(workspaceMembers).where(filter);
  });
}
type InviteRow = { id: string; workspaceId: string; email: string; role: Role; expiresAt: Date };
function invitationView(c: Ctx, row: InviteRow) {
  return { ...row, expiresAt: new Date(row.expiresAt).toISOString(), acceptUrl: `${c.env.config.publicUrl}/?invitation=${encodeURIComponent(row.id)}` };
}
async function invite(c: Ctx, input: z.infer<typeof Invite>) {
  return administer(c, async (db, wid, uid, role) => {
    if (input.role === 'owner' && role !== 'owner') throw ownerRequired();
    const result = await db.execute<InviteRow>(sql`INSERT INTO workspace_invitations(id, workspace_id, email, role, inviter_id, expires_at)
      SELECT ${id('inv')}, ${wid}, ${input.email}, ${input.role}, ${uid}, now() + interval '7 days'
      WHERE NOT EXISTS(SELECT 1 FROM workspace_members m JOIN bane_users u ON u.id = m.user_id WHERE m.workspace_id = ${wid} AND lower(u.email) = ${input.email})
      ON CONFLICT (workspace_id, email) WHERE status = 'pending' DO UPDATE SET id = excluded.id, role = excluded.role, inviter_id = excluded.inviter_id, expires_at = excluded.expires_at, created_at = now()
      WHERE workspace_invitations.expires_at <= now()
      RETURNING id, workspace_id AS "workspaceId", email, role, expires_at AS "expiresAt"`);
    if (!result.rows[0]) throw new ApiError(409, 'ALREADY_INVITED_OR_MEMBER', 'This address already has a pending invitation or membership.');
    return invitationView(c, result.rows[0]);
  });
}

export function registerWorkspaces(app: App) {
  // Deprecated alias: GET /v1/me returns the same list as `workspaces`, so the dashboard needs one request, not two.
  app.openapi(createRoute({ method: 'get', path: '/v1/workspaces', operationId: 'listWorkspaces', tags, security, deprecated: true,
    description: 'Deprecated: read workspaces from getCurrentIdentity (GET /v1/me), which returns the same list with the current identity. Lists your memberships. Dashboard requests can select a membership with X-Bane-Workspace (workspace ID); without it, the most recent selection is used. Workspace administration requires a OIDC session.',
    responses: { 200: response(z.object({ data: z.array(Workspace) })), ...errors } }), async c => c.json({ data: await memberships(c.env.db, dashboardSession(c).userId) }, 200));
  app.openapi(createRoute({ method: 'post', path: '/v1/workspaces', operationId: 'createWorkspace', tags, security,
    description: `Create another workspace you own, for example to keep separate products, teams or billing apart. It starts like a new signup: connect sending, then add a domain. Requires an account approved for sign-up; each account can own up to ${maxOwnedWorkspaces} workspaces. Select it with X-Bane-Workspace.`,
    request: { body: json(z.object({ name: z.string().trim().min(1).max(120) }).strict()) }, responses: { 201: response(Workspace), ...errors } }), async c => {
    const a = dashboardSession(c), { name } = c.req.valid('json');
    const created = await c.env.db.transaction(async db => {
      // Lock the user so concurrent creates count each other's workspaces.
      const [user] = await db.select({email:baneUsers.email}).from(baneUsers).where(and(eq(baneUsers.id,a.userId),eq(baneUsers.emailVerified,true))).for('update');
      const allowed = user && c.env.config.allowedEmails.includes(user.email.toLowerCase());
      if (!allowed) throw new ApiError(403, 'SIGNUP_NOT_APPROVED', 'This account is not approved to create workspaces.');
      const row = await insertOwnedWorkspace(db, a.userId, name, c.env.config.regions[0]!, { ownedBelow: maxOwnedWorkspaces, memberOf: a.workspaceId });
      if (row) return row;
      const [member] = await db.select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(eq(workspaceMembers.userId, a.userId), eq(workspaceMembers.workspaceId, a.workspaceId)));
      if (!member) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in with your OIDC account.');
      throw new ApiError(409, 'WORKSPACE_LIMIT', `You already own ${maxOwnedWorkspaces} workspaces, the most one account can have.`);
    });
    return c.json(Workspace.parse({ ...created, role: 'owner' }), 201);
  });
  app.openapi(createRoute({ method: 'patch', path: base, operationId: 'renameCurrentWorkspace', tags, security, request: { body: json(z.object({ name: z.string().trim().min(1).max(120) }).strict()) }, responses: { 200: response(Workspace), ...errors } }), async c => {
    const { name } = c.req.valid('json');
    const row = await administer(c, async (db, wid, _uid, role) => {
      const [w] = await db.update(workspaces).set({ name }).where(eq(workspaces.id, wid)).returning({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug });
      return { ...w!, role };
    });
    return c.json(row, 200);
  });
  app.openapi(createRoute({ method: 'get', path: `${base}/members`, operationId: 'listWorkspaceMembers', tags, security, responses: { 200: response(z.object({ data: z.array(Member) })), ...errors } }), async c => {
    const a = dashboardSession(c, true);
    const rows = await c.env.db.select({ id: workspaceMembers.id, userId: baneUsers.id, role: workspaceMembers.role, email: baneUsers.email, name: baneUsers.name }).from(workspaceMembers).innerJoin(baneUsers, eq(baneUsers.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, a.workspaceId)).orderBy(baneUsers.email);
    return c.json({ data: rows.map(row => Member.parse(row)) }, 200);
  });
  for (const [resource, operationId] of [['members', 'inviteWorkspaceMember'], ['invitations', 'createWorkspaceInvitation']] as const) {
    app.openapi(createRoute({ method: 'post', path: `${base}/${resource}` as const, operationId, description: 'Invite an email address. Membership starts only after acceptance by the verified address. Share the returned URL; no email is sent.', tags, security, request: { body: json(Invite) }, responses: { 201: response(Invitation), ...errors } }), async c => c.json(await invite(c, c.req.valid('json')), 201));
  }
  app.openapi(createRoute({ method: 'patch', path: `${base}/members/{id}`, operationId: 'updateWorkspaceMember', tags, security, request: { params: IdParams, body: json(z.object({ role: WorkspaceRole }).strict()) }, responses: { 200: response(z.object({ id: z.string(), role: WorkspaceRole })), ...errors } }), async c => {
    const { id } = c.req.valid('param'), { role } = c.req.valid('json'); await changeMember(c, id, role); return c.json({ id, role }, 200);
  });
  app.openapi(createRoute({ method: 'delete', path: `${base}/members/{id}`, operationId: 'removeWorkspaceMember', tags, security, request: { params: IdParams }, responses: { 200: response(Removed), ...errors } }), async c => {
    const { id } = c.req.valid('param'); await changeMember(c, id); return c.json({ id, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: `${base}/invitations`, operationId: 'listWorkspaceInvitations', tags, security, description: 'List pending, unexpired workspace invitations.', responses: { 200: response(z.object({ data: z.array(Invitation) })), ...errors } }), async c => {
    const a = dashboardSession(c, true);
    const result = await c.env.db.execute<InviteRow>(sql`SELECT id, workspace_id AS "workspaceId", email, role, expires_at AS "expiresAt" FROM workspace_invitations WHERE workspace_id = ${a.workspaceId} AND status = 'pending' AND expires_at > now() ORDER BY email`);
    return c.json({ data: result.rows.map(row => invitationView(c, row)) }, 200);
  });
  app.openapi(createRoute({ method: 'delete', path: `${base}/invitations`, operationId: 'revokeWorkspaceInvitation', tags, security, request: { query: IdParams }, responses: { 200: response(Removed), ...errors } }), async c => {
    const { id } = c.req.valid('query');
    await administer(c, async (db, wid, _uid, role) => {
      const result = await db.execute(sql`UPDATE workspace_invitations SET status = 'canceled' WHERE id = ${id} AND workspace_id = ${wid} AND status = 'pending' AND (role <> 'owner' OR ${role} = 'owner') RETURNING id`);
      if (!result.rowCount) notFound('Invitation');
    });
    return c.json({ id, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/workspaces/invitations/{id}', operationId: 'getWorkspaceInvitation', tags, security,
    description: 'Shows the signed-in recipient the invitation they followed: workspace, inviter and role. Reading it changes nothing; membership starts only with acceptWorkspaceInvitation.',
    request: { params: IdParams }, responses: { 200: response(InvitationPreview), ...errors } }), async c => {
    if (!c.env.config.multiTenant) return notFound('Endpoint');
    const a = await verifiedDashboardUser(c.env, c.req.raw.headers,true), invitationId = c.req.valid('param').id;
    // Same conditions as claimInvitation for a pending invitation, plus the idempotent accepted case.
    const result = await c.env.db.execute<z.infer<typeof InvitationPreview>>(sql`SELECT i.id, i.workspace_id AS "workspaceId", w.name AS "workspaceName", w.slug AS "workspaceSlug",
        u.name AS "inviterName", u.email AS "inviterEmail", i.role, i.expires_at AS "expiresAt", CASE WHEN i.status = 'accepted' THEN 'accepted' ELSE 'pending' END AS status
      FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id JOIN bane_users u ON u.id = i.inviter_id
      JOIN workspace_members inviter ON inviter.workspace_id = i.workspace_id AND inviter.user_id = i.inviter_id
      WHERE i.id = ${invitationId} AND i.email = ${a.email.toLowerCase()} AND i.role IN ('owner','admin','member') AND (
        (i.status = 'pending' AND i.expires_at > now() AND (inviter.role = 'owner' OR (inviter.role = 'admin' AND i.role <> 'owner')))
        OR (i.status = 'accepted' AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id = i.workspace_id AND m.user_id = ${a.userId})))`);
    const row = result.rows[0] ?? notFound('Invitation');
    return c.json(InvitationPreview.parse({ ...row, expiresAt: new Date(row.expiresAt).toISOString() }), 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/workspaces/invitations/{id}/accept', operationId: 'acceptWorkspaceInvitation', tags, security, request: { params: IdParams }, responses: { 200: response(z.object({ workspaceId: z.string() })), ...errors } }), async c => {
    if (!c.env.config.multiTenant) return notFound('Endpoint');
    const a = await invitationRecipient(c.env, c.req.raw.headers), invitationId = c.req.valid('param').id;
    const workspaceId = await claimInvitation(c.env.db, a.userId, a.email, invitationId);
    if (workspaceId) return c.json({ workspaceId }, 200);
    // Following the URL immediately after sign-in is an idempotent success, never a rejoin.
    const existing = await c.env.db.execute<{ workspace_id: string }>(sql`SELECT i.workspace_id FROM workspace_invitations i JOIN workspace_members m ON m.workspace_id = i.workspace_id AND m.user_id = ${a.userId} WHERE i.id = ${invitationId} AND i.email = ${a.email.toLowerCase()} AND i.status = 'accepted'`);
    return c.json({ workspaceId: existing.rows[0]?.workspace_id ?? notFound('Invitation') }, 200);
  });
}
