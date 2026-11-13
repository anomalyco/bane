import { baneApi } from './bane.js';
import type { Env } from './env.js';

// Daily caps (security review M5): every model turn, ticket and inbound email counts against the person or sender and
// against the whole installation, per UTC day, in D1. A refused turn or ticket fails closed (a fixed reply, no model
// call); the first time a global cap is hit each day, the team gets one email.

export const DEFAULT_LIMITS = {
  /** Model turns, all conversations together. The Console key's own budget is the backstop. */
  turnsPerDay: 1500,
  ticketsPerDay: 60,
  /** One signed-in person (chat) or one verified sender (email). */
  turnsPerPerson: 100,
  ticketsPerPerson: 3,
  /** Inbound support mail per sender address, and in total. */
  mailPerSender: 20,
  mailPerDay: 2000,
  /** "Confirm it's me" emails per address. */
  confirmsPerAddress: 1,
};
export type Limits = typeof DEFAULT_LIMITS;

/** The caps, with stage overrides from vars (LIMIT_<NAME> as a positive integer). */
export function limits(env: Env): Limits {
  const out = { ...DEFAULT_LIMITS }, vars = env as unknown as Record<string, unknown>;
  for (const name of Object.keys(out) as (keyof Limits)[]) {
    const value = Number(vars[`LIMIT_${name.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`]);
    if (Number.isInteger(value) && value > 0) out[name] = value;
  }
  return out;
}

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** Counts one use of `key` today and says whether it is within `limit`. Atomic in D1. */
export async function countToday(env: Env, key: string, limit: number, now = Date.now()): Promise<{ ok: boolean; n: number }> {
  const day = today(now);
  const row = await env.DB.prepare('INSERT INTO daily_counters (day, key, n) VALUES (?, ?, 1) ON CONFLICT (day, key) DO UPDATE SET n = n + 1 RETURNING n').bind(day, key).first<{ n: number }>();
  const n = row?.n ?? Number.MAX_SAFE_INTEGER;
  // Keep a week of counters.
  if (n === 1 && key === 'global:mail') await env.DB.prepare('DELETE FROM daily_counters WHERE day < ?').bind(today(now - 7 * 86_400_000)).run();
  return { ok: n <= limit, n };
}

/** Tells the team once a day that a global cap was reached (idempotent per day and kind). */
export async function alertOnce(env: Env, kind: 'turns' | 'tickets' | 'mail', limit: number) {
  const first = await countToday(env, `alert:${kind}`, 1);
  console.error(JSON.stringify({ level: 'error', code: 'SUPPORT_DAILY_CAP_REACHED', kind, limit }));
  if (!first.ok) return;
  const what = { turns: 'model-turn budget', tickets: 'ticket cap', mail: 'inbound mail cap' }[kind];
  try {
    await baneApi(env).startThread({ to: [env.TICKET_TO], subject: `[Bane support] Daily ${what} reached (${limit})`,
      text: [`The support agent reached its daily ${what} of ${limit} on ${today()} (UTC).`, '', kind === 'turns'
        ? 'Until midnight UTC, chats show "support is busy" and support emails get a fixed reply saying the team will answer.'
        : kind === 'tickets' ? 'Until midnight UTC, new tickets are refused; the agent tells customers to email again tomorrow or wait for the team.'
          : 'Until midnight UTC, further support emails are not processed.', '', `Raise it with the LIMIT_${kind === 'turns' ? 'TURNS' : kind === 'tickets' ? 'TICKETS' : 'MAIL'}_PER_DAY var, or check the conversations for abuse.`].join('\n') },
      `cap-${kind}-${today()}`);
  } catch (error) { console.error(JSON.stringify({ level: 'error', code: 'SUPPORT_CAP_ALERT_FAILED', message: String(error).slice(0, 200) })); }
}
