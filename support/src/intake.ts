import { DurableObject } from 'cloudflare:workers';
import { baneApi, BaneError, senderOf, type InboundMessage } from './bane.js';
import type { Env } from './env.js';
import { attachmentLink, safeName, storeImage } from './attachments.js';
import { cleanImage, IMAGE_TYPES, MAX_IMAGE_BYTES } from './image.js';
import { alertOnce, countToday, limits } from './limits.js';
import { fileTicket, notifyTeam, type TicketContext } from './tickets.js';
import type { TicketInput, TicketType } from './agent/tools.js';
import { addressHash, newId } from './tokens.js';

// abuse@, privacy@ and legal@ (owner decision): straight into the ticket system, never to the AI agent and never
// forwarded. One SupportIntake object per Bane thread at those addresses; there is no OpenCode here and no model call.
// Each message becomes (or adds to) one typed ticket with the sender and its DMARC/verification result, the subject and
// text (as untrusted quotes), image attachments checked and stripped like screenshots (other files are listed, to be
// opened in Bane's inbox), an email to the team, and one fixed acknowledgement per sender per day. Same caps as the
// support address (review M5).

export const INTAKE = { abuse: { type: 'abuse_report', severity: 'P3', label: 'abuse' }, privacy: { type: 'privacy', severity: 'P2', label: 'privacy' }, legal: { type: 'legal', severity: 'P2', label: 'legal' } } as const;
export type Mailbox = keyof typeof INTAKE;
const MAX_FILES = 5;

export class SupportIntake extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS intake_inbox (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, mailbox TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'new', attempts INTEGER NOT NULL DEFAULT 0, received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS intake_meta (id INTEGER PRIMARY KEY CHECK (id = 1), conversation_id TEXT NOT NULL);`);
  }

  async enqueue(input: { threadId: string; messageId: string; mailbox: Mailbox }) {
    this.sql.exec('INSERT INTO intake_inbox (message_id, thread_id, mailbox, received_at) VALUES (?, ?, ?, ?) ON CONFLICT (message_id) DO NOTHING', input.messageId, input.threadId, input.mailbox, Date.now());
    await this.ctx.storage.setAlarm(Date.now());
    return { ok: true };
  }

  override async alarm() {
    for (;;) {
      const next = this.sql.exec<{ message_id: string; thread_id: string; mailbox: Mailbox; attempts: number }>("SELECT message_id, thread_id, mailbox, attempts FROM intake_inbox WHERE state = 'new' ORDER BY received_at LIMIT 1").toArray()[0];
      if (!next) return;
      this.sql.exec('UPDATE intake_inbox SET attempts = attempts + 1 WHERE message_id = ?', next.message_id);
      try { await this.process(next); }
      catch (error) {
        console.error(JSON.stringify({ level: 'error', code: 'INTAKE_FAILED', mailbox: next.mailbox, message: String(error).slice(0, 300) }));
        if (next.attempts >= 5) this.sql.exec("UPDATE intake_inbox SET state = 'failed' WHERE message_id = ?", next.message_id);
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
        return;
      }
    }
  }

  /** The conversation row a thread's ticket hangs off (tickets.conversation_id), created once. */
  private async conversationId(threadId: string) {
    const known = this.sql.exec<{ conversation_id: string }>('SELECT conversation_id FROM intake_meta WHERE id = 1').toArray()[0]?.conversation_id;
    if (known) return known;
    const id = newId('conv'), now = Date.now();
    await this.env.DB.prepare("INSERT INTO conversations (id, channel, thread_id, status, created_at, updated_at) VALUES (?, 'email', ?, 'ticketed', ?, ?) ON CONFLICT (thread_id) DO NOTHING").bind(id, `intake:${threadId}`, now, now).run();
    const row = await this.env.DB.prepare('SELECT id FROM conversations WHERE thread_id = ?').bind(`intake:${threadId}`).first<{ id: string }>();
    this.sql.exec('INSERT INTO intake_meta (id, conversation_id) VALUES (1, ?) ON CONFLICT (id) DO NOTHING', row!.id);
    return row!.id;
  }

  private async process(next: { message_id: string; thread_id: string; mailbox: Mailbox }) {
    const api = baneApi(this.env, 'intake'), set = (state: string) => this.sql.exec('UPDATE intake_inbox SET state = ? WHERE message_id = ?', state, next.message_id);
    const message: InboundMessage = await api.message(next.message_id);
    const sender = senderOf(message) ?? 'unknown', hash = await addressHash(sender), cap = limits(this.env);
    // The same caps as the support address: per sender and in total.
    if (!(await countToday(this.env, `sender:${hash}:mail`, cap.mailPerSender)).ok) { console.warn(JSON.stringify({ level: 'warn', code: 'INTAKE_SENDER_CAP', mailbox: next.mailbox })); set('dropped'); return; }
    if (!(await countToday(this.env, 'global:mail', cap.mailPerDay)).ok) { await alertOnce(this.env, 'mail', cap.mailPerDay); set('dropped'); return; }
    const headers = new Map((message.headers ?? []).map(h => [h.name.toLowerCase(), h.value]));
    const automatic = /^(?:mailer-daemon|postmaster|no-?reply|bounces?)@/i.test(sender) || (headers.get('auto-submitted') ?? 'no').toLowerCase() !== 'no'
      || /^(?:bulk|list|junk|auto_reply)$/i.test(headers.get('precedence') ?? '') || headers.has('x-autoreply') || headers.has('x-autorespond');
    const dmarc = String(message.verdicts?.dmarc ?? 'NONE').toUpperCase();
    // Who wrote: a DMARC pass that maps to a Bane user names them; anything else is shown as an unverified sender.
    let verified: TicketContext['verified'] = null, customer: TicketContext['customer'] = { userId: null, email: null, name: null, role: null, workspaces: [] };
    if (dmarc === 'PASS') {
      const checked = await this.env.BANE.verifyEmail({ email: sender, evidence: { kind: 'dmarc', result: 'pass', aligned: true, messageId: message.messageId ?? next.message_id } });
      if (checked.status !== 200) throw new BaneError(checked.status, 'VERIFY_FAILED', 'verify-email failed');
      if (checked.body.verified && checked.body.user) {
        verified = 'dmarc';
        customer = { userId: checked.body.user.id, email: sender, name: checked.body.user.name, role: checked.body.workspaces[0]?.role ?? null, workspaces: checked.body.workspaces.map(w => ({ id: w.id, name: w.name })) };
      }
    }
    const conversationId = await this.conversationId(next.thread_id);
    // Attachments: images like screenshots (checked, stripped, 5 MB, 5 per thread); other files are listed only.
    const files = message.attachments ?? [], stored: { id: string; name: string; type: string; size: number; url: string }[] = [], listed: string[] = [];
    const already = (await this.env.UPLOADS.list({ prefix: `conversations/${conversationId}/` })).objects.length;
    for (const part of files) {
      const name = safeName(part.filename, 'attachment');
      if (!(IMAGE_TYPES as readonly string[]).includes(String(part.contentType).toLowerCase()) || part.size > MAX_IMAGE_BYTES || already + stored.length >= MAX_FILES) { listed.push(`${name} (${String(part.contentType).slice(0, 60)}, ${Math.ceil(part.size / 1024)} KB)`); continue; }
      try {
        const bytes = await api.part(next.message_id, part.id, MAX_IMAGE_BYTES);
        if (!bytes) { listed.push(`${name} (too large)`); continue; }
        const image = await storeImage(this.env, conversationId, newId('att'), cleanImage(bytes), 'email', name);
        stored.push({ id: image.id, name: image.name, type: image.type, size: image.size, url: await attachmentLink(this.env, conversationId, image) });
      } catch { listed.push(`${name} (not a readable image)`); }
    }
    const config = INTAKE[next.mailbox], text = (message.text ?? '').slice(0, 4000), subject = (message.subject ?? '(no subject)').replace(/[\r\n]+/g, ' ').trim();
    const input: TicketInput = {
      type: config.type as TicketType, title: subject.slice(0, 80) || '(no subject)', severity: config.severity, ask: text.slice(0, 600),
      summary: `An email to ${next.mailbox}@ (filed without the AI agent). Subject: “${subject.slice(0, 200)}”.\n\n${text.slice(0, 900)}`,
      tried: [], recommendation: `Read it in Bane’s inbox (${next.mailbox}@ thread ${next.thread_id}) and reply there.${listed.length ? ` Other attachments, not opened here: ${listed.join('; ')}.` : ''}${automatic ? ' It was sent automatically (no acknowledgement was sent).' : ''}`,
      evidence: { ids: [next.message_id] }, details: { topic: next.mailbox },
    };
    const ctx: TicketContext = { conversationId, channel: 'email', threadId: next.thread_id, costUsd: 0, model: 'none (intake)', attachments: stored, verified, dmarc, sender: verified ? null : sender, customer };
    const exists = await this.env.DB.prepare('SELECT id FROM tickets WHERE conversation_id = ?').bind(conversationId).first();
    if (!exists) {
      const person = verified ? `user:${customer.userId}` : `sender:${hash}`;
      if (!(await countToday(this.env, `${person}:tickets`, cap.ticketsPerPerson)).ok) { console.warn(JSON.stringify({ level: 'warn', code: 'INTAKE_TICKET_CAP', mailbox: next.mailbox })); set('dropped'); return; }
      if (!(await countToday(this.env, 'global:tickets', cap.ticketsPerDay)).ok) { await alertOnce(this.env, 'tickets', cap.ticketsPerDay); set('dropped'); return; }
    }
    const filed = await fileTicket(this.env, ctx, input);
    if (filed.created) await notifyTeam(this.env, ctx, filed, input);
    // One fixed acknowledgement per sender per mailbox per day; never to automatic mail.
    if (!automatic && (await countToday(this.env, `sender:${hash}:ack:${next.mailbox}`, 1)).ok) {
      const text = `Hi,\n\nThanks for writing to ${next.mailbox}@bane.mx. We've received your message and logged it as ${filed.id}. A person at Bane will reply by email.\n\nBane`;
      await api.reply(message.threadId ?? next.thread_id, { replyToMessageId: next.message_id, text, to: sender, subject: `Re: your message to ${next.mailbox}@bane.mx`, addressId: null }, `ack-${next.message_id}`);
    }
    set('done');
  }
}
