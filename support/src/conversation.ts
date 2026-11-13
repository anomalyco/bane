import { DurableObject } from 'cloudflare:workers';
import { baneApi, BaneError, senderOf, type Handoff, type InboundMessage, type PlatformReply } from './bane.js';
import type { Env } from './env.js';
import { gate, plainText } from './gate.js';
import { fileTicket, notifyTeam, openFollowUp, type TicketContext } from './tickets.js';
import { addressHash, confirmToken, MissingSecret, newId } from './tokens.js';
import { customerBlock, firstName, greetingBundle, type Customer } from './agent/context.js';
import type { Harness, HarnessEvent, TurnResult } from './agent/harness.js';
import { createHarness, MODEL, promptFragments } from './agent/opencode.js';
import { ToolFailure, type TicketInput, type ToolHost } from './agent/tools.js';

// One support conversation (chat or email) per Durable Object (design §1). It holds:
// - the support grant, in a private SQLite table: never in a message, a tool argument or result, a log or the socket;
// - the transcript the panel sees, the email inbox (its durable queue) and pending consent;
// - the agent (OpenCode, agent/opencode.ts), whose tools are closures over this object's grant.
// The protocol to the panel is support/PROTOCOL.md.

const TURNS_PER_CONVERSATION = 60;
const TOKEN_BUDGET = 500_000;
const GRANT_MINUTES = 120;
const CHAT_IDLE_MS = 24 * 3_600_000, EMAIL_IDLE_MS = 7 * 86_400_000, KEEP_AFTER_CLOSE_MS = 7 * 86_400_000;
const EMAIL_BURST = 5, EMAIL_BURST_MS = 10 * 60_000;
const MAX_FRAME = 16_384, MAX_TEXT = 8000;
const MODEL_LABEL = `${MODEL.model}#${MODEL.variant}`;
const REDACTED = 'I’ve sent this one to the Bane team to check before I answer. Someone will follow up by email.';

type Meta = {
  conversationId: string; channel: 'chat' | 'email'; status: 'open' | 'ticketed' | 'closed';
  userId: string | null; email: string | null; name: string | null; role: string | null;
  workspace: { id: string; name: string } | null; workspaces: { id: string; name: string; role: string }[];
  verified: Customer['verified']; contentAccess: boolean; page: string | null; handoffMessage: string | null; requestIds: string[];
  threadId: string | null; greeted: boolean; turns: number; inputTokens: number; outputTokens: number; costUsd: number;
  ticketId: string | null; lastActivity: number; closedAt: number | null; seq: number;
  pendingSender: string | null; confirmSentAt: number | null;
};
type Transcript = { id: string; role: 'user' | 'assistant'; kind: 'first' | 'reply' | 'notice' | null; text: string; at: string; tools: { id: string; label: string; ok: boolean }[] };
type Outgoing = Record<string, unknown> & { type: string };
type GrantRow = { grant_id: string; token: string; expires_at: number; workspace_ids: string; content_workspace_id: string | null };

export class SupportConversation extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private harness: Harness | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private abort: AbortController | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // OpenCode keeps its own tables in this SQLite and only initialises an empty database, so a new conversation boots
    // OpenCode first; ours carry a support_ prefix and come second. Later wakes boot OpenCode lazily, on the first turn.
    void ctx.blockConcurrencyWhile(async () => {
      const fresh = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'support_meta'").one().n === 0;
      if (fresh) this.harness = await createHarness(env, ctx.storage);
      this.createTables();
    });
  }

  private createTables() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS support_meta (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS support_grant (id INTEGER PRIMARY KEY CHECK (id = 1), grant_id TEXT NOT NULL, token TEXT NOT NULL, expires_at INTEGER NOT NULL, workspace_ids TEXT NOT NULL, content_workspace_id TEXT);
      CREATE TABLE IF NOT EXISTS support_transcript (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, role TEXT NOT NULL, kind TEXT, text TEXT NOT NULL, at TEXT NOT NULL, tools TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS support_client_ids (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS support_inbox (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, delivery_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'new', attempts INTEGER NOT NULL DEFAULT 0, received_at INTEGER NOT NULL, subject TEXT);
      CREATE TABLE IF NOT EXISTS support_consent (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workspace_name TEXT NOT NULL, why TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);`);
  }

  // ---------- state ----------

  private meta(): Meta | null {
    const row = this.sql.exec<{ value: string }>('SELECT value FROM support_meta WHERE id = 1').toArray()[0];
    return row ? JSON.parse(row.value) as Meta : null;
  }
  private save(meta: Meta) { this.sql.exec('INSERT INTO support_meta (id, value) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value', JSON.stringify(meta)); }
  private update(change: (meta: Meta) => void) { const meta = this.meta(); if (!meta) throw new Error('conversation not opened'); change(meta); this.save(meta); return meta; }
  private fresh(conversationId: string, channel: Meta['channel']): Meta {
    return { conversationId, channel, status: 'open', userId: null, email: null, name: null, role: null, workspace: null, workspaces: [], verified: null, contentAccess: false, page: null, handoffMessage: null,
      requestIds: [], threadId: null, greeted: false, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, ticketId: null, lastActivity: Date.now(), closedAt: null, seq: 0, pendingSender: null, confirmSentAt: null };
  }
  private customer(meta: Meta): Customer {
    return { channel: meta.channel, userId: meta.userId, name: meta.name, email: meta.email, role: meta.role, workspace: meta.workspace, workspaces: meta.workspaces, verified: meta.verified, contentAccess: meta.contentAccess, page: meta.page };
  }

  // ---------- the grant (private table; never leaves this object except as the Authorization of a Bane read) ----------

  private grant(): GrantRow | null {
    const row = this.sql.exec<GrantRow>('SELECT grant_id, token, expires_at, workspace_ids, content_workspace_id FROM support_grant WHERE id = 1').toArray()[0];
    return row && row.expires_at > Date.now() + 30_000 ? row : null;
  }
  private storeGrant(g: { id: string; token: string; expiresAt: string; workspaceIds: string[]; contentWorkspaceId: string | null }) {
    this.sql.exec(`INSERT INTO support_grant (id, grant_id, token, expires_at, workspace_ids, content_workspace_id) VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET grant_id = excluded.grant_id, token = excluded.token, expires_at = excluded.expires_at, workspace_ids = excluded.workspace_ids, content_workspace_id = excluded.content_workspace_id`,
      g.id, g.token, Date.parse(g.expiresAt), JSON.stringify(g.workspaceIds), g.contentWorkspaceId);
  }
  private async revokeGrant() {
    const row = this.sql.exec<{ grant_id: string }>('SELECT grant_id FROM support_grant WHERE id = 1').toArray()[0];
    this.sql.exec('DELETE FROM support_grant');
    if (row) { try { await this.env.BANE.revokeGrant(row.grant_id); } catch { /* it expires within two hours anyway */ } }
  }
  private async mint(meta: Meta, input: { verification: 'handoff' | 'dmarc' | 'magic_link'; handoffId?: string; workspaceIds?: string[]; reason: string }) {
    await this.revokeGrant();
    const minted = await this.env.BANE.mintGrant({ userId: meta.userId!, ticketRef: meta.conversationId, reason: input.reason, verification: input.verification, handoffId: input.handoffId, workspaceIds: input.workspaceIds, ttlMinutes: GRANT_MINUTES });
    if (minted.status !== 201) return minted as PlatformReply<unknown>;
    this.storeGrant(minted.body);
    this.update(m => { m.contentAccess = !!minted.body.contentWorkspaceId; });
    return minted;
  }

  // ---------- RPC from the router ----------

  async openChat({ conversationId, handoff }: { conversationId: string; handoff: Handoff }): Promise<{ ok: true } | { ok: false; code: string }> {
    if (this.meta()) return { ok: false, code: 'ALREADY_OPEN' };
    const meta = this.fresh(conversationId, 'chat');
    Object.assign(meta, { userId: handoff.userId, email: handoff.email || null, role: handoff.role, workspace: handoff.workspace, workspaces: [{ ...handoff.workspace, role: handoff.role }], verified: 'handoff' as const,
      page: handoff.page, handoffMessage: handoff.message, requestIds: handoff.requestIds });
    this.save(meta);
    const minted = await this.mint(meta, { verification: 'handoff', handoffId: handoff.id, reason: 'Answering the customer’s support chat from the Bane dashboard' });
    if (minted.status !== 201) return { ok: false, code: minted.status === 409 ? 'HANDOFF_USED' : 'MINT_FAILED' };
    await this.ctx.storage.setAlarm(Date.now() + CHAT_IDLE_MS);
    return { ok: true };
  }

  async renewGrant({ handoff }: { handoff: Handoff }): Promise<{ ok: boolean }> {
    const meta = this.meta();
    if (!meta || meta.userId !== handoff.userId || meta.status === 'closed') return { ok: false };
    // A handoff from another workspace can only renew this conversation's own workspace scope.
    const minted = await this.mint(meta, { verification: 'handoff', handoffId: handoff.id, reason: 'Renewing access for the customer’s open support conversation',
      workspaceIds: meta.workspace ? [meta.workspace.id] : undefined });
    if (minted.status !== 201) return { ok: false };
    const pending = this.sql.exec<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM support_consent WHERE state = 'pending'").toArray();
    const granted = this.grant()?.content_workspace_id ?? null;
    for (const consent of pending) if (handoff.shareContent && granted === consent.workspace_id) this.resolveConsent(consent.id, 'allow');
    this.notice(handoff.shareContent && granted ? 'Content access allowed for this conversation.' : 'Account access renewed.');
    if (handoff.shareContent && granted && pending.length) this.enqueueTurn({ text: '[The customer allowed content access for this workspace. Continue where you left off.]', hidden: true });
    return { ok: true };
  }

  async enqueueInbound(input: { conversationId: string; threadId: string; messageId: string; deliveryId: string }) {
    if (!this.meta()) { const meta = this.fresh(input.conversationId, 'email'); meta.threadId = input.threadId; this.save(meta); }
    this.sql.exec('INSERT INTO support_inbox (message_id, thread_id, delivery_id, received_at) VALUES (?, ?, ?, ?) ON CONFLICT (message_id) DO NOTHING', input.messageId, input.threadId, input.deliveryId, Date.now());
    await this.ctx.storage.setAlarm(Date.now());
    return { ok: true };
  }

  async confirmationSubject(hash: string): Promise<string | null> {
    const meta = this.meta();
    if (!meta?.pendingSender || await addressHash(meta.pendingSender) !== hash) return null;
    return this.sql.exec<{ subject: string | null }>("SELECT subject FROM support_inbox ORDER BY received_at LIMIT 1").toArray()[0]?.subject ?? '';
  }

  async confirmEmail({ addressHash: hash }: { addressHash: string }): Promise<{ ok: boolean }> {
    const meta = this.meta();
    if (!meta?.pendingSender || await addressHash(meta.pendingSender) !== hash) return { ok: false };
    const ok = await this.verifySender(meta, meta.pendingSender, { kind: 'magic_link', confirmedAt: new Date().toISOString() });
    if (!ok) return { ok: false };
    this.sql.exec("UPDATE support_inbox SET state = 'new' WHERE state = 'awaiting_confirmation'");
    await this.ctx.storage.setAlarm(Date.now());
    return { ok: true };
  }

  // ---------- the socket ----------

  override async fetch(request: Request): Promise<Response> {
    const meta = this.meta(), user = request.headers.get('x-support-user');
    if (!meta || meta.userId !== user || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 404 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    this.sendTo(pair[1], this.hello(meta));
    this.sendTo(pair[1], { type: 'history', messages: this.history(), pending: { consent: this.pendingConsent(), ticket: meta.ticketId ? { ticketId: meta.ticketId } : null } });
    if (meta.channel === 'chat' && !meta.greeted && meta.status !== 'closed') { this.update(m => { m.greeted = true; }); this.enqueueTurn({ greeting: true }); }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > MAX_FRAME) { this.sendTo(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'Frames are JSON text up to 16 KB.', retryable: false }); return; }
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw); } catch { this.sendTo(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'Not JSON.', retryable: false }); return; }
    const meta = this.meta();
    if (!meta) { ws.close(1008, 'gone'); return; }
    switch (message.type) {
      case 'ping': this.sendTo(ws, { type: 'pong' }); return;
      case 'user.message': {
        const text = typeof message.text === 'string' ? message.text.trim().slice(0, MAX_TEXT) : '', clientId = typeof message.clientMessageId === 'string' ? message.clientMessageId.slice(0, 80) : '';
        if (!text || !clientId) { this.sendTo(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'user.message needs text and clientMessageId.', retryable: false }); return; }
        if (meta.status === 'closed') { this.sendTo(ws, { type: 'closed', reason: 'ended' }); return; }
        if (this.sql.exec('INSERT INTO support_client_ids (id) VALUES (?) ON CONFLICT (id) DO NOTHING', clientId).rowsWritten === 0) return;
        this.record({ id: newId('msg'), role: 'user', kind: null, text, at: new Date().toISOString(), tools: [] });
        this.enqueueTurn({ text });
        return;
      }
      case 'consent.respond': {
        const id = String(message.requestId ?? ''), consent = this.sql.exec<{ id: string; workspace_id: string; state: string }>('SELECT id, workspace_id, state FROM support_consent WHERE id = ?', id).toArray()[0];
        if (!consent || consent.state !== 'pending') return;
        if (message.decision !== 'allow' || typeof message.handoff !== 'string') {
          this.resolveConsent(id, 'deny');
          this.enqueueTurn({ text: '[The customer chose not to share content. Continue without it.]', hidden: true });
          return;
        }
        const checked = await this.env.BANE.verifyHandoff(message.handoff);
        if (!checked.ok || checked.handoff.userId !== meta.userId || !checked.handoff.shareContent || checked.handoff.workspace.id !== consent.workspace_id || checked.handoff.usedAt) {
          this.resolveConsent(id, 'deny');
          this.enqueueTurn({ text: '[Content access could not be granted (the dashboard was on another workspace, or the request expired). Continue without it, and say they can try again from that workspace.]', hidden: true });
          return;
        }
        const renewed = await this.renewGrant({ handoff: checked.handoff });
        if (!renewed.ok) { this.resolveConsent(id, 'deny'); this.sendTo(ws, { type: 'error', code: 'TURN_FAILED', message: 'Couldn’t switch on content access. Try again.', retryable: true }); }
        return;
      }
      case 'human.request': this.record({ id: newId('msg'), role: 'user', kind: null, text: 'Talk to a person', at: new Date().toISOString(), tools: [] });
        this.enqueueTurn({ text: '[The customer pressed “Talk to a person”. File a ticket (human_requested, unless a more specific category fits) with what you know so far, then tell them what happens next.]', hidden: true }); return;
      case 'cancel': this.abort?.abort(); return;
      case 'feedback': if (message.rating === 'up' || message.rating === 'down') this.update(m => { (m as Meta & { rating?: string }).rating = message.rating as string; }); return;
      case 'end': await this.close('ended'); return;
      default: this.sendTo(ws, { type: 'error', code: 'BAD_MESSAGE', message: `Unknown type ${String(message.type).slice(0, 40)}.`, retryable: false });
    }
  }
  override async webSocketClose(ws: WebSocket, code: number) { try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch { /* already closed */ } }

  private hello(meta: Meta): Outgoing {
    return { type: 'hello', conversationId: meta.conversationId, channel: meta.channel, status: meta.status, agent: { name: 'Bane support', ai: true }, customer: { firstName: firstName(meta.name) },
      workspace: meta.workspace, contentAccess: meta.contentAccess, busy: this.abort !== null };
  }
  private history() {
    return this.sql.exec<{ id: string; role: string; kind: string | null; text: string; at: string; tools: string }>('SELECT id, role, kind, text, at, tools FROM support_transcript ORDER BY seq').toArray()
      .map(r => ({ id: r.id, role: r.role, ...(r.kind ? { kind: r.kind } : {}), text: r.text, at: r.at, ...(r.role === 'assistant' ? { tools: JSON.parse(r.tools) } : {}) }));
  }
  private pendingConsent() {
    const c = this.sql.exec<{ id: string; workspace_id: string; workspace_name: string; why: string }>("SELECT id, workspace_id, workspace_name, why FROM support_consent WHERE state = 'pending' ORDER BY created_at DESC LIMIT 1").toArray()[0];
    return c ? { requestId: c.id, workspace: { id: c.workspace_id, name: c.workspace_name }, why: c.why } : null;
  }
  private record(t: Transcript) { this.sql.exec('INSERT INTO support_transcript (id, role, kind, text, at, tools) VALUES (?, ?, ?, ?, ?, ?)', t.id, t.role, t.kind, t.text, t.at, JSON.stringify(t.tools)); }
  private broadcast(message: Outgoing) {
    const seq = this.update(m => { m.seq += 1; }).seq;
    const frame = JSON.stringify({ v: 1, ...message, seq });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(frame); } catch { /* closed */ } }
  }
  private sendTo(ws: WebSocket, message: Outgoing) {
    const meta = this.meta(), seq = meta ? this.update(m => { m.seq += 1; }).seq : 0;
    try { ws.send(JSON.stringify({ v: 1, ...message, seq })); } catch { /* closed */ }
  }
  private notice(text: string) {
    const id = newId('msg');
    this.record({ id, role: 'assistant', kind: 'notice', text, at: new Date().toISOString(), tools: [] });
    this.broadcast({ type: 'message.start', messageId: id, kind: 'notice' });
    this.broadcast({ type: 'message.end', messageId: id, text, redacted: false });
  }
  private resolveConsent(id: string, decision: 'allow' | 'deny') {
    this.sql.exec('UPDATE support_consent SET state = ? WHERE id = ?', decision, id);
    this.broadcast({ type: 'consent.resolved', requestId: id, decision });
  }

  // ---------- turns ----------

  private enqueueTurn(input: { text?: string; hidden?: boolean; greeting?: boolean }) {
    this.queue = this.queue.then(() => this.chatTurn(input)).catch(error => console.error(JSON.stringify({ level: 'error', code: 'TURN_FAILED', message: String(error).slice(0, 300) })));
    this.ctx.waitUntil(this.queue);
  }

  private async agent(): Promise<Harness> {
    if (!this.harness) this.harness = await createHarness(this.env, this.ctx.storage);
    return this.harness;
  }

  /** Guards every turn: the conversation's limits, the spend budget, and the model key. */
  private admit(meta: Meta): string | null {
    if (meta.status === 'closed') return 'closed';
    if (meta.turns >= TURNS_PER_CONVERSATION) return 'turns';
    if (meta.inputTokens + meta.outputTokens >= TOKEN_BUDGET) return 'budget';
    return null;
  }

  private async chatTurn(input: { text?: string; hidden?: boolean; greeting?: boolean }) {
    let meta = this.meta();
    if (!meta) return;
    const refused = this.admit(meta);
    if (refused) {
      if (refused === 'closed') return;
      this.broadcast({ type: 'error', code: 'BUDGET_EXHAUSTED', message: 'This conversation has reached its limit. I’ve passed it to the Bane team, who will follow up by email.', retryable: false });
      await this.harnessTicket(meta, { category: 'other', severity: 'P3', summary: `The conversation reached its ${refused === 'turns' ? `${TURNS_PER_CONVERSATION}-turn` : 'token'} limit before it was resolved.`, ask: input.text ?? '', tried: [], recommendation: 'Read the conversation and reply to the customer.', evidence: { ids: [] } });
      return;
    }
    // Fail closed before any model call: without the gateway key there is no agent, and the panel says so.
    if (!this.env.CONSOLE_GATEWAY_KEY) {
      console.error(JSON.stringify({ level: 'error', code: 'SECRET_MISSING', secret: 'CONSOLE_GATEWAY_KEY' }));
      this.broadcast({ type: 'error', code: 'TURN_FAILED', message: 'Support isn’t fully set up yet. Please email support@bane.mx.', retryable: false });
      return;
    }
    let text: string;
    if (input.greeting) {
      text = `[The customer just opened the support chat${meta.page ? ` from ${meta.page}` : ''}. Write the first message, following the first-message rules and using only <context>.${meta.handoffMessage ? ` They also typed this before opening the chat: <untrusted>${meta.handoffMessage.slice(0, 2000)}</untrusted> — answer it after the greeting if it is a question.` : ''}]`;
    } else text = input.hidden ? input.text! : `<untrusted source="chat">${input.text!}</untrusted>`;
    const messageId = newId('msg'), tools: Transcript['tools'] = [];
    this.broadcast({ type: 'status', busy: true });
    this.broadcast({ type: 'message.start', messageId, kind: input.greeting ? 'first' : 'reply' });
    this.abort = new AbortController();
    let result: TurnResult;
    try {
      const context = input.greeting ? await this.greetingContext(meta) : '';
      result = await (await this.agent()).turn({ text, context: `${customerBlock(this.customer(meta))}\n${context}` }, this.toolHost(), (event: HarnessEvent) => {
        if (event.type === 'text.delta') this.broadcast({ type: 'text.delta', messageId, delta: event.delta });
        else if (event.type === 'tool.start') { const label = this.label(event.tool, event.args); tools.push({ id: event.callId, label: label.done, ok: true }); this.broadcast({ type: 'tool.start', messageId, toolCallId: event.callId, tool: event.tool, label: label.running }); }
        else { const t = tools.find(x => x.id === event.callId); if (t) t.ok = event.ok; this.broadcast({ type: 'tool.end', toolCallId: event.callId, ok: event.ok, label: t?.label ?? 'Done' }); }
      }, this.abort.signal);
    } catch (error) {
      this.abort = null;
      const missing = error instanceof MissingSecret ? error.secret : null;
      console.error(JSON.stringify({ level: 'error', code: missing ? 'SECRET_MISSING' : 'TURN_FAILED', secret: missing, message: String(error).slice(0, 300) }));
      this.broadcast({ type: 'message.end', messageId, text: '', redacted: false });
      this.broadcast({ type: 'error', code: 'TURN_FAILED', message: missing ? 'Support isn’t fully set up yet. Please email support@bane.mx.' : 'Something went wrong on my side. Try again in a moment.', retryable: !missing });
      this.broadcast({ type: 'status', busy: false });
      return;
    }
    this.abort = null;
    meta = this.update(m => { m.turns += 1; m.inputTokens += result.usage.inputTokens; m.outputTokens += result.usage.outputTokens; m.costUsd += result.usage.costUsd; m.lastActivity = Date.now(); });
    let final = result.text.trim(), redacted = false;
    if (!final && result.error) final = 'Something went wrong on my side. Try again in a moment.';
    const checked = gate(final, this.gateScope(meta));
    if (!checked.ok) {
      redacted = true; final = REDACTED;
      console.warn(JSON.stringify({ level: 'warn', code: 'OUTPUT_GATE_TRIPPED', conversation: meta.conversationId, reasons: checked.reasons }));
      await this.harnessTicket(meta, { category: 'other', severity: 'P3', summary: `The output gate held an answer (${checked.reasons.join(', ')}).`, ask: input.text ?? '', tried: [], recommendation: 'Read the held answer in the transcript and reply to the customer by email.', evidence: { ids: [] } });
    }
    this.record({ id: messageId, role: 'assistant', kind: input.greeting ? 'first' : 'reply', text: final, at: new Date().toISOString(), tools });
    this.broadcast({ type: 'message.end', messageId, text: final, redacted });
    this.broadcast({ type: 'status', busy: false });
    await this.env.DB.prepare('UPDATE conversations SET turns = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, updated_at = ? WHERE id = ?').bind(meta.turns, meta.inputTokens, meta.outputTokens, meta.costUsd, Date.now(), meta.conversationId).run();
  }

  private async greetingContext(meta: Meta) {
    const grant = this.grant();
    if (!grant) return '<context>\nno account data available\n</context>';
    const q = meta.workspace ? `?workspaceId=${encodeURIComponent(meta.workspace.id)}` : '';
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [context, campaigns, standing] = await Promise.all([
      this.env.BANE.read<Record<string, any>>(`/v1/support/context${q}`, grant.token),
      this.env.BANE.read<Record<string, any>>(`/v1/support/campaigns${q}${q ? '&' : '?'}since=${encodeURIComponent(since)}`, grant.token),
      this.env.BANE.read<Record<string, any>>(`/v1/support/standing${q}`, grant.token),
    ]);
    if (context.status === 200 && context.body.user?.name) this.update(m => { m.name ??= context.body.user.name; });
    return greetingBundle({ context: context.status === 200 ? context.body : null, campaigns: campaigns.status === 200 ? campaigns.body : null, standing: standing.status === 200 ? standing.body : null });
  }

  private label(tool: string, args: Record<string, unknown>) {
    return labels(tool, args);
  }

  private gateScope(meta: Meta) {
    const grant = this.grant(), workspaceIds = grant ? JSON.parse(grant.workspace_ids) as string[] : meta.workspaces.map(w => w.id);
    return { emails: meta.email ? [meta.email] : [], allowedIds: [...workspaceIds, meta.conversationId, ...(meta.ticketId ? [meta.ticketId] : [])], allowedNames: meta.workspaces.map(w => w.name), promptFragments: promptFragments(), supportAddress: this.env.SUPPORT_ADDRESS };
  }

  private toolHost(): ToolHost {
    return {
      read: async (path: string) => {
        const grant = this.grant(), meta = this.meta()!;
        if (!grant) throw new ToolFailure(meta.workspaces.length > 1 && !meta.workspace ? 'No workspace chosen yet. Ask the customer which workspace this is about, then call choose_workspace.'
          : meta.verified ? 'Account access expired. Tell the customer to press Help again in the dashboard to renew it (chat), or answer without account data.' : 'This person is not verified, so you have no account access. Answer general questions only.');
        const reply = await this.env.BANE.read(path, grant.token);
        if (reply.status === 200) return reply.body;
        const code = (reply.body as { error?: { code?: string } } | null)?.error?.code ?? `HTTP_${reply.status}`;
        if (reply.status === 429) throw new ToolFailure('Bane’s support read budget is spent for this minute. Wait and try fewer, narrower calls.');
        if (reply.status === 404) throw new ToolFailure(`Not found (${code}). Check the ID came from an earlier tool result for this customer.`);
        if (reply.status === 403) throw new ToolFailure('Access to this account ended. Answer without account data, or ask the customer to press Help again.');
        throw new ToolFailure(`Bane answered ${reply.status} (${code}).${reply.requestId ? ` Request ${reply.requestId}.` : ''}`);
      },
      workspaceId: () => this.meta()?.workspace?.id ?? null,
      chooseWorkspace: async (workspaceId: string) => {
        const meta = this.meta()!, chosen = meta.workspaces.find(w => w.id === workspaceId);
        if (!chosen) throw new ToolFailure('That is not one of the customer’s verified workspaces. Use an ID from <customer>.');
        if (meta.workspace?.id === workspaceId && this.grant()) return `Already on ${chosen.name}.`;
        if (meta.channel === 'chat') throw new ToolFailure('In chat the workspace is the one the dashboard was on. Ask the customer to switch workspace in the dashboard and press Help again.');
        this.update(m => { m.workspace = { id: chosen.id, name: chosen.name }; m.role = chosen.role; });
        const minted = await this.mint(this.meta()!, { verification: meta.verified === 'magic_link' ? 'magic_link' : 'dmarc', workspaceIds: [workspaceId], reason: 'Answering the customer’s support email about this workspace' });
        if (minted.status !== 201) throw new ToolFailure('Couldn’t open that workspace just now. Try again in a moment.');
        return `Now reading ${chosen.name} (${chosen.id}).`;
      },
      requestContentAccess: async (workspaceId: string, why: string) => {
        const meta = this.meta()!;
        if (meta.contentAccess && this.grant()?.content_workspace_id === workspaceId) return 'Content access is already allowed. Go ahead.';
        const workspace = meta.workspaces.find(w => w.id === workspaceId) ?? meta.workspace;
        if (!workspace) throw new ToolFailure('Choose a workspace first.');
        if (meta.channel === 'email') {
          return `Email can’t grant content access. In your reply, explain in one sentence why reading the content would help, and give this link to continue in the dashboard, where they can allow it: ${this.env.BANE_ORIGIN}/?support=${meta.conversationId}&share=1`;
        }
        const id = newId('cns');
        this.sql.exec('INSERT INTO support_consent (id, workspace_id, workspace_name, why, created_at) VALUES (?, ?, ?, ?, ?)', id, workspace.id, workspace.name, why.slice(0, 240), Date.now());
        this.broadcast({ type: 'consent.request', requestId: id, workspace: { id: workspace.id, name: workspace.name }, why: why.slice(0, 240) });
        return 'The customer now sees an Allow / Not now card. End this answer by saying you’ve asked for access and what you’ll check once they allow it. You’ll get a note when they decide.';
      },
      fileTicket: async (input: TicketInput) => {
        const meta = this.meta()!, filed = await this.harnessTicket(meta, input);
        return filed.created
          ? `Filed ${filed.id}. Tell the customer: you've passed it to the Bane team as ${filed.id}; someone will reply by email to ${filed.replyTo ?? 'their account address'}, usually within one business day; you can't promise an outcome, but you've included what you found.`
          : `Added to the existing ticket ${filed.id}. Tell the customer you've added this to ${filed.id}.`;
      },
    };
  }

  private async harnessTicket(meta: Meta, input: TicketInput) {
    const ctx: TicketContext = { conversationId: meta.conversationId, channel: meta.channel, threadId: meta.threadId, costUsd: meta.costUsd, model: MODEL_LABEL,
      customer: { userId: meta.userId, email: meta.email, name: meta.name, role: meta.role, workspaces: meta.workspace ? [meta.workspace] : meta.workspaces.map(w => ({ id: w.id, name: w.name })) } };
    const filed = await fileTicket(this.env, ctx, input);
    if (filed.created) {
      this.update(m => { m.ticketId = filed.id; m.status = 'ticketed'; });
      // Email the team and, for a chat, open the customer's follow-up thread; a failure is retried by the alarm.
      try { await notifyTeam(this.env, ctx, filed, input); } catch (error) { console.error(JSON.stringify({ level: 'error', code: 'TICKET_NOTIFY_FAILED', ticket: filed.id, message: String(error).slice(0, 200) })); await this.ctx.storage.setAlarm(Date.now() + 60_000); }
      try { const sent = await openFollowUp(this.env, ctx, filed); if (sent) this.update(m => { m.threadId ??= sent.threadId; }); } catch (error) { console.error(JSON.stringify({ level: 'error', code: 'TICKET_FOLLOWUP_FAILED', ticket: filed.id, message: String(error).slice(0, 200) })); }
      if (meta.channel === 'chat') this.broadcast({ type: 'ticket.filed', ticketId: filed.id, category: input.category, replyTo: filed.replyTo, expect: input.category === 'enforcement_review' ? 'usually within 4 business hours' : input.category === 'limit_increase' ? 'usually within two business days' : 'usually within one business day' });
    }
    return filed;
  }

  // ---------- email ----------

  private async verifySender(meta: Meta, email: string, evidence: { kind: 'dmarc'; result: 'pass'; aligned: true; messageId: string } | { kind: 'magic_link'; confirmedAt: string }) {
    const verified = await this.env.BANE.verifyEmail({ email, evidence, ticketRef: meta.conversationId });
    if (verified.status !== 200) throw new BaneError(verified.status, 'VERIFY_FAILED', 'verify-email failed');
    if (!verified.body.verified || !verified.body.user) { this.update(m => { m.email = email; m.verified = null; m.pendingSender = null; }); return false; }
    const { user, workspaces } = verified.body;
    const updated = this.update(m => {
      Object.assign(m, { email, userId: user.id, name: user.name, verified: evidence.kind, workspaces, pendingSender: null });
      if (workspaces.length === 1) { m.workspace = { id: workspaces[0]!.id, name: workspaces[0]!.name }; m.role = workspaces[0]!.role; }
    });
    await this.env.DB.prepare('UPDATE conversations SET user_id = ?, email = ?, workspace_id = ?, workspace_name = ?, updated_at = ? WHERE id = ?').bind(user.id, email, updated.workspace?.id ?? null, updated.workspace?.name ?? null, Date.now(), updated.conversationId).run();
    // One workspace: a grant for it now. Several: none until the customer says which (choose_workspace narrows it).
    if (updated.workspace) await this.mint(updated, { verification: evidence.kind, workspaceIds: [updated.workspace.id], reason: 'Answering the customer’s support email' });
    return true;
  }

  private async processInbox() {
    const api = baneApi(this.env);
    const next = this.sql.exec<{ message_id: string; thread_id: string; attempts: number }>("SELECT message_id, thread_id, attempts FROM support_inbox WHERE state = 'new' ORDER BY received_at LIMIT 1").toArray()[0];
    if (!next) return false;
    this.sql.exec('UPDATE support_inbox SET attempts = attempts + 1 WHERE message_id = ?', next.message_id);
    let meta = this.meta()!;
    let message: InboundMessage;
    try { message = await api.message(next.message_id); }
    catch (error) {
      if (next.attempts >= 5) this.sql.exec("UPDATE support_inbox SET state = 'failed' WHERE message_id = ?", next.message_id);
      throw error;
    }
    this.sql.exec('UPDATE support_inbox SET subject = ? WHERE message_id = ?', (message.subject ?? '').slice(0, 200), next.message_id);
    const sender = senderOf(message), headers = new Map((message.headers ?? []).map(h => [h.name.toLowerCase(), h.value]));
    // Never answer automatic mail or ourselves (loops).
    const automatic = !sender || /^(?:mailer-daemon|postmaster|no-?reply|bounces?)@/i.test(sender) || sender === this.env.SUPPORT_ADDRESS.toLowerCase()
      || (headers.get('auto-submitted') ?? 'no').toLowerCase() !== 'no' || /^(?:bulk|list|junk|auto_reply)$/i.test(headers.get('precedence') ?? '') || headers.has('x-autoreply') || headers.has('x-autorespond');
    if (automatic) { this.sql.exec("UPDATE support_inbox SET state = 'dropped' WHERE message_id = ?", next.message_id); return true; }
    const recent = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM support_inbox WHERE state = 'answered' AND received_at > ?", Date.now() - EMAIL_BURST_MS).one().n;
    if (recent >= EMAIL_BURST) { this.sql.exec("UPDATE support_inbox SET state = 'dropped' WHERE message_id = ?", next.message_id); return true; }
    // After a ticket, the team owns the thread: later mail is added to the ticket, not answered by the agent.
    if (meta.status === 'ticketed' && meta.ticketId) {
      await fileTicket(this.env, this.ticketCtx(meta), { category: 'other', severity: 'P3', summary: 'The customer wrote again after the ticket was filed.', ask: (message.replyText ?? message.text ?? '').slice(0, 600), tried: [], recommendation: 'Read their new message in the thread.', evidence: { ids: [next.message_id] } });
      this.sql.exec("UPDATE support_inbox SET state = 'answered' WHERE message_id = ?", next.message_id);
      return true;
    }
    const dmarc = String(message.verdicts?.dmarc ?? message.verdicts?.dmarcVerdict ?? '').toUpperCase();
    if (!meta.verified || meta.email !== sender) {
      if (meta.verified && meta.email !== sender) {
        // A different sender in a verified thread: no account data, and the team hears about a possible hijack.
        await this.emailTurn(meta, message, next.message_id, sender, { unverified: true, note: 'This message comes from a different address than the one verified earlier in this thread. Do not use account data; answer generally and say you can only discuss the account with the account owner’s address.' });
        return true;
      }
      if (dmarc === 'PASS') { await this.verifySender(meta, sender, { kind: 'dmarc', result: 'pass', aligned: true, messageId: message.messageId ?? next.message_id }); meta = this.meta()!; }
      else if (!meta.confirmSentAt) {
        // No DMARC pass: ask the sender to confirm (a POST on our page), and meanwhile answer only what needs no account.
        this.update(m => { m.pendingSender = sender; m.confirmSentAt = Date.now(); m.email = sender; });
        this.sql.exec("UPDATE support_inbox SET state = 'awaiting_confirmation' WHERE message_id = ?", next.message_id);
        const link = `${this.env.PUBLIC_URL}/confirm/${await confirmToken(this.env.SUPPORT_ROOT_SECRET, meta.conversationId, sender)}`;
        await this.emailTurn(this.meta()!, message, next.message_id, sender, { unverified: true, keepPending: true, note: `The sender is not verified yet. Answer anything that needs no account data. If their question needs their account, say you need to confirm it's them first and include this link on its own line: ${link} (or they can sign in to Bane and press Help).` });
        return true;
      }
    }
    await this.emailTurn(this.meta()!, message, next.message_id, sender, { unverified: !this.meta()!.verified });
    return true;
  }

  private ticketCtx(meta: Meta): TicketContext {
    return { conversationId: meta.conversationId, channel: meta.channel, threadId: meta.threadId, costUsd: meta.costUsd, model: MODEL_LABEL,
      customer: { userId: meta.userId, email: meta.email, name: meta.name, role: meta.role, workspaces: meta.workspace ? [meta.workspace] : meta.workspaces.map(w => ({ id: w.id, name: w.name })) } };
  }

  private async emailTurn(meta: Meta, message: InboundMessage, messageId: string, sender: string, options: { unverified: boolean; note?: string; keepPending?: boolean }) {
    // Fail closed: without the gateway key the message stays in the inbox and the alarm retries it.
    if (!this.env.CONSOLE_GATEWAY_KEY) throw new MissingSecret('CONSOLE_GATEWAY_KEY');
    const refused = this.admit(meta);
    const body = (message.replyText || message.text || '').slice(0, 6000);
    let reply: string;
    if (refused) reply = 'Thanks for writing. I’ve passed this conversation to the Bane team, who will reply here.\n\nBane support (AI)';
    else {
      const text = `[A support email arrived${options.note ? `. ${options.note}` : ''}]\nSubject: <untrusted>${(message.subject ?? '').slice(0, 200)}</untrusted>\n<untrusted source="email">\n${body}\n</untrusted>`;
      const result = await (await this.agent()).turn({ text, context: customerBlock(this.customer(options.unverified ? { ...meta, verified: null, workspace: null, workspaces: [] } : meta)) }, options.unverified ? this.unverifiedTools() : this.toolHost(), () => {}, new AbortController().signal);
      meta = this.update(m => { m.turns += 1; m.inputTokens += result.usage.inputTokens; m.outputTokens += result.usage.outputTokens; m.costUsd += result.usage.costUsd; m.lastActivity = Date.now(); });
      reply = plainText(result.text.trim());
      const checked = gate(reply, { ...this.gateScope(meta), emails: [sender] });
      if (!checked.ok || !reply) {
        console.warn(JSON.stringify({ level: 'warn', code: 'OUTPUT_GATE_TRIPPED', conversation: meta.conversationId, reasons: checked.ok ? ['empty'] : checked.reasons }));
        await this.harnessTicket(meta, { category: 'other', severity: 'P3', summary: 'The output gate held an email reply.', ask: body.slice(0, 600), tried: [], recommendation: 'Read the thread and reply to the customer.', evidence: { ids: [messageId] } });
        reply = 'Thanks for writing. I’ve passed this to the Bane team to check, and someone will reply here, usually within one business day.\n\nBane support (AI)';
      }
    }
    // Only ever to the address that wrote (and, once verified, the verified address); Reply-To and Cc are ignored.
    await baneApi(this.env).reply(message.threadId ?? meta.threadId!, { replyToMessageId: messageId, text: reply, to: sender }, `reply-${messageId}`);
    if (!options.keepPending) this.sql.exec("UPDATE support_inbox SET state = 'answered' WHERE message_id = ?", messageId);
    this.record({ id: newId('msg'), role: 'user', kind: null, text: body, at: new Date().toISOString(), tools: [] });
    this.record({ id: newId('msg'), role: 'assistant', kind: 'reply', text: reply, at: new Date().toISOString(), tools: [] });
    await this.env.DB.prepare('UPDATE conversations SET turns = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, updated_at = ? WHERE id = ?').bind(meta.turns, meta.inputTokens, meta.outputTokens, meta.costUsd, Date.now(), meta.conversationId).run();
  }

  /** Tools for an unverified sender: nothing that reads an account; a ticket is still possible. */
  private unverifiedTools(): ToolHost {
    const host = this.toolHost();
    const none = async () => { throw new ToolFailure('This sender is not verified, so you have no account access. Answer general questions only.'); };
    return { ...host, read: none, chooseWorkspace: none, requestContentAccess: none };
  }

  // ---------- alarm: email inbox, retries, idle close, retention ----------

  override async alarm() {
    const meta = this.meta();
    if (!meta) return;
    if (meta.closedAt && Date.now() - meta.closedAt > KEEP_AFTER_CLOSE_MS) { await this.ctx.storage.deleteAll(); return; }
    try { while (await this.processInbox()) { /* one message at a time, in order */ } }
    catch (error) { console.error(JSON.stringify({ level: 'error', code: 'INBOX_FAILED', message: String(error).slice(0, 300) })); await this.ctx.storage.setAlarm(Date.now() + 60_000); return; }
    const idle = meta.channel === 'chat' ? CHAT_IDLE_MS : EMAIL_IDLE_MS;
    if (!meta.closedAt && Date.now() - meta.lastActivity >= idle) await this.close('idle');
    const after = this.meta()!;
    await this.ctx.storage.setAlarm(after.closedAt ? after.closedAt + KEEP_AFTER_CLOSE_MS : after.lastActivity + idle);
  }

  private async close(reason: 'idle' | 'limit' | 'ended') {
    const meta = this.update(m => { m.status = 'closed'; m.closedAt = Date.now(); });
    await this.revokeGrant();
    this.broadcast({ type: 'closed', reason });
    for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, 'closed'); } catch { /* gone */ } }
    await this.env.DB.prepare("UPDATE conversations SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?").bind(meta.closedAt, meta.closedAt, meta.conversationId).run();
  }
}

import { TOOLS } from './agent/tools.js';
const SPECS = new Map(TOOLS.map(t => [t.name, t]));
function labels(tool: string, args: Record<string, unknown>) {
  return SPECS.get(tool)?.label(args) ?? { running: 'Working on it…', done: 'Done' };
}
