import { sql } from 'drizzle-orm';
import { ApiError, digest, id, isoTime, randomSecret, type Ctx } from './core.js';
import { mailboxKeys, type MailboxPermission } from './db/mailbox.js';
import { recordAudit } from './audit.js';
import { ownReceiving } from './rituals.js';
import { secretPrefixes, shownPrefix } from './brand.js';

// An API key limited to receiving addresses or to one agent inbox. These keep their own table and bearer prefix
// (nm_mbx_…): only mailboxAuth accepts them, so they never reach a workspace route. The public API lists, creates and
// revokes them as API keys (auth.ts), with the access below in place of workspace permissions.
export type LimitedAccess =
  | { type: 'addresses'; addressIds?: string[] | null; mail: MailboxPermission[] }
  | { type: 'inbox'; inboxId: string; mail: MailboxPermission[] };
type Row = typeof mailboxKeys.$inferSelect;

/** What a limited key may do, as the API shows it. A key on exactly one agent inbox belongs to it (inbox_id). */
export const limitedAccess = (row: Pick<Row, 'inboxId' | 'mailboxIds' | 'permissions'>) => ({
  type: row.inboxId ? 'inbox' as const : 'addresses' as const, addressIds: row.mailboxIds, inboxId: row.inboxId ?? null, mail: row.permissions,
});
export const limitedKeyView = (row: Row) => ({
  id: row.id, name: row.name, prefix: row.prefix, permissions: [] as ('read' | 'send' | 'manage')[], domains: [] as string[],
  access: limitedAccess(row), expiresAt: isoTime(row.expiresAt),
  createdAt: isoTime(row.createdAt)!, lastUsedAt: isoTime(row.lastUsedAt), revokedAt: isoTime(row.revokedAt),
});

/**
 * Creates a limited key; the secret is returned once. The caller has already checked that it may administer keys
 * (an unrestricted manage credential, never an agent token). A key an MCP approval creates is tied to it (ownReceiving)
 * and needs its receiving consent. `field` names the request field for errors: the API's access object, or the
 * deprecated createInboundKey's top-level fields.
 */
export async function createLimitedKey(c: Ctx, workspaceId: string, name: string, access: LimitedAccess, field: { addresses: string; inbox: string; mail: string }) {
  const mail = [...new Set(access.mail)];
  let mailboxIds: string[] | null, inboxId: string | null = null;
  if (access.type === 'inbox') {
    if (mail.includes('create')) throw new ApiError(422, 'VALIDATION_FAILED', 'A key for one inbox can read, send and modify; create needs a key for addresses.', field.mail);
    mailboxIds = [access.inboxId]; inboxId = access.inboxId;
  } else {
    mailboxIds = access.addressIds ? [...new Set(access.addressIds)] : null;
    if (mail.includes('create') && mailboxIds === null || mailboxIds?.length === 0 && !mail.includes('create'))
      throw new ApiError(422, 'ADDRESS_SCOPE_REQUIRED', 'Provisioning keys need an explicit addressIds scope.', field.addresses);
  }
  const secret = randomSecret(secretPrefixes.addressKey);
  const row = await c.env.db.transaction(async tx => {
    let expiresAt: string | null = null;
    if (mailboxIds?.length) {
      // Held until commit, so an inbox can't be deleted between this check and the insert (inbox_end locks the row).
      const found = (await tx.execute<{ id: string; kind: string; delete_after: string | null; active: boolean }>(sql`SELECT id, kind, delete_after::text, delete_after IS NULL OR delete_after > now() AS active
        FROM mailboxes WHERE workspace_id = ${workspaceId} AND id = ANY(${sql.param(mailboxIds)}::text[]) FOR SHARE`)).rows;
      if (access.type === 'inbox') {
        if (found[0]?.kind !== 'inbox' || !found[0].active) throw new ApiError(422, 'UNKNOWN_INBOX', 'Choose an active agent inbox in this workspace.', field.inbox);
        // It ends with the inbox (inbox_end), and with an expiring inbox's lease.
        expiresAt = found[0].delete_after;
      } else if (found.length !== mailboxIds.length) throw new ApiError(422, 'MAILBOX_NOT_FOUND', 'Every ID must identify an existing receiving address.', field.addresses);
    }
    const [created] = await tx.insert(mailboxKeys).values({ id: id('mbk'), workspaceId, name, hash: await digest(secret), prefix: shownPrefix(secret), mailboxIds, inboxId, permissions: mail, expiresAt }).returning();
    await ownReceiving(tx, c, 'key', created!.id);
    await recordAudit(tx, c, { action: 'api_key.create', workspaceId, target: { type: 'api_key', id: created!.id },
      after: { name, access: limitedAccess(created!), mcpGrant: c.get('actor')?.grantId } });
    return created!;
  });
  c.header('Cache-Control', 'no-store');
  return { row, secret };
}

/** Revokes a limited key. A repeated revoke keeps the first time and writes no second audit row. */
export async function revokeLimitedKey(c: Ctx, workspaceId: string, keyId: string) {
  return await c.env.db.transaction(async tx => {
    const [row] = await tx.select().from(mailboxKeys).where(sql`${mailboxKeys.workspaceId} = ${workspaceId} AND ${mailboxKeys.id} = ${keyId}`).for('update');
    if (!row) return null;
    if (row.revokedAt) return { row, fresh: false };
    const [revoked] = await tx.update(mailboxKeys).set({ revokedAt: new Date().toISOString() }).where(sql`${mailboxKeys.id} = ${row.id}`).returning();
    await recordAudit(tx, c, { action: 'api_key.revoke', workspaceId, target: { type: 'api_key', id: row.id }, before: { name: row.name, access: limitedAccess(row) } });
    return { row: revoked!, fresh: true };
  });
}
