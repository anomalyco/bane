import { addressGlob } from './routing-match.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ApiError, id, type DbExecutor } from './core.js';
import { mailboxAddresses, mailboxes, mailboxWriteLanes, mailMessages, type MailAddress, type SendLimits } from './db/mailbox.js';
import { mailText } from './mailbox-text.js';

export type Scope = { workspaceId: string };
/** SES assigns the wire Message-ID independently of Nightmail's durable receipt. */
export const sesMessageId = (providerId: string, region: string) => `${providerId}@${region === 'us-east-1' ? 'email' : region}.amazonses.com`;
/** ON CONFLICT locks even when its WHERE rejects the update: one trip, no idle tuple churn. */
export async function lockMailboxLane(tx: DbExecutor, workspaceId:string, lane: typeof mailboxWriteLanes.$inferSelect.lane) {
  await tx.execute(sql`INSERT INTO mailbox_write_lanes(workspace_id,lane) VALUES(${workspaceId},${lane}) ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane WHERE false`);
}
export const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const utf8 = new TextEncoder();
/**
 * Message-IDs compare without angle brackets or surrounding whitespace; case is preserved (RFC 5322 local parts are case-sensitive).
 * An ID is at most one header line, 998 bytes as stored, which is also what its index holds: a longer one is not an ID.
 */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/<([^<>\s]+)>/);
  const result = (match ? match[1]! : value.trim().replace(/^<|>$/g, '')).trim();
  return result && result.length <= 998 && !/\s/.test(result) && utf8.encode(mailText(result)).length <= 998 ? result : null;
}
export function messageIdList(value: string | null | undefined): string[] {
  if (!value) return [];
  const bracketed = [...value.matchAll(/<([^<>\s]+)>/g)].map(match => match[1]!);
  const list = bracketed.length ? bracketed : value.split(/[\s,]+/).map(item => normalizeMessageId(item)).filter((item): item is string => !!item);
  return [...new Set(list)].slice(-100);
}
export function normalizeSubject(value: string) {
  let subject = value.trim();
  for (let i = 0; i < 10; i++) { const next = subject.replace(/^(?:re|fwd?|aw|wg|sv|vs|antw|rif|tr)(?:\[\d+\])?\s*:\s*/i, '').trim(); if (next === subject) break; subject = next; }
  return subject;
}
/** Plain text without quoted history: drops "> " lines and everything from a reply attribution line. */
export function replyText(text: string | null | undefined): string {
  if (!text) return '';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Attribution lines ("On Tue, Ana <a@b.c> wrote:"), including ones wrapped onto a second line.
    if (/^\s*On\s.{0,300}\swrote:\s*$/i.test(line) || (/^\s*On\s/i.test(line) && /\swrote:\s*$/i.test(lines[i + 1] ?? ''))) break;
    if (/^-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}/i.test(line) || /^_{10,}\s*$/.test(line) || /^From:\s.+/.test(line) && /^(?:Sent|Date):\s/.test(lines[i + 1] ?? '')) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function htmlToPlain(html: string) {
  // Text projection only (not an HTML sanitizer). Each token consumes its
  // input once, including truncated markup and unmatched delimiters.
  let hidden=''; const parts:string[]=[];
  for(const [token] of html.slice(0,512*1024).matchAll(/<[^<>]*>?|[^<]+/g)) {
    if(token[0]!=='<') { if(!hidden) parts.push(token); continue; }
    const tag=/^<(\/?)([a-z][a-z0-9]*)\b/i.exec(token);
    const name=tag?.[2]?.toLowerCase();
    if(hidden){ if(tag?.[1] && name===hidden) hidden=''; continue; }
    if(!tag?.[1] && name && ['script','style','head'].includes(name)) hidden=name;
    parts.push(name==='br' || tag?.[1] && /^(p|div|li|tr|h\d)$/.test(name!)?'\n':' ');
  }
  return parts.join('').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/\s+/g,w=>w.includes('\n')?'\n':' ').trim();
}
export function snippetOf(text: string | null | undefined, html: string | null | undefined) {
  const source = replyText(text?.slice(0,16384) || (html ? htmlToPlain(html.slice(0,16384)) : ''));
  return source.replace(/\s+/g, ' ').trim().slice(0, 200);
}
export function uniqueAddresses(list: MailAddress[], limit = 20): MailAddress[] {
  const seen = new Set<string>(), out: MailAddress[] = [];
  for (const item of list) { const key = item.address.toLowerCase(); if (!key || seen.has(key)) continue; seen.add(key); out.push({ name: item.name || null, address: key }); if (out.length >= limit) break; }
  return out;
}
/** Wildcard address rules: "*" matches any run of characters, e.g. support+*@acme.com or *@help.acme.com. */
export function ruleMatches(rule: string, address: string) {
  return addressGlob(rule.toLowerCase(),address);
}
export function validateRule(rule: string, domain: string) {
  const value = rule.trim().toLowerCase();
  const [local, host] = value.split('@');
  if (!local || !host || value.split('@').length !== 2 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || !/^[a-z0-9*.-]+$/.test(host)) throw new ApiError(422, 'INVALID_RULE', 'Rules look like support+*@example.com or *@help.example.com.', 'rules');
  const concrete = host.replace(/^\*\./, '');
  if (host.includes('*') && !host.startsWith('*.') || concrete.includes('*') || (concrete !== domain && !concrete.endsWith(`.${domain}`))) throw new ApiError(422, 'RULE_DOMAIN_MISMATCH', `Rules must stay within ${domain} or its subdomains.`, 'rules');
  if (/^\*{2,}$/.test(local) || value === `*@${domain}`) throw new ApiError(422, 'RULE_TOO_BROAD', 'A rule cannot claim every address on the domain; use the domain catch-all setting instead.', 'rules');
  return value;
}

export function checkTemporaryMailboxRouting(input: { aliases?: string[]; rules?: string[] }) {
  if (input.aliases?.length || input.rules?.length) throw new ApiError(422, 'TEMPORARY_MAILBOX_ROUTING', 'Temporary mailboxes do not support aliases or wildcard rules.', input.aliases?.length ? 'aliases' : 'rules');
}
export async function checkRuleCapacity(tx:DbExecutor,wid:string,domain:string,except='') {
  if ((await tx.execute(sql`SELECT FROM mailboxes WHERE workspace_id=${wid} AND domain_id=${domain} AND id<>${except} AND expires_at IS NULL AND rules<>'[]'::jsonb ORDER BY created_at,id LIMIT 1 OFFSET 63`)).rowCount)throw new ApiError(409,'MAILBOX_RULE_LIMIT','At most 64 addresses per domain can have wildcard rules.');
}

/** Creates a mailbox with its primary address and aliases. Addresses stay reserved until deletion. */
export async function createMailbox(tx: DbExecutor, scope: Scope, input: { key?:string|null;domainId: string; domainName: string; address: string; displayName?: string | null; aliases?: string[]; rules?: string[]; metadata?: Record<string, unknown>; origin: 'api' | 'auto'; sendLimits?: Partial<SendLimits>; requireDmarc?: boolean; ttlSeconds?: number }) {
  const address = input.address.trim().toLowerCase();
  if (input.ttlSeconds !== undefined) checkTemporaryMailboxRouting(input);
  const aliases = [...new Set((input.aliases ?? []).map(value => value.trim().toLowerCase()))].filter(value => value !== address);
  for (const value of [address, ...aliases]) if (!ADDRESS.test(value) || !value.endsWith(`@${input.domainName}`)) throw new ApiError(422, 'ADDRESS_DOMAIN_MISMATCH', `Addresses must be valid and end in @${input.domainName}.`, 'address');
  const rules = [...new Set((input.rules ?? []).map(rule => validateRule(rule, input.domainName)))];
  if(rules.length)await checkRuleCapacity(tx,scope.workspaceId,input.domainId);
  const all = [address, ...aliases];
  if((await tx.execute(sql`SELECT 1 FROM mail_retired_addresses WHERE workspace_id=${scope.workspaceId} AND address=ANY(${sql.param(all)}::text[]) AND until>now() LIMIT 1`)).rowCount)throw new ApiError(409,'ADDRESS_RETIRED','This address was recently retired.');
  const taken = await tx.select({ address: mailboxAddresses.address }).from(mailboxAddresses).where(and(eq(mailboxAddresses.workspaceId, scope.workspaceId), inArray(mailboxAddresses.address, all)));
  if (taken.length) throw new ApiError(409, 'ADDRESS_TAKEN', `${taken[0]!.address} already belongs to a mailbox.`, 'address');
  const mailboxId = id('mbx');
  // Start the lease after acquiring the address lock, not at transaction start before any wait.
  const lease = input.ttlSeconds === undefined ? {} : { createdAt: sql`statement_timestamp()`, updatedAt: sql`statement_timestamp()`, expiresAt: sql`statement_timestamp() + ${input.ttlSeconds}::int * interval '1 second'` };
  const [row] = await tx.insert(mailboxes).values({ id: mailboxId,key:input.key, ...scope, domainId: input.domainId, address, displayName: input.displayName ?? null, rules, metadata: input.metadata ?? {}, origin: input.origin, sendLimits: input.sendLimits ?? {}, requireDmarc: input.requireDmarc ?? false, ...lease }).returning();
  await tx.insert(mailboxAddresses).values(all.map((value, index) => ({ ...scope, address: value, mailboxId, kind: index === 0 ? 'primary' as const : 'alias' as const })));
  return row!;
}

/** Adds a stored message to mailboxes and updates each mailbox's thread summary. Returns mailboxes that newly received it. */
export async function attachToMailboxes(tx: DbExecutor, scope: Scope, message: typeof mailMessages.$inferSelect, mailboxIds: string[]) {
  if (!mailboxIds.length) return [];
  const inbound = message.direction === 'inbound';
  const result=await tx.execute<{mailbox_id:string}>(sql`WITH states AS MATERIALIZED (SELECT inbox_id FROM inbox_state WHERE workspace_id=${scope.workspaceId} AND inbox_id=ANY(${sql.param(mailboxIds)}::text[]) ORDER BY inbox_id FOR UPDATE), added AS (
    INSERT INTO mailbox_messages(mailbox_id,message_id,workspace_id,thread_id,direction,read,received_at)
    SELECT box,${message.id},${scope.workspaceId},${message.threadId},${message.direction},${!inbound},${message.receivedAt}::timestamptz FROM jsonb_array_elements_text(${JSON.stringify(mailboxIds)}::jsonb) b(box) WHERE (SELECT count(*) FROM states)>=0 ORDER BY box ON CONFLICT DO NOTHING RETURNING *
  ) INSERT INTO mailbox_threads AS t(mailbox_id,thread_id,workspace_id,message_count,unread_count,last_message_at,last_inbound_at,spam,labels)
    SELECT mailbox_id,thread_id,workspace_id,1,${inbound?1:0},received_at,CASE WHEN ${inbound} THEN received_at END,${message.spam},CASE WHEN ${message.spam} THEN ARRAY['spam'] ELSE ARRAY[]::text[] END FROM added ORDER BY mailbox_id
    ON CONFLICT(mailbox_id,thread_id) DO UPDATE SET message_count=t.message_count+1,unread_count=t.unread_count+excluded.unread_count,last_message_at=greatest(t.last_message_at,excluded.last_message_at),last_inbound_at=greatest(t.last_inbound_at,excluded.last_inbound_at),archived=CASE WHEN excluded.last_inbound_at IS NOT NULL THEN false ELSE t.archived END RETURNING mailbox_id`);
  return result.rows.map(row=>row.mailbox_id);
}
