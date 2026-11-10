import { AsyncLocalStorage } from 'node:async_hooks';
import { copyWorkspaceRaw, PARSE_LIMIT } from './mailbox-mime.js';
import { storeIncoming } from './mailbox-ingest-store.js';
import { ingestInput,type IngestInput } from './mailbox-ingest-input.js';
import PostalMime, { addressParser, decodeWords, type Address, type Email } from 'postal-mime';
import { and, eq, sql } from 'drizzle-orm';
import { ApiError, digest, lazyModule, log, ModuleLoadError, type JobHandler, type Runtime } from './core.js';
import { JobDeferred, MAX_ATTEMPTS, retryDatabaseFailures } from './jobs.js';
import { mailAttachments, mailReceipts, type MailAddress, type MailHeader, type Verdicts } from './db/mailbox.js';
import { pruneMailboxEvents } from './mailbox-events.js';
import { mailboxS3, STAGING_PREFIX, workspacePrefix, refreshMailboxDns } from './mailbox-setup.js';
import { ADDRESS, messageIdList, normalizeMessageId, snippetOf, type Scope } from './mailbox-store.js';
import type { ReceivedNotification } from './mailbox-receipts.js';
import { scheduleMailRecovery, stagingJobs } from './mailbox-staging.js';
export { acceptInboundNotification } from './mailbox-receipts.js';

const loadIngestS3 = lazyModule(() => import('@aws-sdk/client-s3'));
const PARSE_LINE_LIMIT = 30_000;
const PARSE_ESCAPE_LIMIT = 131_072; // PostalMime escapeHtml expands [<>"'?&] 6x with per-match callbacks.
const DEGRADED_PARSE_LIMIT = 256 * 1024; // Raw byte cap if postal-mime's internal hook is unavailable.
const BODY_LIMIT = 1_000_000;
const MAX_ATTACHMENTS = 100; // More parts would exhaust the Worker subrequest budget; the message is stored without them.
const HEADER_LIMIT = 64 * 1024;

const flatten = (list: Address[] | Address | undefined): MailAddress[] => (Array.isArray(list) ? list : list ? [list] : []).flatMap(item => item.group ? item.group : [item])
  .filter(item => typeof item.address === 'string' && item.address.includes('@')).map(item => ({ name: item.name?.trim() || null, address: item.address!.trim().toLowerCase() }));
const verdict = (value: { status?: string } | undefined) => typeof value?.status === 'string' ? value.status : undefined;
function authenticatedFrom(email: Email | null, address: string, mail: ReceivedNotification['mail'], verdicts: Verdicts) {
  const dmarcPass = verdicts.dmarc === 'PASS', noDmarc = verdicts.dmarc === undefined || verdicts.dmarc === 'GRAY';
  if (!dmarcPass && !(noDmarc && verdicts.dkim === 'PASS')) return false;
  // DKIM signs the bottommost occurrence; the MIME parser reads the first Date. Reject ambiguity.
  if (!email || !ADDRESS.test(address) || email.headers.filter(h => h.key === 'date').length !== 1) return false;
  const from = email.headers.filter(h => h.key === 'from');
  const sesFrom = mail?.commonHeaders?.from;
  const matches = (value: string) => {
    if (!withinFieldLimit(value)) return false;
    // The display parser recovers addresses from malformed text (even multiple angle addresses).
    // Identity evidence must instead be one literal addr-spec, optionally with a display name.
    const field = value.trim().toLowerCase(), angle = `<${address}>`;
    if (field === address) return true;
    if (!field.endsWith(angle)) return false;
    const display = field.slice(0,-angle.length).trim();
    return !/[()<>@,;:\\"\[\]\x00-\x1f]/.test(display) || /^"(?:[^"\\\r\n]|\\[^\r\n])*"$/.test(display);
  };
  if (from.length !== 1 || !matches(from[0]!.value) || (sesFrom && (sesFrom.length !== 1 || !matches(sesFrom[0]!)))) return false;
  const signatures = email.headers.filter(h => h.key === 'dkim-signature');
  const domain = address.split('@')[1];
  // DMARC through SPF authenticates this delivery. If it could instead be a replay of a
  // passing DKIM signature, do not trust an unsigned Date even when DMARC passed.
  const envelope = mail?.source?.toLowerCase();
  const failedDkim = verdicts.dkim === 'FAIL' || verdicts.dkim === 'GRAY';
  const alignedSpf = verdicts.spf === 'PASS' && (failedDkim || (envelope && ADDRESS.test(envelope) && envelope.split('@')[1] === domain));
  if (dmarcPass && (alignedSpf || (!signatures.length && verdicts.dkim !== 'PASS'))) return true;
  // SES doesn't identify the passing signature. With DMARC, require every candidate to
  // cover the date. Without DMARC, only a sole, strictly aligned signature is attributable.
  if (!signatures.length || (!dmarcPass && signatures.length !== 1)) return false;
  return signatures.every(({value}) => {
    if (!withinFieldLimit(value)) return false;
    const tags = value.split(';').map(tag => tag.trim());
    const signed = tags.filter(tag => /^h\s*=/i.test(tag));
    const headers = signed.length === 1 && /^h[ \t]*=[ \t]*(.+)$/.exec(signed[0]!)?.[1]?.toLowerCase().split(':').map(name => name.trim());
    if (!headers || !headers.includes('from') || !headers.includes('date')) return false;
    const domains = tags.filter(tag => /^d\s*=/i.test(tag));
    return dmarcPass || (domains.length === 1 && /^d[ \t]*=[ \t]*([^\s]+)$/.exec(domains[0]!)?.[1]?.toLowerCase() === domain);
  });
}
const cap = (value: string | undefined | null) => value && value.length > BODY_LIMIT ? { value: value.slice(0, BODY_LIMIT), truncated: true } : { value: value ?? null, truncated: false };
function headersOf(email: Email | null): MailHeader[] {
  const out: MailHeader[] = []; let size = 0;
  for (const header of email?.headers ?? []) { if (header.key==='bcc' || header.key==='resent-bcc') continue; size += header.originalKey.length + header.value.length; if (size > HEADER_LIMIT || out.length >= 200) break; out.push({ name: header.originalKey, value: header.value }); }
  return out;
}
const AUTOMATED_HEADERS = new Set(['auto-submitted', 'precedence', 'x-autoreply', 'x-autorespond', 'content-type', 'from']);
const RAW_HEADER_SCAN_LIMIT = 2 * 1024 * 1024;
const RAW_HEADER_FIELD_LIMIT = 16 * 1024;
const utf8 = new TextEncoder();
// UTF-16 length bounds UTF-8 bytes from below and a third of them from above, so encoding only runs in the narrow middle band.
const withinFieldLimit = (value: string) => value.length * 3 <= RAW_HEADER_FIELD_LIMIT || (value.length <= RAW_HEADER_FIELD_LIMIT && utf8.encode(value).byteLength <= RAW_HEADER_FIELD_LIMIT);
const rawHeaderDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
let incompleteAutomatedHeaderScans = 0;
const trimWsp = (s: string) => {
  let a = 0, b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
};
function unfoldHeaderValue(s: string): string {
  const parts: string[] = [];
  let copyFrom = 0, i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 13 && c !== 10) { i++; continue; }
    if (i > copyFrom) parts.push(s.slice(copyFrom, i));
    while (i < s.length && s.charCodeAt(i) === 13) i++;
    if (i < s.length && s.charCodeAt(i) === 10) i++;
    else if (i < s.length) parts.push(' ');
    copyFrom = i;
  }
  if (copyFrom === 0) return trimWsp(s);
  if (copyFrom < s.length) parts.push(s.slice(copyFrom));
  return trimWsp(parts.join(''));
}
function stripHeaderComments(input: string): string {
  let out = '', depth = 0, commentStart = 0, quote = false, esc = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (esc) { if (depth === 0) out += ch; esc = false; continue; }
    if (ch === '\\' && (quote || depth > 0)) { esc = true; if (depth === 0) out += ch; continue; }
    if (depth === 0 && ch === '"') { quote = !quote; out += ch; continue; }
    if (!quote) {
      if (ch === '(') { if (depth === 0) commentStart = i; depth++; continue; }
      if (ch === ')' && depth > 0) { depth--; continue; }
    }
    if (depth === 0) out += ch;
  }
  return depth === 0 || input.indexOf(';', commentStart) < 0 ? out : input;
}
function unquoteMimeToken(s: string): string {
  const t = trimWsp(s);
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/\\([\s\S])/g, '$1') : t;
}
function parseStructuredField(raw: string): { value: string; params: Map<string, string> } {
  const cleaned = stripHeaderComments(raw);
  const parts: string[] = [];
  let cur = '', quote = false, esc = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    if (esc) { cur += ch; esc = false; continue; }
    if (quote && ch === '\\') { cur += ch; esc = true; continue; }
    if (ch === '"') { quote = !quote; cur += ch; continue; }
    if (!quote && ch === ';') { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  const decodedHead = trimWsp(decodeWords(unquoteMimeToken(parts[0] ?? '')));
  const semi = decodedHead.indexOf(';');
  const value = (semi < 0 ? decodedHead : trimWsp(decodedHead.slice(0, semi))).toLowerCase();
  const params = new Map<string, string>();
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]!, eq = p.indexOf('=');
    if (eq < 0) continue;
    const k = trimWsp(p.slice(0, eq)).toLowerCase();
    if (k && !params.has(k)) params.set(k, trimWsp(decodeWords(unquoteMimeToken(p.slice(eq + 1)))).toLowerCase());
  }
  return { value, params };
}
function rawAutomatedHeaders(raw: Uint8Array): Map<string, string> | null {
  const out = new Map<string, string>();
  const head = raw.subarray(0, Math.min(raw.byteLength, RAW_HEADER_SCAN_LIMIT));
  let pos = 0, ended = false, capped = false;
  while (pos < head.byteLength) {
    const start = pos;
    let nl = head.indexOf(10, pos);
    const lineEnd = nl < 0 ? head.byteLength : nl;
    let firstEnd = lineEnd;
    while (firstEnd > pos && head[firstEnd - 1] === 13) firstEnd--;
    if (firstEnd === pos) { ended = nl >= 0; break; }
    if (nl < 0 && raw.byteLength > head.byteLength) break;
    pos = nl < 0 ? head.byteLength : nl + 1;
    let foldTruncated = false;
    while (pos < head.byteLength && (head[pos] === 32 || head[pos] === 9)) {
      nl = head.indexOf(10, pos);
      if (nl < 0 && raw.byteLength > head.byteLength) { foldTruncated = true; break; }
      pos = nl < 0 ? head.byteLength : nl + 1;
    }
    if (foldTruncated) break;
    let k = start;
    while (k < firstEnd && (head[k] === 32 || head[k] === 9)) k++;
    let key = '';
    while (k < pos && key.length <= 14) {
      const b = head[k]!;
      if (b === 58 || b === 32 || b === 9 || b === 13 || b === 10) break;
      key += String.fromCharCode(b >= 65 && b <= 90 ? b + 32 : b);
      k++;
    }
    if (!AUTOMATED_HEADERS.has(key) || out.has(key)) continue;
    while (k < pos) {
      if (head[k] === 32 || head[k] === 9 || head[k] === 10) { k++; continue; }
      if (head[k] === 13) {
        let cr = k;
        while (cr < pos && head[cr] === 13) cr++;
        if (cr < pos && head[cr] === 10) { k = cr + 1; continue; }
      }
      break;
    }
    if (k >= pos || head[k] !== 58) continue;
    let v = k + 1;
    while (v < pos && (head[v] === 32 || head[v] === 9 || head[v] === 13 || head[v] === 10)) {
      if (head[v] === 13) {
        let cr = v;
        while (cr < pos && head[cr] === 13) cr++;
        if (cr < pos && head[cr] === 10) { v = cr + 1; continue; }
        v = cr;
        continue;
      }
      v++;
    }
    if (pos - v > RAW_HEADER_FIELD_LIMIT) { capped = true; break; }
    out.set(key, unfoldHeaderValue(rawHeaderDecoder.decode(head.subarray(v, pos))));
  }
  return ended && !capped ? out : null;
}
function automated(email: Email | null, raw: Uint8Array, from: string) {
  let fallback: Map<string, string> | null = null;
  if (!email) {
    fallback = rawAutomatedHeaders(raw);
    if (!fallback) {
      log('warn', { code: 'MAILBOX_AUTOMATED_HEADER_SCAN_INCOMPLETE', count: ++incompleteAutomatedHeaderScans });
      return false;
    }
  }
  let parsedCapped = false;
  const header = (name: string) => {
    if (!email) return fallback!.get(name) ?? '';
    const value = email.headers.find(item => item.key === name)?.value ?? '';
    if (withinFieldLimit(value)) return value;
    parsedCapped = true;
    return '';
  };
  const auto = parseStructuredField(header('auto-submitted')).value;
  const precedence = parseStructuredField(header('precedence')).value;
  const contentType = parseStructuredField(header('content-type'));
  const report = contentType.value === 'multipart/report' && /^(?:(?:global-)?delivery-status|(?:global-)?disposition-notification)$/.test(contentType.params.get('report-type') ?? '');
  const xAutoreply = trimWsp(decodeWords(stripHeaderComments(header('x-autoreply'))));
  const xAutorespond = trimWsp(decodeWords(stripHeaderComments(header('x-autorespond'))));
  const rawFrom = fallback?.get('from') ?? '';
  const rawSenders = rawFrom ? flatten(addressParser(rawFrom)).map(item => item.address) : [];
  const daemonSender = /^(?:mailer-daemon|postmaster)@/.test(from) || rawSenders.some(addr => /^(?:mailer-daemon|postmaster)@/.test(addr));
  if ((auto !== '' && auto !== 'no') || /^(?:bulk|junk|list|auto[-_]reply)$/.test(precedence) || !!xAutoreply || !!xAutorespond || daemonSender || report) return true;
  if (parsedCapped) log('warn', { code: 'MAILBOX_AUTOMATED_HEADER_SCAN_INCOMPLETE', count: ++incompleteAutomatedHeaderScans });
  return false;
}
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
function withinLineLimit(raw: Uint8Array) {
  let lines = raw.byteLength > 0 && raw[raw.byteLength - 1] !== 10 ? 1 : 0;
  for (let i = 0; i < raw.byteLength; i++) if (raw[i] === 10 && ++lines > PARSE_LINE_LIMIT) return false;
  return lines <= PARSE_LINE_LIMIT;
}
function countEscaped(value: string | undefined, count: number) {
  if (!value) return count;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 63 && (c === 60 || c === 62 || c === 34 || c === 39 || c === 63 || c === 38) && ++count > PARSE_ESCAPE_LIMIT) return count;
  }
  return count;
}
function countAddressesEscaped(list: Address[] | undefined, count: number): number {
  for (const addr of list ?? []) {
    if (addr.group) {
      count = countEscaped(addr.name, count);
      if (count <= PARSE_ESCAPE_LIMIT) count = countAddressesEscaped(addr.group, count);
    } else {
      count = countEscaped(addr.address, count);
      if (count <= PARSE_ESCAPE_LIMIT) count = addr.name ? countEscaped(addr.name, count) : countEscaped(addr.address, count + 2);
    }
    if (count > PARSE_ESCAPE_LIMIT) return count;
  }
  return count;
}
function countHeaderEscaped(msg: Email, count: number) {
  if (msg.from) { count = countAddressesEscaped([msg.from], count); if (count > PARSE_ESCAPE_LIMIT) return count; }
  if (msg.subject) { count = countEscaped(msg.subject, count); if (count > PARSE_ESCAPE_LIMIT) return count; }
  if (msg.date) {
    count = countEscaped(msg.date, count);
    if (count <= PARSE_ESCAPE_LIMIT && Number.isNaN(Date.parse(msg.date))) count = countEscaped(msg.date, count);
    if (count > PARSE_ESCAPE_LIMIT) return count;
  }
  for (const list of [msg.to, msg.cc, msg.bcc]) if (list?.length) { count = countAddressesEscaped(list, count); if (count > PARSE_ESCAPE_LIMIT) return count; }
  return count;
}
type InternalEntry = { type: 'text'; value: string } | { type: 'subMessage'; value: Email };
type InternalParser = { textTypes: Set<string>; textMap: Map<unknown, { plain?: InternalEntry[]; html?: InternalEntry[] }> };
const escapeBudgetStore = new AsyncLocalStorage<{ count: number }>();
const postalProto = PostalMime.prototype as unknown as {
  parse?: (this: unknown, buf: unknown) => Promise<Email>;
  renderTextContent?: (this: InternalParser) => void;
};
const origParse = postalProto.parse;
const origRenderTextContent = postalProto.renderTextContent;
let escapeGuardWarned = false;
function warnMissingEscapeGuard() {
  if (escapeGuardWarned) return;
  escapeGuardWarned = true;
  log('warn', { code: 'MAILBOX_MIME_ESCAPE_GUARD_UNAVAILABLE' });
}
const guardedRenderTextContent = function (this: InternalParser) {
  if (this.textTypes.has('html')) {
    const budget = escapeBudgetStore.getStore() ?? { count: 0 };
    let count = budget.count;
    for (const entry of this.textMap.values()) {
      const own = entry.html;
      for (const item of own || entry.plain || []) {
        count = item.type === 'subMessage' ? countHeaderEscaped(item.value, count) : !own ? countEscaped(item.value, count) : count;
        if (count > PARSE_ESCAPE_LIMIT) { budget.count = count; throw new RangeError('MIME entity expansion limit exceeded'); }
      }
    }
    budget.count = count;
  }
  return origRenderTextContent!.call(this);
};
const escapeGuardInstalled = (() => {
  try {
    if (typeof origParse !== 'function' || typeof origRenderTextContent !== 'function') return false;
    const probe = new PostalMime() as unknown as Partial<InternalParser>;
    if (!(probe.textTypes instanceof Set) || !(probe.textMap instanceof Map)) return false;
    postalProto.parse = function (buf: unknown) {
      return escapeBudgetStore.getStore() ? origParse.call(this, buf) : escapeBudgetStore.run({ count: 0 }, () => origParse.call(this, buf));
    };
    postalProto.renderTextContent = guardedRenderTextContent;
    return true;
  } catch {
    return false;
  }
})();
if (!escapeGuardInstalled) warnMissingEscapeGuard();
export const isPostalMimeEscapeGuardInstalled = () => escapeGuardInstalled && postalProto.renderTextContent === guardedRenderTextContent;
export async function parseInboundMime(raw: Uint8Array): Promise<Email | null> {
  if (raw.byteLength > PARSE_LIMIT || !withinLineLimit(raw)) return null;
  if (!isPostalMimeEscapeGuardInstalled()) {
    warnMissingEscapeGuard();
    if (raw.byteLength > DEGRADED_PARSE_LIMIT) return null;
  }
  try { return await escapeBudgetStore.run({ count: 0 }, () => PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' })); }
  catch { return null; }
}

const ingestJob = async (runtime:Runtime, payload:Parameters<JobHandler>[1], job:Parameters<JobHandler>[2],reserveMime:(size:number)=>void) => {
  const scope: Scope = { workspaceId: job.workspaceId };
  const sesMessageId = String(payload.sesMessageId ?? '');
  const receipt=job.ingest!==undefined?job.ingest:(await runtime.db.execute<{input:IngestInput|null}>(sql`SELECT ${ingestInput(runtime.config.multiTenant,scope.workspaceId,sesMessageId)} AS input`)).rows[0]?.input;
  if(!receipt)return;
  const notification = receipt.notification as ReceivedNotification;
  const s3 = await mailboxS3(runtime,scope.workspaceId,receipt.region,receipt.bucket,runtime.db,receipt.binding);
  const sourceKey=(!runtime.config.multiTenant && (receipt.notification.legacy || receipt.objectKey.startsWith('raw/'))?'raw/':STAGING_PREFIX)+sesMessageId;
  const rawKey=workspacePrefix(scope.workspaceId,'raw')+sesMessageId+'.eml';
  const verdicts: Verdicts = { spf: verdict(notification.receipt?.spfVerdict), dkim: verdict(notification.receipt?.dkimVerdict), dmarc: verdict(notification.receipt?.dmarcVerdict), spam: verdict(notification.receipt?.spamVerdict), virus: verdict(notification.receipt?.virusVerdict) };
  const spam=verdicts.spam!=='PASS';
  const quarantine=verdicts.virus!=='PASS'?'MAILBOX_VIRUS_QUARANTINED':spam && receipt.spamPolicy==='quarantine'?'MAILBOX_SPAM_QUARANTINED':null;
  if(quarantine){
    try {
      const {CopyObjectCommand}=await loadIngestS3();
      await s3.send(new CopyObjectCommand({Bucket:receipt.bucket,Key:'quarantine/'+sesMessageId,CopySource:`${receipt.bucket}/${sourceKey}`,CopySourceIfMatch:receipt.notification.stagingEtag as string|undefined,TaggingDirective:'REPLACE'}));
      log('warn',{code:quarantine,workspaceId:scope.workspaceId,virus:verdicts.virus??'missing',spam:verdicts.spam??'missing'});
      await runtime.db.update(mailReceipts).set({status:'failed',error:quarantine,processedAt:new Date().toISOString()}).where(and(eq(mailReceipts.workspaceId,scope.workspaceId),eq(mailReceipts.sesMessageId,sesMessageId),eq(mailReceipts.status,'pending')));
      return;
    } finally {s3.destroy();}
  }
  const readStarted=performance.now();
  let copied:Awaited<ReturnType<typeof copyWorkspaceRaw>>;
  try {
    copied=await copyWorkspaceRaw(s3,receipt.region,receipt.bucket,sourceKey,rawKey,receipt.recipients,'raw',receipt.notification.stagingEtag as string|undefined,async size=>{
      reserveMime(size);
      const reserved=await runtime.db.execute(sql`WITH r AS MATERIALIZED (SELECT reserved_bytes FROM mail_receipts WHERE workspace_id=${scope.workspaceId} AND ses_message_id=${sesMessageId} AND status='pending' FOR UPDATE),
        debit AS (INSERT INTO mail_receive_windows AS w SELECT ${scope.workspaceId},date_trunc('hour',now()),0,${size}::bigint FROM r WHERE reserved_bytes IS NULL AND ${size}::bigint<=coalesce((SELECT byte_limit FROM mail_receive_limits WHERE workspace_id=${scope.workspaceId}),68719476736)
          ON CONFLICT(workspace_id) DO UPDATE SET bytes=CASE WHEN w.window_at=excluded.window_at THEN w.bytes ELSE 0 END+excluded.bytes,messages=CASE WHEN w.window_at=excluded.window_at THEN w.messages ELSE 0 END,window_at=excluded.window_at
          WHERE (CASE WHEN w.window_at=excluded.window_at THEN w.bytes ELSE 0 END)+excluded.bytes<=coalesce((SELECT byte_limit FROM mail_receive_limits WHERE workspace_id=${scope.workspaceId}),68719476736) RETURNING 1),
        charged AS (UPDATE mail_receipts SET reserved_bytes=${size} WHERE workspace_id=${scope.workspaceId} AND ses_message_id=${sesMessageId} AND EXISTS(SELECT FROM debit) RETURNING 1)
        SELECT FROM charged UNION ALL SELECT FROM r WHERE reserved_bytes=${size}`);
      if(!reserved.rowCount)throw new ApiError(422,'MAILBOX_BYTE_BUDGET','Receipt exceeds the workspace byte budget.');
    });
  } catch (error) {
    s3.destroy();
    if (error instanceof JobDeferred || error instanceof ModuleLoadError || error instanceof ApiError) throw error;
    if (error instanceof Error && ['NoSuchKey','NotFound'].includes(error.name)) throw new ApiError(404,'RAW_MESSAGE_MISSING','The staging object is missing.');
    if (error instanceof Error && error.name==='AccessDenied') throw new ApiError(403,'MAILBOX_RAW_ACCESS_DENIED','Access to the mailbox object was denied.');
    throw new ApiError(503, 'MAILBOX_RAW_UNAVAILABLE', 'The stored message could not be read from S3; retrying.', undefined, true);
  }
  const rawMs=performance.now()-readStarted,{bytes:raw,sizeBytes}=copied;
  const email = copied.large ? null : await parseInboundMime(raw);
  const status = email ? 'received' : 'unparsed';
  const common = notification.mail?.commonHeaders ?? {};
  const messageRowId = `msg_${(await digest(`${scope.workspaceId}:${sesMessageId}`)).slice(0, 32)}`;
  const commonFrom = common.from?.[0] && withinFieldLimit(common.from[0]) ? flatten(addressParser(common.from[0]))[0] : undefined;
  const from = flatten(email?.from)[0] ?? { name: null, address: (commonFrom?.address ?? notification.mail?.source ?? '').trim().toLowerCase() };
  const messageId = normalizeMessageId(email?.messageId ?? common.messageId);
  const inReplyTo = normalizeMessageId(email?.inReplyTo);
  const references = messageIdList(email?.references);
  const subject = (email?.subject ?? common.subject ?? '').slice(0, 998);
  const text = cap(email?.text), html = cap(email?.html);
  const sesTimestamp = [notification.receipt?.timestamp, notification.mail?.timestamp].find(value => value && Number.isFinite(Date.parse(value)));
  const receivedAt = sesTimestamp ? new Date(sesTimestamp).toISOString() : receipt.createdAt;
  const verifiedFrom = !!sesTimestamp && authenticatedFrom(email, from.address, notification.mail, verdicts);
  const sentAt = email?.date && Number.isFinite(Date.parse(email.date)) ? new Date(email.date).toISOString() : null;

  // Attachments are uploaded before the database commit with deterministic keys, so retries overwrite rather than duplicate.
  const attachments: (typeof mailAttachments.$inferInsert)[] = [];
  const skipAttachments = (email?.attachments.length ?? 0) > MAX_ATTACHMENTS;
  if (skipAttachments) log('warn', { code: 'MAILBOX_ATTACHMENTS_SKIPPED', count: email!.attachments.length, limit: MAX_ATTACHMENTS });
  try {
    // Stable on retry. Reopening a processed receipt strictly grows its envelope, so a
    // cleanup already tagging the old batch can never touch the newly published keys.
    const batch=email?.attachments.length && !skipAttachments ? await digest(JSON.stringify([messageRowId,receipt.createdAt,receipt.recipients])) : null;
    const keys=await Promise.all((skipAttachments?[]:email?.attachments??[]).map(async(_,i)=>`${workspacePrefix(scope.workspaceId,'att')}${messageRowId}/${batch}/matt_${(await digest(`${messageRowId}:${i}`)).slice(0,32)}`));
    if(keys.length)await runtime.db.execute(sql`INSERT INTO mail_candidate_uploads(batch,workspace_id,ses_message_id,bucket,region,message_id,keys) VALUES(${batch},${scope.workspaceId},${sesMessageId},${receipt.bucket},${receipt.region},${messageRowId},ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb))) ON CONFLICT(batch) DO UPDATE SET check_at=now()+interval '1 hour'`);
    for (const [index, part] of (skipAttachments ? [] : email?.attachments ?? []).entries()) {
      const bytes = part.content instanceof ArrayBuffer ? part.content : typeof part.content === 'string' ? new TextEncoder().encode(part.content).buffer as ArrayBuffer : (part.content.buffer as ArrayBuffer).slice(part.content.byteOffset, part.content.byteOffset + part.content.byteLength);
      const attachmentId = `matt_${(await digest(`${messageRowId}:${index}`)).slice(0, 32)}`;
      const key = keys[index]!;
      const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(part.mimeType) ? part.mimeType : 'application/octet-stream';
      const { PutObjectCommand } = await loadIngestS3();
      await s3.send(new PutObjectCommand({ Bucket: receipt.bucket, Key: key, Body: new Uint8Array(bytes), ContentType: contentType }));
      attachments.push({ id: attachmentId, ...scope, messageId: messageRowId, filename: (part.filename ?? `attachment-${index + 1}`).slice(0, 255), contentType, sizeBytes: bytes.byteLength, contentId: normalizeMessageId(part.contentId), disposition: part.disposition === 'inline' || part.related ? 'inline' as const : 'attachment' as const, sha256: hex(await crypto.subtle.digest('SHA-256', bytes)), bucket: receipt.bucket, storageKey: key });
    }
  } catch (error) {
    if (error instanceof ModuleLoadError) throw error;
    if (error instanceof Error && error.name==='AccessDenied') throw new ApiError(403,'MAILBOX_ATTACHMENT_ACCESS_DENIED','Access to mailbox attachment storage was denied.');
    throw new ApiError(503, 'MAILBOX_ATTACHMENT_UPLOAD_FAILED', 'An attachment could not be stored in S3; retrying.', undefined, true);
  } finally { s3.destroy(); }

  const {queued_count:runnable,wait_ms:waitMs,hold_ms:holdMs}=await storeIncoming(runtime.db,{
        id: messageRowId, ...scope, direction: 'inbound', region: receipt.region, sesMessageId, messageId, inReplyTo, references, subject,
         fromAddress: from.address, fromName: from.name, to: flatten(email?.to), cc: flatten(email?.cc), bcc: [], replyTo: flatten(email?.replyTo),
        envelopeFrom: notification.mail?.source?.toLowerCase() ?? null, envelopeTo: receipt.recipients, sentAt, receivedAt,
        text: text.value, html: html.value, bodyTruncated: text.truncated || html.truncated || status === 'unparsed' || skipAttachments, snippet: snippetOf(text.value, html.value),
        headers: headersOf(email), attachmentCount: attachments.length, sizeBytes, rawBucket: receipt.bucket, rawKey,
        verdicts, spam, automated: automated(email, raw, from.address), status,
      },attachments,verifiedFrom,!receipt.notification.stagingEtag);
  log('info', { code: 'MAILBOX_MESSAGE_INGESTED',workspaceId:scope.workspaceId,status,spam,rawMs,waitMs,holdMs,lagMs:Date.now()-Date.parse(receipt.createdAt), bytes:sizeBytes, attachments: attachments.length });
  if (runnable > 0) try { await runtime.wake?.(runnable,'webhook'); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Mailbox webhook jobs remain durable.' }); }
};

/** Re-queues receipts whose ingest job was lost (for example after a failed attempt ceiling). Hourly. */
const recoveryPage='mailbox.recoverReceipts';
export async function recoverMailReceipts(runtime: Runtime,continuation=false) {
  const jobFor=sql`j.workspace_id=r.workspace_id AND j.type='mailbox.ingest' AND j.payload->>'sesMessageId'=r.ses_message_id`;
  const result=await runtime.db.execute<{n:number}>(sql`WITH due AS (SELECT r.workspace_id,r.ses_message_id,EXISTS(SELECT FROM jobs j WHERE ${jobFor} AND j.attempts>=${MAX_ATTEMPTS} AND (j.status='failed' OR (j.status='running' AND j.lease_until<now()))) AS exhausted
    FROM mail_receipts r WHERE r.status='pending' AND coalesce(r.last_recovered_at,r.created_at)<now()-interval '30 minutes'
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE ${jobFor} AND (j.status='pending' OR (j.status='running' AND (j.lease_until>=now() OR j.attempts<${MAX_ATTEMPTS}))))
    ORDER BY coalesce(r.last_recovered_at,r.created_at),r.workspace_id,r.ses_message_id LIMIT 100 FOR UPDATE OF r SKIP LOCKED), recovered AS (
    UPDATE mail_receipts r SET recovery_attempts=r.recovery_attempts+1,last_recovered_at=now(),status=CASE WHEN d.exhausted OR r.recovery_attempts>=3 THEN 'failed' ELSE 'pending' END,
      error=CASE WHEN d.exhausted THEN 'MAILBOX_INGEST_EXHAUSTED' WHEN r.recovery_attempts>=3 THEN 'MAILBOX_RECOVERY_EXHAUSTED' END,processed_at=CASE WHEN d.exhausted OR r.recovery_attempts>=3 THEN now() END
    FROM due d WHERE r.workspace_id=d.workspace_id AND r.ses_message_id=d.ses_message_id RETURNING r.workspace_id,r.ses_message_id,r.status),
    queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'job_'||gen_random_uuid(),'mailbox.ingest',workspace_id,jsonb_build_object('sesMessageId',ses_message_id) FROM recovered WHERE status='pending')
    SELECT count(*)::int AS n FROM recovered`);
  if(result.rows[0]!.n===100){
    if(continuation) throw new JobDeferred(new Date().toISOString());
    await runtime.db.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload) VALUES(${recoveryPage},${recoveryPage},${runtime.config.workspaceId},'{}') ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,lease_until=NULL,last_error=NULL,available_at=now(),created_at=now() WHERE jobs.status NOT IN ('running','pending')`);
  }
}

/** Hourly mailbox upkeep: MX status, lost-receipt recovery and event retention. Each step is best-effort. */
export async function mailboxHourly(runtime: Runtime) {
  for (const [code, work] of [['MAILBOX_DNS_REFRESH_FAILED', refreshMailboxDns], ['MAILBOX_RECEIPT_RECOVERY_FAILED', recoverMailReceipts], ['MAILBOX_STAGING_SWEEP_FAILED', scheduleMailRecovery], ['MAILBOX_EVENT_PRUNE_FAILED', pruneMailboxEvents]] as const) {
    try { await work(runtime); } catch (error) { log('warn', { code: error instanceof ApiError ? error.code : code }); }
  }
}

// Keep the aggregate parser input at the old single-message ceiling; larger streaming
// copies need the whole budget for the multipart Bcc scrub. Never wait on another request.
let mimeBytes=0;
const inProgress=new Set<string>();
export const mailboxIngestJobs: Record<string, JobHandler> = { ...stagingJobs,[recoveryPage]:retryDatabaseFailures(async runtime=>recoverMailReceipts(runtime,true)),'mailbox.ingest': async (runtime, payload, job) => {
  let reserved=0;
  const key=JSON.stringify([job.workspaceId,payload.sesMessageId]);
  if(inProgress.has(key))throw new JobDeferred(new Date(Date.now()+2000).toISOString());
  inProgress.add(key);
  try { await ingestJob(runtime,payload,job,size=>{
    const bytes=Math.min(PARSE_LIMIT,Math.max(256*1024,size));
    if(mimeBytes+bytes>PARSE_LIMIT)throw new JobDeferred(new Date(Date.now()+2000).toISOString());
    mimeBytes+=bytes;reserved=bytes;
  }); }
  catch (error) {
    if (error instanceof JobDeferred || error instanceof ModuleLoadError) throw error;
    if (job.attempts<MAX_ATTEMPTS) {
      // A transport disconnect need not have a SQLSTATE or SDK error code. Only explicit permanent errors settle early.
      if (!(error instanceof ApiError)) throw new ApiError(503,'MAILBOX_INGEST_UNAVAILABLE','Mailbox ingestion temporarily unavailable.',undefined,true);
      if (error.retryable) throw error;
      if (error.status>=500 || error.status===429) throw new ApiError(503,error.code,'Mailbox ingestion temporarily unavailable.',undefined,true);
    }
    const code=error instanceof ApiError ? (error.code==='MAILBOX_ATTACHMENT_UPLOAD_FAILED'?'ATTACHMENT_UPLOAD_FAILED':error.code) : 'MAILBOX_INGEST_FAILED';
    await runtime.db.update(mailReceipts).set({status:'failed',error:code,processedAt:new Date().toISOString()}).where(and(eq(mailReceipts.workspaceId,job.workspaceId),eq(mailReceipts.sesMessageId,String(payload.sesMessageId)),eq(mailReceipts.status,'pending')));
    log('error',{code,workspaceId:job.workspaceId,jobId:job.id});
  } finally { mimeBytes-=reserved;inProgress.delete(key); }
} };
