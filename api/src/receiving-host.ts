import { sql } from 'drizzle-orm';
import type { DbExecutor } from './core.js';
import type { MxReport } from './db/mailbox.js';
import { checkMx, delegatedZone } from './mailbox-dns.js';
import { isProofRecord, type IdentityFacts } from './states.js';

/**
 * Hosted receiving hosts. A domain receives on its root only when the root already points at SES (or the
 * owner chose it); otherwise on the first of these subdomains that has no MX and no CNAME of its own.
 */
export const receivingLabels = ['reply', 'inbound', 'mail', 'inbox', 'incoming', 'replies'] as const;
export const receivingCandidates = (domain: string) => receivingLabels.map(label => `${label}.${domain}`);

export type ReceivingIssueCode = 'cname' | 'foreign_mx' | 'split' | 'wildcard' | 'bane_record' | 'host_taken' | 'claimed' | 'delegated' | 'mx_missing' | 'wrong_region' | 'null_mx';
/** Why receiving at `host` needs the owner's attention. `blocking` issues can't work until DNS changes. */
export type ReceivingIssue = { code: ReceivingIssueCode; host: string; blocking: boolean; message: string; provider?: string | null; target?: string | null; suggestion?: string | null };
export type ReceivingObservation = { mx: MxReport; note?: string; issue: ReceivingIssue | null };
type Ses = IdentityFacts['ses'] | undefined;

/** The records Bane itself publishes for a domain. The receiving MX may never share a name with one of them. */
export function baneRecordUse(host: string, domain: string, ses: Ses): string | null {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (name === ses?.MailFromAttributes?.MailFromDomain?.toLowerCase()) return 'custom MAIL FROM subdomain';
  if (isProofRecord(name, domain)) return 'ownership TXT record';
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

/** The names from `host` up to, but not including, the claim's own name: a.b.example.com → a.b.example.com, b.example.com. */
const namesUnder = (host: string, domain: string) => {
  const names: string[] = [];
  for (let name = host; name !== domain && name.endsWith(`.${domain}`); name = name.slice(name.indexOf('.') + 1)) names.push(name);
  return names;
};
/**
 * Who else holds each host. `taken`: another claim, in any workspace, already routes it (domain_claims_receiving_host
 * keeps hosts unique). `claimed`: another workspace claimed the host or a name between it and this claim, in any scope
 * (send-only included); that name is theirs, so the parent claim must never receive its mail.
 */
async function hostOwners(db: Pick<DbExecutor, 'execute'>, hosts: string[], wid: string, domain: string) {
  const names = [...new Set(hosts.flatMap(host => namesUnder(host, domain)))];
  const [routed, claims] = await Promise.all([
    db.execute<{ host: string; own: boolean; name: string }>(sql`SELECT receiving_host AS host,workspace_id=${wid} AS own,name FROM domain_claims
      WHERE receiving_host IN (SELECT jsonb_array_elements_text(${JSON.stringify(hosts)}::jsonb)) AND NOT (workspace_id=${wid} AND name=${domain})`),
    names.length ? db.execute<{ name: string }>(sql`SELECT DISTINCT name FROM domain_claims WHERE name IN (SELECT jsonb_array_elements_text(${JSON.stringify(names)}::jsonb)) AND workspace_id<>${wid} AND (ever_proven OR claim_scope='account')`) : { rows: [] },
  ]);
  const claimed = new Set(claims.rows.map(row => row.name));
  return {
    taken: new Map(routed.rows.map(row => [row.host, row])),
    claimed: new Map(hosts.flatMap(host => { const name = namesUnder(host, domain).find(n => claimed.has(n)); return name ? [[host, name] as const] : []; })),
  };
}
type Owners = Awaited<ReturnType<typeof hostOwners>>;
const instead = (suggestion: string | null) => suggestion ? ` Use ${suggestion} for receiving instead.` : '';
export function takenIssue(host: string, owner: { own: boolean; name: string }, suggestion: string | null): ReceivingIssue {
  return { code: 'host_taken', host, blocking: true, suggestion, message: `${host} already receives mail ${owner.own ? `through ${owner.name} in this workspace` : 'in another Bane workspace'}.${instead(suggestion)}` };
}
export function claimedIssue(host: string, claimed: string, suggestion: string | null): ReceivingIssue {
  return { code: 'claimed', host, blocking: true, suggestion, message: `${claimed === host ? host : `${claimed}, which contains ${host},`} is claimed by another Bane workspace, so its mail can’t be received here.${instead(suggestion)}` };
}
export function delegatedIssue(host: string, suggestion: string | null): ReceivingIssue {
  return { code: 'delegated', host, blocking: true, suggestion, message: `${host} is a delegated zone with its own name servers, so it’s managed separately and its mail can’t be received through this domain.${instead(suggestion)}` };
}
/** Bane's own names first, then other claims and delegation: the reason a host can never receive here, or null. */
function refusal(host: string, domain: string, ses: Ses, region: string, owners: Owners, delegated: boolean, suggestion: string | null) {
  const owner = owners.taken.get(host), claimed = owners.claimed.get(host);
  return baneRecordIssue(host, domain, ses, region, suggestion) ?? (owner ? takenIssue(host, owner, suggestion) : claimed ? claimedIssue(host, claimed, suggestion) : delegated ? delegatedIssue(host, suggestion) : null);
}

/**
 * Every DNS lookup of one check shares one time budget, so a failing resolver costs at most DNS_BUDGET_MS in total, and
 * lookups for several hosts run in parallel. Each host is looked up once per check: MX (or CNAME) and, below the
 * claim's own name, NS. `close` cancels lookups nobody needs any more.
 */
const DNS_BUDGET_MS = 5000;
type Probe = { mx: MxReport; delegated: boolean };
function dnsBudget(domain: string, region: string, unavailable: () => Error) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), DNS_BUDGET_MS), seen = new Map<string, Promise<Probe>>();
  const probe = (host: string) => {
    let pending = seen.get(host);
    if (!pending) {
      pending = Promise.all([checkMx(host, region, controller.signal), host === domain || host.startsWith('*.') ? false : delegatedZone(host, controller.signal)]).then(([mx, delegated]) => {
        if (mx.state === 'error' || delegated === null) throw unavailable();
        return { mx, delegated };
      });
      pending.catch(() => undefined); // Speculative probes may never be awaited.
      seen.set(host, pending);
    }
    return pending;
  };
  return { probe, close: () => { clearTimeout(timer); controller.abort(); } };
}
type Dns = ReturnType<typeof dnsBudget>;

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
  const domain = row.name, region = row.region, ses = row.identity?.ses, dns = dnsBudget(domain, region, unavailable);
  try {
    const candidates = receivingCandidates(domain);
    const choice = row.identity?.receivingChoice ?? null;
    if (choice && !row.receiving_host) return await inspectReceivingHost(db, row, wid, choice, unavailable, dns);
    const previous = row.identity?.mx?.expected.name;
    const order = [...new Set([...(previous && previous !== domain && previous.endsWith(`.${domain}`) ? [previous] : []), ...candidates])];
    // Every lookup this check may need starts now, in parallel; the answers are then read in candidate order.
    const ownersReady = hostOwners(db, [...new Set([...order, domain, ...(row.receiving_host ? [row.receiving_host] : [])])], wid, domain);
    const root = dns.probe(domain);
    const rootReason = (root: MxReport) => root.state === 'missing' || root.state === 'active' ? null
      : `${domain} ${root.state === 'cname' ? `is a CNAME${root.target ? ` to ${root.target}` : ''}` : root.state === 'null_mx' ? 'publishes a null MX' : `already routes mail to ${root.records.map(r => r.host).filter(h => h !== root.expected.value).join(', ')}`}.`;
    if (row.receiving_host) {
      // An established host is reported on where it is, never moved. Only when it can't work, or another provider
      // holds it, are the candidates checked for a free one to suggest.
      const host = row.receiving_host, [{ mx, delegated }, owners] = await Promise.all([dns.probe(host), ownersReady]);
      const blocked = refusal(host, domain, ses, region, owners, delegated, null);
      const alternative = blocked || ['cname', 'conflict', 'null_mx'].includes(mx.state) ? await freeReceivingHost(db, row, wid, unavailable, host, dns) : null;
      const issue = refusal(host, domain, ses, region, owners, delegated, alternative) ?? issueFor(host, mx, alternative, true);
      // A subdomain host keeps explaining why it isn't the root (the root is read again: it may have changed).
      const reason = mx.state === 'mixed' || host === domain ? null : rootReason((await root).mx);
      return { mx, ...(mx.state === 'mixed' ? { note: mx.message } : reason ? { note: `${reason} Keep its DNS and publish this MX on ${host} instead.` } : {}), issue };
    }
    const owners = await ownersReady;
    const usable = (host: string) => !baneRecordUse(host, domain, ses) && !owners.taken.has(host) && !owners.claimed.has(host);
    const probes = new Map(order.filter(usable).map(host => [host, dns.probe(host)]));
    const wildcard = dns.probe(`*.${domain}`).then(p => p.mx.state === 'missing' ? null : p.mx);
    const rootMx = (await root).mx;
    if (rootMx.state === 'active' && usable(domain)) return { mx: rootMx, issue: null };
    const reasons: string[] = [], rootTaken = rootReason(rootMx);
    if (rootTaken) reasons.push(rootTaken);
    const noteFor = (host: string) => reasons.length ? `${reasons.join(' ')} ${rootTaken ? 'Keep its DNS and p' : 'P'}ublish this MX on ${host} instead.` : undefined;
    let fallback: MxReport | undefined;
    for (const host of order) {
      const use = baneRecordUse(host, domain, ses), owner = owners.taken.get(host), claimed = owners.claimed.get(host);
      if (use || owner || claimed) {
        reasons.push(use ? `${host} is the ${use}.` : owner ? `${host} already receives mail ${owner.own ? `through ${owner.name}` : 'in another Bane workspace'}.` : `${claimed === host ? host : claimed} is claimed by another Bane workspace.`);
        continue;
      }
      const { mx, delegated } = await probes.get(host)!;
      if (delegated) { reasons.push(`${host} is a delegated zone with its own name servers.`); continue; }
      if (mx.state === 'missing' || mx.state === 'active') return { mx, note: noteFor(host), issue: null };
      // Our MX is published here next to others: this is the host the owner picked, so flag it instead of moving on.
      if (mx.state === 'mixed') return { mx, note: noteFor(host), issue: issueFor(host, mx, null, false) };
      // Something answers here. A wildcard answers the same for every candidate, so stop at the first one it explains.
      const any = await wildcard;
      if (caughtByWildcard(mx, any)) return { mx, note: noteFor(host), issue: wildcardIssue(host, domain, any!) };
      fallback ??= mx;
      reasons.push(mx.state === 'cname' ? `${host} is a CNAME${mx.target ? ` to ${mx.target}` : ''}.` : `${providerOf(mx) ?? 'Another mail server'} receives mail for ${host}.`);
    }
    // Every candidate is in use: suggest the first one that DNS answered for, and say exactly what is there.
    if (fallback) return { mx: fallback, issue: issueFor(fallback.expected.name, fallback, null, false) };
    const host = order[0]!, { mx, delegated } = await dns.probe(host);
    return { mx, issue: refusal(host, domain, ses, region, owners, delegated, null) };
  } finally { dns.close(); }
}

export function wildcardIssue(host: string, domain: string, wildcard: MxReport): ReceivingIssue {
  const what = wildcard.state === 'cname' ? `a wildcard CNAME (*.${domain} to ${wildcard.target})` : `a wildcard MX (*.${domain}, ${providerOf(wildcard) ?? wildcard.records.map(r => r.host).join(', ')})`;
  return { code: 'wildcard', host, blocking: false, provider: wildcard.state === 'cname' ? null : providerOf(wildcard), target: wildcard.target ?? null, suggestion: null,
    message: `${host} has no records of its own, but ${what} answers for it. Publishing Bane’s MX on ${host} gives it its own records, so the wildcard no longer applies to it${wildcard.state === 'cname' ? '' : ' and mail for it moves to Bane'}.` };
}

/** The first candidate with no MX, no CNAME, no delegation and no other use, checked in DNS in parallel. Null when every one is taken. */
export async function freeReceivingHost(db: Pick<DbExecutor, 'execute'>, row: HostedRow, wid: string, unavailable: () => Error, except: string, dns: Dns) {
  const domain = row.name, ses = row.identity?.ses, candidates = receivingCandidates(domain).filter(host => host !== except && !baneRecordUse(host, domain, ses));
  const probes = candidates.map(host => dns.probe(host)), owners = await hostOwners(db, candidates, wid, domain);
  for (const [index, host] of candidates.entries()) {
    if (owners.taken.has(host) || owners.claimed.has(host)) continue;
    const { mx, delegated } = await probes[index]!;
    if (mx.state === 'missing' && !delegated) return host;
  }
  return null;
}

/**
 * The checks for a host the owner chooses explicitly (POST /v1/domains/{id}/receiving-host): Bane's own names,
 * another claim or a name another workspace claimed, delegation, then public DNS. A synthesized wildcard answer is
 * not the host's own record, so it only flags. All lookups share one DNS budget.
 */
export async function inspectReceivingHost(db: Pick<DbExecutor, 'execute'>, row: HostedRow, wid: string, host: string, unavailable: () => Error, shared?: Dns): Promise<{ mx: MxReport; issue: ReceivingIssue | null }> {
  const domain = row.name, ses = row.identity?.ses, dns = shared ?? dnsBudget(domain, row.region, unavailable);
  try {
    const wildcard = host !== domain ? dns.probe(`*.${domain}`) : undefined;
    const [{ mx, delegated }, owners] = await Promise.all([dns.probe(host), hostOwners(db, [host], wid, domain)]);
    const suggest = () => freeReceivingHost(db, row, wid, unavailable, host, dns);
    if (refusal(host, domain, ses, row.region, owners, delegated, null)) return { mx, issue: refusal(host, domain, ses, row.region, owners, delegated, await suggest()) };
    if (mx.state === 'missing' || mx.state === 'active') return { mx, issue: null };
    if (wildcard && (mx.state === 'cname' || mx.state === 'conflict')) {
      const any = (await wildcard).mx;
      if (caughtByWildcard(mx, any.state === 'missing' ? null : any)) return { mx, issue: wildcardIssue(host, domain, any) };
    }
    return { mx, issue: issueFor(host, mx, mx.state === 'cname' || mx.state === 'conflict' ? await suggest() : null, false) };
  } finally { if (!shared) dns.close(); }
}
