// The per-conversation context the harness gives the agent (never taken from the conversation itself):
// <customer> says who is verified and what the agent may act on; <context> is a small, pre-digested bundle for the
// first message (design decision 6): a name, the workspace, one or two recent sends with numbers, standing, and any
// open problem worth leading with. No recipient addresses, no IDs the customer wouldn't recognise.

type Json = Record<string, any>;
export type Customer = {
  channel: 'chat' | 'email'; userId: string | null; name: string | null; email: string | null; role: string | null;
  workspace: { id: string; name: string } | null; workspaces: { id: string; name: string; role: string }[];
  verified: 'handoff' | 'dmarc' | 'magic_link' | null; contentAccess: boolean; page: string | null;
};

const esc = (s: unknown) => String(s ?? '').replace(/[<>]/g, '').slice(0, 200);
export const firstName = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0]?.slice(0, 40) || null;

export function customerBlock(c: Customer) {
  const lines = [
    `channel: ${c.channel}`,
    `verified: ${c.verified ?? 'no — answer general questions only; no account data'}`,
    c.name ? `name: ${esc(c.name)} (call them ${esc(firstName(c.name))})` : 'name: unknown',
    c.email ? `account email: ${esc(c.email)}` : null,
    c.workspace ? `workspace in scope: ${esc(c.workspace.name)} (${esc(c.workspace.id)}), role ${esc(c.role ?? 'member')}` : c.workspaces.length > 1 ? 'workspace in scope: none chosen yet — ask which one before account questions, then call choose_workspace' : null,
    c.workspaces.length > 1 ? `their workspaces: ${c.workspaces.map(w => `${esc(w.name)} (${esc(w.id)}, ${esc(w.role)})`).join('; ')}` : null,
    `content access: ${c.contentAccess ? 'allowed for the workspace in scope' : 'not allowed (ask with request_content_access when content is the likely cause)'}`,
    c.page ? `opened support from dashboard page: ${esc(c.page)}` : null,
  ].filter(Boolean);
  return `<customer>\n${lines.join('\n')}\n</customer>`;
}

const pct = (n: number, d: number) => d > 0 ? `${Math.round((n / d) * 1000) / 10}%` : null;
const day = (iso: unknown) => { const t = Date.parse(String(iso)); return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10); };

/** The greeting bundle from /v1/support/context, /campaigns and /standing (any of which may be missing). */
export function greetingBundle(input: { context?: Json | null; campaigns?: Json | null; standing?: Json | null; now?: number }) {
  const facts: string[] = [], issues: string[] = [];
  const ctx = input.context ?? {}, now = input.now ?? Date.now();
  facts.push(`today: ${new Date(now).toISOString().slice(0, 10)}`);
  const ws = (ctx.workspaces ?? [])[0];
  if (ws) facts.push(`workspace: ${esc(ws.name)}; ${ws.sending ? `sending via ${esc(ws.sending.kind)} in ${esc(ws.sending.region)}${ws.sending.paused ? ', PAUSED' : ''}` : 'no sending set up yet'}; ${Object.entries(ws.counts ?? {}).filter(([, n]) => Number(n) > 0).map(([k, n]) => `${n} ${k}`).slice(0, 6).join(', ') || 'nothing created yet'}`);
  const campaigns = (input.campaigns?.data ?? []) as Json[];
  for (const c of campaigns.filter(c => c.launchedAt || c.state === 'sent' || c.state === 'sending').slice(0, 2)) {
    const s = c.stats ?? {}, delivered = Number(s.delivered ?? 0);
    const parts = [`campaign "${esc(c.name ?? c.subject)}" ${esc(c.state)}${day(c.launchedAt ?? c.createdAt) ? ` on ${day(c.launchedAt ?? c.createdAt)}` : ''}`];
    if (delivered) parts.push(`${delivered} delivered`);
    const opens = pct(Number(s.uniqueOpens ?? s.opened ?? 0), delivered); if (opens && c.tracking !== false) parts.push(`${opens} opens`);
    const clicks = pct(Number(s.uniqueClicks ?? s.clicked ?? 0), delivered); if (clicks && c.tracking !== false) parts.push(`${clicks} clicks`);
    const bounced = pct(Number(s.bounced ?? 0), Number(s.accepted ?? s.sent ?? delivered)); if (bounced && Number(s.bounced) > 0) parts.push(`${bounced} bounced`);
    facts.push(parts.join(', '));
  }
  const last24 = ((input.standing?.data ?? ctx.standing ?? [])[0]?.last24h ?? {}) as Record<string, number>;
  const sent24 = Object.values(last24).reduce((a, b) => a + Number(b || 0), 0);
  if (sent24) facts.push(`last 24 hours: ${sent24} emails (${Object.entries(last24).map(([k, n]) => `${n} ${k}`).join(', ')})`);
  const standing = (input.standing?.data ?? ctx.standing ?? [])[0]?.standing;
  if (standing) {
    facts.push(`standing: step ${esc(standing.step)}, score ${esc(standing.score)}, daily limit ${esc(standing.dailyLimit)}`);
    if (standing.step && !['normal', 'good', 'ok', 'none'].includes(String(standing.step))) issues.push(`sending is at step "${esc(standing.step)}"${standing.reasons?.length ? ` because ${esc(JSON.stringify(standing.reasons).slice(0, 160))}` : ''}`);
  }
  for (const d of (ctx.domains ?? []) as Json[]) {
    if (d.sending && d.sending !== 'verified') issues.push(`domain ${esc(d.name)} is ${esc(d.sending)} for sending`);
    else if (d.dmarc && !/pass|verified|found|ok/i.test(String(d.dmarc))) issues.push(`domain ${esc(d.name)} DMARC is ${esc(d.dmarc)}`);
    if (issues.length >= 3) break;
  }
  for (const e of (ctx.openEnforcement ?? []) as Json[]) issues.push(`${String(e.kind).startsWith('campaign_paused') ? 'a campaign is paused' : 'sending is paused'}${e.reason ? `: ${esc(e.reason)}` : ''}`);
  const failures = ((ctx.recentFailures?.sends ?? []) as Json[]).filter(f => Number(f.count) >= 5).slice(0, 2);
  for (const f of failures) issues.push(`${f.count} sends ${esc(f.status)} in the last 24 hours (${esc(f.code)})`);
  const handoff = ctx.handoff;
  return `<context>\n${facts.join('\n')}\n${issues.length ? `open issues (lead gently with the most important one):\n${issues.slice(0, 3).map(i => `- ${i}`).join('\n')}` : 'open issues: none found'}${handoff?.page ? `\nopened from: ${esc(handoff.page)}` : ''}\n</context>`;
}
