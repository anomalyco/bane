import { Plugin } from '@opencode/plugin';
import type { OpenCodeWorkerd } from '@opencode/sdk/workerd';
import type { Env } from '../env.js';
import { MissingSecret } from '../tokens.js';
import type { Harness, HarnessEvent, TurnInput, TurnResult, Usage } from './harness.js';
import { TOOLS, ToolFailure, type Param, type ToolHost } from './tools.js';
import SYSTEM from './system.md';
import VOICE from '../../VOICE.md';

// The agent runtime: OpenCode, embedded in the conversation's Durable Object through `@opencode/sdk/workerd` (the same
// SDK Console's agents run on). OpenCode owns the agent loop, its history (in this object's SQLite), streaming,
// retries and eviction recovery; we give it one custom agent, our tools as a plugin, and a fetch it must use for every
// request. Upgrading means bumping @opencode/sdk and @opencode/plugin together (pinned, see package.json).
//
// Pinned model (owner decision): Claude Opus 5.5 at medium effort through Console's inference gateway, nothing else.
// The pin is enforced four ways: the config model, the agent model, the session model (without it OpenCode would fall
// back to any available model) and a provider policy; and the fetch below refuses any request that isn't exactly it.

export const MODEL = { providerID: 'anthropic', model: 'claude-opus-5-5', variant: 'medium' } as const;
const MAX_STEPS = 25;
const TOOL_NAMES = TOOLS.map(t => t.name);
/** Session rules merge after every plugin's agent rules: this, not the agent's list, decides what the model can call. */
const PERMISSIONS = [{ action: '*', resource: '*', effect: 'deny' as const }, ...TOOL_NAMES.map(name => ({ action: name, resource: '*', effect: 'allow' as const }))];

export const systemPrompt = () => `${SYSTEM.trim()}\n\n---\n\n# Voice (follow it)\n\n${VOICE.trim()}`;

function config(gatewayURL: string): OpenCodeWorkerd.Configuration {
  return {
    default_agent: 'support',
    model: MODEL,
    // Only the gateway-backed provider exists, so nothing can resolve to another provider as a fallback.
    policies: [
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: 'anthropic', effect: 'allow' },
      { action: 'websearch.use', resource: '*', effect: 'deny' },
    ],
    // No apiKey: OpenCode sends none, and modelFetch adds the gateway key. The key never enters OpenCode's config,
    // storage or the model's context.
    providers: { anthropic: { settings: { baseURL: gatewayURL } } },
    agents: {
      support: { mode: 'primary', model: MODEL, system: systemPrompt(), steps: MAX_STEPS, permissions: PERMISSIONS },
      build: { disabled: true }, plan: { disabled: true }, general: { disabled: true }, explore: { disabled: true },
      // Title and summary would call a smaller model: never.
      title: { disabled: true }, summary: { disabled: true },
    },
    // The 500K-token conversation budget stays under the model's window, so compaction (another model call) is off.
    compaction: { auto: false },
    websearch: false,
    snapshots: false,
    share: 'disabled',
  } as OpenCodeWorkerd.Configuration;
}

type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

/**
 * The only way out of the isolate for OpenCode: requests to the gateway get the key and must be the pinned model at the
 * pinned effort; anything else is refused. In tests, MODEL_FAKE stands in for the network.
 */
export function modelFetch(env: Env): Fetch {
  const root = env.GATEWAY_URL.replace(/\/$/, '');
  return async (input, init) => {
    const request = new Request(input, init);
    if (!request.url.startsWith(`${root}/`)) return new Response('egress denied', { status: 403 });
    const key = env.CONSOLE_GATEWAY_KEY;
    if (!key) throw new MissingSecret('CONSOLE_GATEWAY_KEY');
    if (request.method === 'POST') {
      const body = await request.clone().json<{ model?: string; output_config?: { effort?: string } }>().catch(() => undefined);
      if (body?.model !== MODEL.model || body?.output_config?.effort !== MODEL.variant) {
        console.error(JSON.stringify({ level: 'error', code: 'MODEL_PIN_VIOLATED', model: body?.model ?? null, effort: body?.output_config?.effort ?? null }));
        return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'This Worker only sends the pinned model.' } }, { status: 400 });
      }
    }
    const headers = new Headers(request.headers);
    headers.delete('x-api-key');
    headers.set('authorization', `Bearer ${key}`);
    const send = new Request(request, { headers });
    return env.MODEL_FAKE ? env.MODEL_FAKE.fetch(send) : fetch(send);
  };
}

function jsonSchema(params: Record<string, Param>) {
  const properties: Record<string, unknown> = {}, required: string[] = [];
  for (const [name, p] of Object.entries(params)) {
    if (!p.optional) required.push(name);
    if (p.type === 'string') properties[name] = { type: 'string', description: p.description, ...(p.max ? { maxLength: p.max } : {}), ...(p.pattern ? { pattern: p.pattern } : {}) };
    else if (p.type === 'number') properties[name] = { type: 'integer', description: p.description, ...(p.min !== undefined ? { minimum: p.min } : {}), ...(p.max !== undefined ? { maximum: p.max } : {}) };
    else if (p.type === 'enum') properties[name] = { type: 'string', enum: [...p.values], description: p.description };
    else properties[name] = { type: 'array', items: { type: 'string', maxLength: 400 }, description: p.description, ...(p.max ? { maxItems: p.max } : {}) };
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/** Distinctive lines of the system prompt, for the output gate's "never reveal this prompt" check. */
export function promptFragments() {
  return SYSTEM.split('\n').map(l => l.replace(/^[-*#>\d.|\s]+/, '').trim()).filter(l => l.length >= 60 && !/`|https?:/.test(l)).filter((_, i) => i % 4 === 0).map(l => l.slice(0, 48));
}

/** One OpenCode host per conversation object, booted on its first turn. */
export async function createHarness(env: Env, storage: DurableObjectStorage): Promise<Harness> {
  // Per turn: whose tools these are (chat, email, unverified sender) and the <customer>/<context> block.
  const current: { host: ToolHost | null; context: string } = { host: null, context: '' };
  const plugin = Plugin.define({
    id: 'bane.support',
    setup: async ctx => {
      const registration = await ctx.tool.transform(editor => {
        for (const spec of TOOLS) {
          editor.add({
            name: spec.name, description: spec.description, input: jsonSchema(spec.params) as never,
            // Native tools on the provider's list, not behind Code Mode's `execute`.
            options: { codemode: false },
            execute: async (input: unknown, context: { signal: AbortSignal }) => {
              if (!current.host) throw new Error('No conversation is attached to this turn.');
              if (context.signal.aborted) throw new Error('Cancelled.');
              try { return { content: await spec.execute((input ?? {}) as Record<string, unknown>, current.host) }; }
              catch (error) { throw new Error(error instanceof ToolFailure ? error.message : 'The tool failed. Say what you could not check and carry on.'); }
            },
          } as never);
        }
      });
      // Drop OpenCode's host-oriented system parts (a working directory, a worktree hint): this agent has no filesystem.
      // Then add this turn's <customer> and <context> after the stable prompt, so the prompt itself stays cacheable.
      const system = await ctx.session.hook('context', event => {
        event.system = event.system.filter(part => !part.text.includes('<env>') && !part.text.startsWith('When you create a worktree') && !part.text.startsWith('# Your Model'));
        if (current.context) event.system.push({ type: 'text', text: current.context });
      });
      const title = await ctx.session.hook('title', event => { event.result = 'Support conversation'; });
      return async () => { await Promise.all([registration.dispose(), system.dispose(), title.dispose()]); };
    },
  });
  const { OpenCodeWorkerd } = await import('@opencode/sdk/workerd');
  const opencode = await OpenCodeWorkerd.create({
    storage, config: config(env.GATEWAY_URL), plugins: [plugin], fetch: modelFetch(env), models: { fetch: false },
    log: { level: 'warn', emit: entry => console.warn(JSON.stringify({ level: 'warn', code: 'OPENCODE', message: String(entry.message).slice(0, 300) })) },
  });

  async function session(): Promise<string> {
    const existing = await storage.get<string>('support:opencode-session');
    if (existing) return existing;
    const created = await opencode.sessions.create({
      title: 'Support conversation', location: { directory: '/support' }, agent: 'support',
      model: { providerID: MODEL.providerID, id: MODEL.model, variant: MODEL.variant }, permissions: PERMISSIONS,
    } as never);
    await storage.put('support:opencode-session', created.id);
    return created.id;
  }

  return {
    async turn(input: TurnInput, tools: ToolHost, onEvent: (event: HarnessEvent) => void, signal: AbortSignal): Promise<TurnResult> {
      const sessionID = await session();
      // A turn cut off by an eviction resumes when OpenCode boots; let it finish first, so its events aren't read as
      // this turn's (its answer stays in OpenCode's history).
      const api = opencode as unknown as { sessions: { active(): Promise<Record<string, unknown>> }; experimental?: { session?: { wait(input: { sessionID: string }): Promise<void> } } };
      if ((await api.sessions.active().catch((): Record<string, unknown> => ({})))[sessionID] && api.experimental?.session?.wait) {
        await Promise.race([api.experimental.session.wait({ sessionID }), new Promise(resolve => setTimeout(resolve, 120_000))]).catch(() => {});
      }
      current.host = tools; current.context = input.context;
      const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
      const texts: string[] = [], names = new Map<string, string>();
      let outcome = 'failed' as 'succeeded' | 'failed' | 'interrupted', error: string | undefined, streamed = false;
      const listen = new AbortController();
      const done = (async () => {
        for await (const event of opencode.events.subscribe({ signal: listen.signal }) as AsyncIterable<{ type: string; data: Record<string, any> }>) {
          const data = event.data ?? {};
          if (data.sessionID !== sessionID) continue;
          switch (event.type) {
            case 'session.text.started': if (streamed) onEvent({ type: 'text.delta', delta: '\n\n' }); break;
            case 'session.text.delta': if (typeof data.delta === 'string' && data.delta) { streamed = true; onEvent({ type: 'text.delta', delta: data.delta }); } break;
            case 'session.text.ended': if (typeof data.text === 'string' && data.text.trim()) texts.push(data.text.trim()); break;
            case 'session.tool.input.started': names.set(String(data.id), String(data.name)); break;
            case 'session.tool.called': onEvent({ type: 'tool.start', callId: String(data.id), tool: names.get(String(data.id)) ?? 'tool', args: (data.input ?? {}) as Record<string, unknown> }); break;
            case 'session.tool.success': onEvent({ type: 'tool.end', callId: String(data.id), tool: names.get(String(data.id)) ?? 'tool', ok: true }); break;
            case 'session.tool.failed': onEvent({ type: 'tool.end', callId: String(data.id), tool: names.get(String(data.id)) ?? 'tool', ok: false }); break;
            case 'session.step.ended': {
              const t = data.tokens ?? {};
              // Uncached input (and cache writes) apart from cache reads, which cost a tenth: the budget weighs them so.
              usage.inputTokens += Number(t.input ?? 0) + Number(t.cache?.write ?? 0);
              usage.outputTokens += Number(t.output ?? 0) + Number(t.reasoning ?? 0);
              usage.cacheReadTokens += Number(t.cache?.read ?? 0);
              usage.costUsd += Number(data.cost ?? 0);
              break;
            }
            case 'session.execution.succeeded': outcome = 'succeeded'; return;
            case 'session.execution.interrupted': outcome = 'interrupted'; return;
            case 'session.execution.failed': outcome = 'failed'; error = String(data.error?.message ?? 'failed').slice(0, 300); return;
          }
        }
      })();
      const stop = () => { void opencode.sessions.interrupt({ sessionID } as never).catch(() => {}); };
      signal.addEventListener('abort', stop, { once: true });
      try {
        // Let the subscription attach before prompting, so no early event is missed.
        await new Promise(resolve => setTimeout(resolve, 0));
        await opencode.sessions.prompt({ sessionID, text: input.text } as never);
        await done;
      } finally {
        signal.removeEventListener('abort', stop);
        listen.abort();
        current.host = null;
      }
      if (outcome === 'failed') console.error(JSON.stringify({ level: 'error', code: 'TURN_FAILED', message: error }));
      return { text: texts.join('\n\n'), usage, aborted: outcome === 'interrupted', ...(outcome === 'failed' ? { error: error ?? 'failed' } : {}) };
    },
  };
}
