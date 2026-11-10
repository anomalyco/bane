import { sql } from 'drizzle-orm';
import type { DbExecutor } from './core.js';
import type { MxReport } from './db/mailbox.js';
import { checkMx } from './mailbox-dns.js';
import type { IdentityFacts } from './states.js';

/**
 * Hosted receiving hosts. A domain receives on its root only when the root already points at SES (or the
 * owner chose it); otherwise on the first of these subdomains that has no MX and no CNAME of its own.
 */
export const receivingLabels = ['reply', 'inbound', 'mail', 'inbox', 'incoming', 'replies'] as const;
export const receivingCandidates = (domain: string) => receivingLabels.map(label => `${label}.${domain}`);

export type ReceivingIssueCode = 'cname' | 'foreign_mx' | 'split' | 'wildcard' | 'bane_record' | 'host_taken' | 'mx_missing' | 'wrong_region' | 'null_mx';
/** Why receiving at `host` needs the owner's attention. `blocking` issues can't work until DNS changes. */
export type ReceivingIssue = { code: ReceivingIssueCode; host: string; blocking: boolean; message: string; provider?: string | null; target?: string | null; suggestion?: string | null };
export type ReceivingObservation = { mx: MxReport; note?: string; issue: ReceivingIssue | null };
type Ses = IdentityFacts['ses'] | undefined;

/** The records Bane itself publishes for a domain. The receiving MX may never share a name with one of them. */
export function baneRecordUse(host: string, domain: string, ses: Ses): string | null {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (name === ses?.MailFromAttributes?.MailFromDomain?.toLowerCase()) return 'custom MAIL FROM subdomain';
  if (name === `_bane.${domain}` || name === `_opensend.${domain}`) return 'ownership TXT record';
  if (name === `_dmarc.${domain}`) return 'DMARC record';
  if (name.endsWith(`._domainkey.${domain}`) || ses?.DkimAttributes?.Tokens?.some(token => name === `${token}._domainkey.${domain}`)) return 'DKIM CNAME';
  return null;
}
export function baneRecordIssue(host: string, domain: string, ses: Ses, region: string, suggestion: string | null): ReceivingIssue | null {
  const use = baneRecordUse(host, domain, ses);
  if (!use) return null;
  const why = use === 'custom MAIL FROM subdomain' ? `${host} is ${domain}’s custom MAIL FROM subdomain, so its MX must point to feedback-smtp.${region}.amazonses.com for bounces` : `${host} holds Bane’s ${use} for ${domain}`;
  return { code: 'bane_record', host, blocking: true, suggestion, message: `${why}; it can’t also receive mail.${suggestion ? ` Use ${suggestion} for receiving instead.` : ''}` };
}

/** The suggestion before any DNS check (record generation): the first candidate that isn't one of Bane's own names. */
export function defaultReceivingHost(domain: string, ses: Ses) {
  return receivingCandidates(domain).find(host => !baneRecordUse(host, domain, ses)) ?? `reply.${domain}`;
}

const providerOf = (mx: MxReport) => mx.providers.filter(name => name !== 'Amazon SES').join(', ') || null;
/** What an observed MX state means for receiving at `host`. Null when nothing needs attention. */
export function issueFor(host: string, mx: MxReport, suggestion: string | null, established: boolean): ReceivingIssue | null {
  const instead = suggestion && suggestion !== host ? ` Use ${suggestion} for receiving instead.` : '';
  switch (mx.state) {
    case 'cname': return { code: 'cname', host, blocking: true, target: mx.target ?? null, suggestion, message: `${host} is a CNAME${mx.target ? ` to ${mx.target}` : ''}, so it can’t also have an MX record (RFC 1034).${instead}` };
    case 'conflict': return { code: 'foreign_mx', host, blocking: false, provider: providerOf(mx), suggestion,
      message: `${providerOf(mx) ?? 'Another mail server'} receives mail for ${host}${mx.split ? ` through ${mx.records.length} MX records` : ''}. Publishing Bane’s MX there moves that mail to Bane; remove the other MX records only if that’s what you want.${instead}` };
    case 'mixed': return { code: 'split', host, blocking: false, provider: providerOf(mx), suggestion: null, message: mx.message };
    case 'wrong_region': return { code: 'wrong_region', host, blocking: false, suggestion: null, message: mx.message };
    case 'null_mx': return { code: 'null_mx', host, blocking: false, suggestion, message: `${host} publishes a null MX, which tells senders it accepts no mail.${instead || ` Replace it with ${mx.expected.value}.`}` };
    case 'missing': return established ? { code: 'mx_missing', host, blocking: false, suggestion: null, message: `The MX record on ${host} is gone, so mail to it isn’t reaching Bane. Publish it again: ${mx.expected.value}, priority ${mx.expected.priority}.` } : null;
    default: return null;
  }
}

/** Receiving hosts already routed by another claim, in any workspace (domain_claims_receiving_host keeps them unique). */
async function takenHosts(db: Pick<DbExecutor, 'execute'>, hosts: string[], wid: string, name: string) {
  const rows = (await db.execute<{ host: string; own: boolean; name: string }>(sql`SELECT receiving_host AS host,workspace_id=${wid} AS own,name FROM domain_claims
    WHERE receiving_host IN (SELECT jsonb_array_elements_text(${JSON.stringify(hosts)}::jsonb)) AND NOT (workspace_id=${wid} AND name=${name})`)).rows;
  return new Map(rows.map(row => [row.host, row]));
}
export function takenIssue(host: string, owner: { own: boolean; name: string }, suggestion: string | null): ReceivingIssue {
  return { code: 'host_taken', host, blocking: true, suggestion, message: `${host} already receives mail ${owner.own ? `through ${owner.name} in this workspace` : 'in another Bane workspace'}.${suggestion ? ` Use ${suggestion} for receiving instead.` : ''}` };
}

const sameHosts = (a: MxReport, b: MxReport) => a.records.length > 0 && a.records.map(r => r.host).sort().join() === b.records.map(r => r.host).sort().join();
/** A wildcard (*.domain) CNAME or MX answers for every subdomain without its own records. */
const caughtByWildcard = (mx: MxReport, wildcard: MxReport | null) => !!wildcard && (mx.state === 'cname' ? wildcard.state === 'cname' && wildcard.target === mx.target : wildcard.state !== 'cname' && sameHosts(mx, wildcard));

type HostedRow = { name: string; region: string; receiving_host: string | null; identity: (IdentityFacts & { receivingChoice?: string | null }) | null };

/**
 * One receiving observation for a hosted claim, from public DNS only. Used by "Check MX now" (domain.verify),
 * the hourly sweep (domain.mx) and an explicit choice. An established host is watched where it is: a conflict
 * that appears later is reported, never silently re-pointed. Otherwise the suggestion is the owner's choice,
 * the root when it already points here, or the first candidate that is free.
 */
export async function observeReceiving(db: Pick<DbExecutor, 'execute'>, row: HostedRow, wid: string, unavailable: () => Error): Promise<ReceivingObservation> {
  const domain = row.name, region = row.region, ses = row.identity?.ses;
  const check = async (host: string) => { const mx = await checkMx(host, region); if (mx.state === 'error') throw unavailable(); return mx; };
  const candidates = receivingCandidates(domain);
  const choice = row.identity?.receivingChoice ?? null;
  const taken = await takenHosts(db, [...new Set([...candidates, domain, ...(choice ? [choice] : []), ...(row.receiving_host ? [row.receiving_host] : [])])], wid, domain);
  const free = (host: string) => !baneRecordUse(host, domain, ses) && !taken.has(host);
  // A fixed host (established, or chosen by the owner after the same warnings) is reported on where it is. Only when it
  // can't work, or another provider holds it, are the candidates checked in DNS for a free one to suggest.
  const rootReason = (root: MxReport) => root.state === 'missing' || root.state === 'active' ? null
    : `${domain} ${root.state === 'cname' ? `is a CNAME${root.target ? ` to ${root.target}` : ''}` : root.state === 'null_mx' ? 'publishes a null MX' : `already routes mail to ${root.records.map(r => r.host).filter(h => h !== root.expected.value).join(', ')}`}.`;
  const fixed = async (host: string) => {
    const mx = await check(host), owner = taken.get(host);
    const alternative = !free(host) || ['cname', 'conflict', 'null_mx'].includes(mx.state) ? await freeReceivingHost(db, row, wid, unavailable, host) : null;
    const issue = baneRecordIssue(host, domain, ses, region, alternative) ?? (owner ? takenIssue(host, owner, alternative) : issueFor(host, mx, alternative, true));
    // A subdomain host keeps explaining why it isn't the root (the root is read again: it may have changed).
    const reason = mx.state === 'mixed' || host === domain ? null : rootReason(await check(domain));
    return { mx, ...(mx.state === 'mixed' ? { note: mx.message } : reason ? { note: `${reason} Keep its DNS and publish this MX on ${host} instead.` } : {}), issue };
  };
  if (row.receiving_host) return fixed(row.receiving_host);
  if (choice) return inspectReceivingHost(db, row, wid, choice, unavailable);
  const root = await check(domain);
  if (root.state === 'active' && free(domain)) return { mx: root, issue: null };
  const reasons: string[] = [], rootTaken = rootReason(root);
  if (rootTaken) reasons.push(rootTaken);
  const previous = row.identity?.mx?.expected.name;
  const order = [...new Set([...(previous && previous !== domain && previous.endsWith(`.${domain}`) ? [previous] : []), ...candidates])];
  const noteFor = (host: string) => reasons.length ? `${reasons.join(' ')} ${rootTaken ? 'Keep its DNS and p' : 'P'}ublish this MX on ${host} instead.` : undefined;
  let fallback: MxReport | undefined, wildcard: MxReport | null | undefined;
  for (const host of order) {
    const use = baneRecordUse(host, domain, ses), owner = taken.get(host);
    if (use || owner) { reasons.push(use ? `${host} is the ${use}.` : `${host} already receives mail ${owner!.own ? `through ${owner!.name}` : 'in another Bane workspace'}.`); continue; }
    const mx = await check(host);
    if (mx.state === 'missing' || mx.state === 'active') return { mx, note: noteFor(host), issue: null };
    // Our MX is published here next to others: this is the host the owner picked, so flag it instead of moving on.
    if (mx.state === 'mixed') return { mx, note: noteFor(host), issue: issueFor(host, mx, null, false) };
    // Something answers here. A wildcard answers the same for every candidate, so stop at the first one.
    if (wildcard === undefined) { const any = await check(`*.${domain}`); wildcard = any.state === 'missing' ? null : any; }
    if (caughtByWildcard(mx, wildcard)) return { mx, note: noteFor(host), issue: wildcardIssue(host, domain, wildcard!) };
    fallback ??= mx;
    reasons.push(mx.state === 'cname' ? `${host} is a CNAME${mx.target ? ` to ${mx.target}` : ''}.` : `${providerOf(mx) ?? 'Another mail server'} receives mail for ${host}.`);
  }
  // Every candidate is in use: suggest the first one that DNS answered for, and say exactly what is there.
  if (fallback) return { mx: fallback, issue: issueFor(fallback.expected.name, fallback, null, false) };
  const host = order[0]!;
  return { mx: { ...await check(host) }, issue: baneRecordIssue(host, domain, ses, region, null) ?? (taken.get(host) ? takenIssue(host, taken.get(host)!, null) : null) };
}

export function wildcardIssue(host: string, domain: string, wildcard: MxReport): ReceivingIssue {
  const what = wildcard.state === 'cname' ? `a wildcard CNAME (*.${domain} to ${wildcard.target})` : `a wildcard MX (*.${domain}, ${providerOf(wildcard) ?? wildcard.records.map(r => r.host).join(', ')})`;
  return { code: 'wildcard', host, blocking: false, provider: wildcard.state === 'cname' ? null : providerOf(wildcard), target: wildcard.target ?? null, suggestion: null,
    message: `${host} has no records of its own, but ${what} answers for it. Publishing Bane’s MX on ${host} gives it its own records, so the wildcard no longer applies to it${wildcard.state === 'cname' ? '' : ' and mail for it moves to Bane'}.` };
}

/** The first candidate with no MX, no CNAME and no other use, checked in DNS. Null when every one is taken. */
export async function freeReceivingHost(db: Pick<DbExecutor, 'execute'>, row: HostedRow, wid: string, unavailable: () => Error, except: string) {
  const domain = row.name, ses = row.identity?.ses, candidates = receivingCandidates(domain).filter(host => host !== except && !baneRecordUse(host, domain, ses));
  const taken = await takenHosts(db, candidates, wid, domain);
  for (const host of candidates) {
    if (taken.has(host)) continue;
    const mx = await checkMx(host, row.region);
    if (mx.state === 'error') throw unavailable();
    if (mx.state === 'missing') return host;
  }
  return null;
}

/**
 * The checks for a host the owner chooses explicitly (POST /v1/domains/{id}/receiving-host): Bane's own names,
 * another claim, then public DNS. A synthesized wildcard answer is not the host's own record, so it only flags.
 */
export async function inspectReceivingHost(db: Pick<DbExecutor, 'execute'>, row: HostedRow, wid: string, host: string, unavailable: () => Error): Promise<{ mx: MxReport; issue: ReceivingIssue | null }> {
  const domain = row.name, ses = row.identity?.ses;
  const mx = await checkMx(host, row.region);
  if (mx.state === 'error') throw unavailable();
  const suggest = () => freeReceivingHost(db, row, wid, unavailable, host);
  if (baneRecordUse(host, domain, ses)) return { mx, issue: baneRecordIssue(host, domain, ses, row.region, await suggest()) };
  const owner = (await takenHosts(db, [host], wid, domain)).get(host);
  if (owner) return { mx, issue: takenIssue(host, owner, await suggest()) };
  if (mx.state === 'missing' || mx.state === 'active') return { mx, issue: null };
  if (host !== domain && (mx.state === 'cname' || mx.state === 'conflict')) {
    const any = await checkMx(`*.${domain}`, row.region);
    if (any.state === 'error') throw unavailable();
    if (caughtByWildcard(mx, any.state === 'missing' ? null : any)) return { mx, issue: wildcardIssue(host, domain, any) };
  }
  return { mx, issue: issueFor(host, mx, mx.state === 'cname' || mx.state === 'conflict' ? await suggest() : null, false) };
}
