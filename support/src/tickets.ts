import { baneApi } from './bane.js';
import type { Env } from './env.js';
import type { TicketInput } from './agent/tools.js';
import { newId } from './tokens.js';

// Tickets (design §7, with the owner's change: email, not Slack). One per conversation, stored in D1, emailed to the
// Bane team from support@bane.mx through Bane's own API. For a chat, the customer also gets a short email that opens the
// follow-up thread the team replies in (from Bane's support inbox); for an email conversation that thread already exists.

export type TicketContext = {
  conversationId: string; channel: 'chat' | 'email'; customer: { userId: string | null; email: string | null; name: string | null; role: string | null; workspaces: { id: string; name: string }[] };
  threadId: string | null; costUsd: number; model: string;
};
export type FiledTicket = { id: string; created: boolean; dueAt: number; replyTo: string | null };

const HOUR = 3_600_000;
/** When the team should have answered (D8): appeals 4 business hours, limit requests 2 business days, else 1. */
export function dueAt(category: string, severity: string, now = Date.now()) {
  if (severity === 'P1') return now + 4 * HOUR;
  if (category === 'enforcement_review') return addBusinessHours(now, 4);
  return addBusinessHours(now, category === 'limit_increase' ? 16 : 8);
}
function addBusinessHours(start: number, hours: number) {
  // Business hours: Monday–Friday 9:00–17:00 US Eastern (UTC−5; a simple, conservative approximation).
  let t = start, left = hours * HOUR;
  const offset = -5 * HOUR;
  while (left > 0) {
    const local = new Date(t + offset), day = local.getUTCDay(), hour = local.getUTCHours() + local.getUTCMinutes() / 60;
    if (day === 0 || day === 6 || hour >= 17) { const next = new Date(local); next.setUTCDate(local.getUTCDate() + (day === 6 ? 2 : day === 0 ? 1 : hour >= 17 ? (day === 5 ? 3 : 1) : 0)); next.setUTCHours(9, 0, 0, 0); t = next.getTime() - offset; continue; }
    if (hour < 9) { const next = new Date(local); next.setUTCHours(9, 0, 0, 0); t = next.getTime() - offset; continue; }
    const step = Math.min(left, (17 - hour) * HOUR);
    t += step; left -= step;
  }
  return t;
}

const masked = (email: string | null) => {
  if (!email) return null;
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}…@${domain}`;
};

export async function fileTicket(env: Env, ctx: TicketContext, input: TicketInput, now = Date.now()): Promise<FiledTicket> {
  const existing = await env.DB.prepare('SELECT id, due_at, notes FROM tickets WHERE conversation_id = ?').bind(ctx.conversationId).first<{ id: string; due_at: number; notes: string }>();
  if (existing) {
    // One ticket per conversation: later facts are appended, and the team gets them on the same email thread.
    const notes = JSON.parse(existing.notes) as unknown[];
    notes.push({ at: new Date(now).toISOString(), category: input.category, summary: input.summary.slice(0, 1200), recommendation: input.recommendation.slice(0, 800), tried: input.tried });
    await env.DB.prepare('UPDATE tickets SET notes = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(notes.slice(-20)), now, existing.id).run();
    return { id: existing.id, created: false, dueAt: existing.due_at, replyTo: masked(ctx.customer.email) };
  }
  const id = newId('tkt'), due = dueAt(input.category, input.severity, now);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO tickets (id, conversation_id, channel, category, severity, due_at, customer, summary, ask, tried, recommendation, evidence, followup_thread_id, cost_usd, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (conversation_id) DO NOTHING`).bind(id, ctx.conversationId, ctx.channel, input.category, input.severity, due, JSON.stringify(ctx.customer),
      input.summary.slice(0, 1200), input.ask.slice(0, 600), JSON.stringify(input.tried), input.recommendation.slice(0, 800), JSON.stringify(input.evidence), ctx.threadId, ctx.costUsd, ctx.model, now, now),
    env.DB.prepare("UPDATE conversations SET status = 'ticketed', ticket_id = coalesce(ticket_id, ?), updated_at = ? WHERE id = ?").bind(id, now, ctx.conversationId),
  ]);
  return { id, created: true, dueAt: due, replyTo: masked(ctx.customer.email) };
}

/** The team's email. Idempotent per ticket, so a retried notification never sends twice. */
export async function notifyTeam(env: Env, ctx: TicketContext, ticket: FiledTicket, input: TicketInput) {
  const api = baneApi(env), c = ctx.customer;
  const lines = [
    `${input.severity} · ${input.category.replaceAll('_', ' ')} · due ${new Date(ticket.dueAt).toUTCString()}`,
    '',
    `Customer: ${c.name ?? '(no name)'} <${c.email ?? 'unverified'}>, ${c.role ?? 'member'}`,
    `Workspaces: ${c.workspaces.map(w => `${w.name} (${w.id})`).join(', ') || '—'}`,
    `Conversation: ${ctx.conversationId} (${ctx.channel})${ctx.threadId ? ` · thread ${ctx.threadId}` : ''}`,
    '',
    'Summary',
    input.summary,
    '',
    'What they asked (quoted, untrusted)',
    `> ${input.ask.replace(/\n/g, '\n> ')}`,
    '',
    'What the agent checked',
    ...(input.tried.length ? input.tried.map(t => `- ${t.tool}: ${t.finding}`) : ['- (nothing)']),
    '',
    'Recommendation',
    input.recommendation,
    '',
    ...(input.evidence.ids?.length ? [`Evidence: ${input.evidence.ids.join(', ')}`, ''] : []),
    `Cost so far: $${ctx.costUsd.toFixed(3)} on ${ctx.model}.`,
    ctx.channel === 'chat' ? 'Reply to the customer in the follow-up thread in Bane’s support inbox (they were emailed).' : 'Reply to the customer in the email thread in Bane’s support inbox.',
  ];
  const sent = await api.startThread({ to: [env.TICKET_TO], subject: `[Bane support] ${ticket.id}: ${input.category.replaceAll('_', ' ')} (${input.severity})`, text: lines.join('\n') }, `ticket-${ticket.id}`);
  await env.DB.prepare('UPDATE tickets SET notified_at = ? WHERE id = ?').bind(Date.now(), ticket.id).run();
  return sent;
}

/** For a chat ticket: the customer's acknowledgement, which is also the thread the team replies in. */
export async function openFollowUp(env: Env, ctx: TicketContext, ticket: FiledTicket) {
  if (ctx.channel !== 'chat' || !ctx.customer.email) return null;
  const first = ctx.customer.name?.split(/\s+/)[0] ?? 'there';
  const text = [`Hi ${first},`, '', `I’ve passed your request to the Bane team as ${ticket.id}. Someone will reply here, usually within one business day. You don’t need to do anything else; if you have more to add, reply to this email.`, '', 'Bane support (AI)'].join('\n');
  const sent = await api(env).startThread({ to: [ctx.customer.email], subject: `Your Bane support request ${ticket.id}`, text }, `followup-${ticket.id}`);
  await env.DB.batch([
    env.DB.prepare('UPDATE tickets SET followup_thread_id = ? WHERE id = ?').bind(sent.threadId, ticket.id),
    env.DB.prepare('UPDATE conversations SET thread_id = coalesce(thread_id, ?) WHERE id = ?').bind(sent.threadId, ctx.conversationId),
  ]);
  return sent;
}
const api = baneApi;
