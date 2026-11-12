import {gatewayLane} from './protocol-admission.js';
import { getPath } from 'hono/utils/url';
import type { Config, FeedbackItem, Runtime } from './core.js';
import { DispatcherShard, dispatcherName, shardCount } from './dispatcher-do.js';
export { DispatcherShard };

// Keep top-level evaluation empty so cold-started isolates answer /health without
// loading OpenAPI/Zod schemas, Better Auth, MCP, Drizzle, pg or AWS SDK clients.
const FAST_SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; worker-src 'self' blob:; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
function fastSecure(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(FAST_SECURITY_HEADERS)) if (!headers.has(name)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function initRuntimeDeps() {
  return Promise.all([
    import('pg'), import('drizzle-orm/node-postgres'), import('drizzle-orm/sql'),
    import('./config.js'), import('./adapters/storage.js'),
    import('./jobs.js'), import('./core.js'),
    import('./adapters/browser-rendering.js'), import('./adapters/public-image.js'), import('./adapters/feedback-queue.js'),
  ]).then(([{ Pool }, { drizzle }, { sql }, { CONFIG_KEYS, loadConfig }, { r2Storage }, { followDueJobs, jobConcurrency, WAKE_SCHEDULE_KEY }, core, { browserImageRenderer }, { publicImageImporter }, { feedbackSink, settleFeedbackMessage, workWake }]) => ({
    Pool, drizzle, sql, CONFIG_KEYS, loadConfig, r2Storage, followDueJobs, jobConcurrency, WAKE_SCHEDULE_KEY, core, browserImageRenderer, publicImageImporter, feedbackSink, settleFeedbackMessage, workWake,
  }));
}
async function toModuleLoadError(error: unknown): Promise<never> {
  const core = await import('./core.js').catch(() => null);
  throw core ? (error instanceof core.ModuleLoadError ? error : new core.ModuleLoadError(error)) : error;
}
let runtimeDepsPromise: ReturnType<typeof initRuntimeDeps> | undefined;
function loadRuntimeDeps() {
  return runtimeDepsPromise ??= initRuntimeDeps().catch(error => { runtimeDepsPromise = undefined; return toModuleLoadError(error); });
}
let appPromise: Promise<typeof import('./app.js')> | undefined;
function loadApp() {
  return appPromise ??= import('./app.js').catch(error => { appPromise = undefined; return toModuleLoadError(error); });
}
function loadHttpDeps() {
  return Promise.all([loadRuntimeDeps(), loadApp()]).then(([runtimeDeps, { app }]) => ({ ...runtimeDeps, app }));
}

// A provider group fits on one shard. Spread small sends across the pool without waking idle siblings.
let nextShard: number | undefined;
async function wakeDispatchers(env: Env, region: string, accountId?: string, emails?: number, kind?: 'shared' | 'byo', priority = false) {
  const count = kind === 'byo' ? 1 : shardCount('DISPATCH_SHARDS' in env ? env.DISPATCH_SHARDS : undefined);
  nextShard ??= Math.floor(Math.random() * 0x100000000);
  const indexes = emails !== undefined && emails <= 6 ? [nextShard++ % count] : Array.from({ length: count }, (_, i) => i);
  await Promise.all(indexes.map(index => {
    const identity = { accountId, region, shard: { index, count } };
    const stub = env.DISPATCHER.get(env.DISPATCHER.idFromName(dispatcherName(identity)), { locationHint: 'enam' });
    return stub.fetch(`https://dispatcher/wake?region=${encodeURIComponent(region)}&shard=${index}&count=${count}${accountId ? `&account=${encodeURIComponent(accountId)}` : ''}${priority ? '&priority=1' : ''}`);
  }));
}

// Every line names the Worker and the commit it runs (DEPLOY_SHA, set by .github/scripts/deploy-worker.sh).
function stampLogs(env: Env, core: typeof import('./core.js')) {
  core.setLogContext({ service: 'worker', deploy: (env as unknown as Record<string, unknown>).DEPLOY_SHA });
}

let cachedConfig: { key: string; config: Config } | undefined;
function configFor(env: Env, keys: readonly string[], loadConfig: (input: Record<string, unknown>) => Config): Config {
  const input: Record<string, unknown> = {};
  const record = env as unknown as Record<string, unknown>;
  for (const name of keys) if (name in record) input[name] = record[name];
  const key = JSON.stringify(input);
  if (cachedConfig?.key === key) return { ...cachedConfig.config };
  const config = loadConfig(input);
  cachedConfig = { key, config };
  return { ...config };
}

const queueName = (env: Env, key: 'FEEDBACK_QUEUE_NAME' | 'WORK_QUEUE_NAME', fallback: string) => {
  const value: unknown = (env as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : fallback;
};
async function withRuntime<T>(env: Env, work: (runtime: Runtime) => Promise<T>, max = 1, ctx?: ExecutionContext): Promise<T> {
  const { Pool, drizzle, sql, CONFIG_KEYS, loadConfig, r2Storage, jobConcurrency, WAKE_SCHEDULE_KEY, core, browserImageRenderer, publicImageImporter, feedbackSink, workWake } = await loadRuntimeDeps();
  // Optional Worker variable, default two active jobs; six matches the platform's
  // simultaneous outbound-connection ceiling while the shared SES gate limits rate.
  const concurrency = jobConcurrency('JOB_CONCURRENCY' in env ? env.JOB_CONCURRENCY : undefined, 6);
  const config = configFor(env, CONFIG_KEYS, loadConfig);
  // Defer Hyperdrive/Pool creation until a handler actually touches db: missing-auth,
  // validation and cached responses never allocate a pool or touch Hyperdrive.
  let client: InstanceType<typeof Pool> | undefined;
  let instance: Runtime['db'] | undefined;
  const getDb = () => {
    if (!instance) {
      client = new Pool({ connectionString: env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 10000, max });
      client.on('error', () => { /* An idle reset surfaces on the next query; teardown ignores it. */ });
      instance = drizzle(client);
    }
    return instance;
  };
  const db = new Proxy({} as Runtime['db'], {
    get(_target, prop) {
      const target = getDb();
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const nudges: ((runtime: Runtime) => Promise<void>)[] = [];
  try {
    const notify = workWake(env.WAKE_QUEUE, concurrency);
    return await work({ db, storage: r2Storage(env.ATTACHMENTS), config, mailR2: env.MAIL && { bucket:env.MAIL,name:env.BANE_MAIL_BUCKET,write:String(env.BANE_MAIL_STORE)==='r2' }, jwksCacheScope: env.HYPERDRIVE,
      allowSnsCertMiss: async peer => (await env.SNS_CERT_MISSES.limit({key: `bane:sns-miss:${await core.digest(peer)}`})).success,
      allowMalformedSns: async peer => (await env.ADMISSION.limit({key:`bane:sns-malformed:${await core.digest(peer)}`})).success,
      allowFeedbackTopic:async arn=>(await env.ADMISSION.limit({key:`feedback:${arn}`})).success, placementEdge:{probesPerJob:Math.min(3,Math.floor(6/concurrency))}, deferNudge: ctx ? pending => { nudges.push(pending); } : undefined, wake: async (readyJobs = 1, immediate) => {
      if (immediate === 'webhook' && env.WEBHOOK_QUEUE) return workWake(env.WEBHOOK_QUEUE,concurrency)(readyJobs);
      if (immediate || readyJobs > concurrency) return notify(readyJobs);
      // Only orchestration singletons coalesce. Delay past the window so the signal cannot
      // be consumed before a later coalesced commit; callback delivery never waits here.
      const reserved = await db.execute<{ wake_not_before: string }>(sql`INSERT INTO job_schedule(workspace_id, wake_not_before)
        VALUES (${WAKE_SCHEDULE_KEY}, clock_timestamp() + interval '1 second')
        ON CONFLICT (workspace_id) DO UPDATE SET wake_not_before = clock_timestamp() + interval '1 second'
        WHERE job_schedule.wake_not_before IS NULL OR job_schedule.wake_not_before <= clock_timestamp()
        RETURNING wake_not_before::text`);
      const fence = reserved.rows[0]?.wake_not_before;
      if (!fence) { core.log('info', { code: 'QUEUE_WAKE_COALESCED', readyJobs }); return; }
      try { await env.WAKE_QUEUE.send({ kind: 'wake' }, { delaySeconds: 1 }); }
      catch (error) {
        try { await db.execute(sql`UPDATE job_schedule SET wake_not_before = NULL WHERE workspace_id = ${WAKE_SCHEDULE_KEY} AND wake_not_before = ${fence}::timestamptz`); }
        catch { /* Preserve the send error; this reservation also expires on its own. */ }
        throw error;
      }
      core.log('info', { code: 'QUEUE_WAKE', readyJobs, messages: 1 });
    }, dispatch: (...args) => wakeDispatchers(env, ...args), feedback: feedbackSink(env.FEEDBACK_QUEUE), renderHtmlImage: browserImageRenderer(env.BROWSER), importPublicImage: publicImageImporter() });
  } finally {
    if (client) {
      if (ctx) ctx.waitUntil(client.end().catch(() => {}));
      else await client.end();
    }
    // Dispatch and immediate webhook nudges open no database connection.
    if (ctx && nudges.length) ctx.waitUntil(withRuntime(env, async runtime => { for (const nudge of nudges) await nudge(runtime); }));
  }
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      if (request.method === 'GET' || request.method === 'HEAD') { url.protocol = 'https:'; return fastSecure(Response.redirect(url.toString(), 301)); }
      return fastSecure(Response.json({ error: { code: 'HTTPS_REQUIRED', message: 'Use HTTPS.', retryable: false } }, { status: 403, headers: { 'cache-control': 'no-store' } }));
    }
    const pathname = getPath(request);
    if (pathname === '/health' && (request.method === 'GET' || request.method === 'HEAD') && !request.headers.has('X-Bane-Environment') && !request.headers.has('X-OpenSend-Environment')) {
      const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
      const multiTenant = ('MULTI_TENANT' in env ? env.MULTI_TENANT : undefined) === 'true';
      // The installation's canonical origin (PUBLIC_URL), never the request's Host; omitted if PUBLIC_URL isn't a URL.
      let origin: string | undefined; try { origin = new URL(String((env as { PUBLIC_URL?: unknown }).PUBLIC_URL)).origin; if (origin === 'null') origin = undefined; } catch { origin = undefined; }
      return fastSecure(new Response(request.method==='HEAD'?null:JSON.stringify({status:'ok',service:'bane',multiTenant,...(origin ? { origin } : {})}), { headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store', 'x-request-id': requestId } }));
    }
    const staticDoc = (request.method === 'GET' || request.method === 'HEAD') && (['/openapi.json', '/docs.md', '/llms.txt'].includes(pathname) || pathname.startsWith('/docs/operations/'));
    const assets = (env as unknown as { ASSETS?: Fetcher }).ASSETS;
    if (assets && (request.method === 'GET' || request.method === 'HEAD') && !staticDoc && !/^\/(?:health|v1|api|mcp|\.well-known|unsubscribe|internal)(?:\/|$)/.test(pathname)) {
      return fastSecure(await assets.fetch(request));
    }
    let deps: Awaited<ReturnType<typeof loadHttpDeps>> | undefined;
    try {
      deps = await loadHttpDeps();
      const { app, core } = deps;
      stampLogs(env, core);
      const admissionStarted = performance.now();
      const address = core.admissionPeer(request.headers.get('CF-Connecting-IP') ?? '127.0.0.1');
      const peer = await core.digest(core.admissionKey(address, request.headers.get('CF-Worker')));
      // SNS shares egress IPs across subscriptions. This byte-bounded route
      // verifies the signature before looking up a topic or queuing feedback.
      const feedbackIngress = pathname === '/v1/events/ses' && request.method === 'POST';
      const lane = gatewayLane(request.method,pathname,request.headers,'MAILGW_API_TOKEN' in env ? env.MAILGW_API_TOKEN : undefined);
      if (!feedbackIngress && !(await env.ADMISSION.limit({ key: lane ?? `bane:default:${peer}` })).success) return core.admissionDenied();
      const admissionMs = performance.now() - admissionStarted;
      const headers = new Headers(request.headers);
      headers.delete('x-opensend-client-ip');
      headers.set('x-bane-client-ip', address);
      const runtimeStarted = performance.now();
      const response = staticDoc
        ? await app.fetch(new Request(request, { headers }), {} as Runtime)
        : await core.guardPublicRequest(pathname, headers, peer, () => withRuntime(env, async runtime =>
          app.fetch(new Request(request, { headers }), runtime), 1, ctx));
      const runtimeMs = performance.now() - runtimeStarted;
      const responseHeaders = new Headers(response.headers);
      const innerTiming = responseHeaders.get('server-timing');
      if(innerTiming) responseHeaders.set('server-timing', [innerTiming, `admission;dur=${admissionMs.toFixed(1)}`, `runtime;dur=${runtimeMs.toFixed(1)}`].join(', '));
      if (!(feedbackIngress && [400,429].includes(response.status))) core.log('info', { requestId: responseHeaders.get('x-request-id'), operation: 'worker-runtime', status: response.status, admissionMs: Number(admissionMs.toFixed(1)), runtimeMs: Number(runtimeMs.toFixed(1)) });
      return core.secureResponse(new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders }));
    }
    catch (error) {
      const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
      const known = deps && error instanceof deps.core.ApiError ? error : null;
      const code = known ? known.code : 'RUNTIME_UNAVAILABLE';
      if (deps) { stampLogs(env, deps.core); deps.core.logError(known ?? error, { event: 'request', requestId, route: 'worker-runtime', method: request.method, status: 503, code }); }
      else console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), service: 'worker', event: 'request', requestId, route: 'worker-runtime', method: request.method, status: 503, code, message: 'Unable to load the Worker runtime modules.' }));
      return fastSecure(Response.json({ error: { code, message: 'Server runtime is unavailable; use the request ID to inspect logs.', requestId, retryable: true } }, { status: 503, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } }));
    }
  },
  // Queue/scheduled continuations preserve worker chains and retry due times.
  async queue(batch, env) {
    const { jobConcurrency, followDueJobs, core, settleFeedbackMessage } = await loadRuntimeDeps();
    stampLogs(env, core);
    const concurrency = jobConcurrency('JOB_CONCURRENCY' in env ? env.JOB_CONCURRENCY : undefined, 6);
    // Queue names differ per installation (wrangler config); an unrecognized queue is retried, never acknowledged as a wake.
    if (batch.queue === queueName(env, 'FEEDBACK_QUEUE_NAME', 'bane-feedback')) {
      const { ingestFeedbackBatch } = await core.wrapModuleLoad(() => import('./operations.js'));
      // Each message is one verified callback; acknowledge and retry individually so one bad
      // payload never blocks a batch of routine deliveries.
      await withRuntime(env, async runtime => {
        const messages = batch.messages as readonly Message<FeedbackItem>[];
        const outcomes = await ingestFeedbackBatch(runtime, messages.map(message => message.body));
        let retiredUnmatched=0;
        for (const [index, message] of messages.entries()) if(settleFeedbackMessage(message, outcomes[index])==='retired_unmatched') retiredUnmatched++;
        const failed=outcomes.filter(outcome=>!outcome.ok).length-retiredUnmatched, oldestMs=Math.max(0,...messages.map(m=>Date.now()-m.timestamp.getTime()));
        core.log(failed || oldestMs>60000?'warn':'info', { code: 'FEEDBACK_BATCH', size: messages.length, failed, retiredUnmatched, oldestMs });
      });
      return;
    }
    const hooks = batch.queue === env.WEBHOOK_QUEUE_NAME, pool = hooks ? 'webhooks' : 'work';
    if (!hooks && batch.queue !== queueName(env, 'WORK_QUEUE_NAME', 'bane-work')) {
      core.log('error', { code: 'UNKNOWN_QUEUE', queue: batch.queue });
      batch.retryAll();
      return;
    }
    const { drainJobs } = await core.wrapModuleLoad(() => import('./dispatch.js'));
    await withRuntime(env, async runtime => {
      // Orchestration only (mail is dispatched by Durable Objects): a longer budget lets a campaign's
      // prepare → expand → finish chain run inside one invocation instead of one queue hop per step.
      // Wait in place up to 45 s for a job due soon (paced campaign releases), and schedule at most one follow-up.
      const outcome = await followDueJobs(runtime, () => drainJobs(runtime, 100, concurrency, 10000,pool), delaySeconds => (hooks?env.WEBHOOK_QUEUE:env.WAKE_QUEUE).send({ kind: 'wake' }, { delaySeconds }), 45000,pool);
      core.log('info', { code: 'QUEUE_FOLLOW', outcome });
    }, concurrency);
    batch.ackAll();
  },
  async scheduled(controller, env) {
    const { jobConcurrency, followDueJobs, core } = await loadRuntimeDeps();
    stampLogs(env, core);
    const [{ dispatchPartitions, drainJobs }, { reconcileSharedConnections }, { syncOutboundMessages }, { publicStatsTick }] = await core.wrapModuleLoad(() => Promise.all([
      import('./dispatch.js'), import('./provider-connections.js'), import('./mailbox-send.js'), import('./public-stats.js'),
    ]));
    const concurrency = jobConcurrency('JOB_CONCURRENCY' in env ? env.JOB_CONCURRENCY : undefined, 6);
    await withRuntime(env, async runtime => {
      if (controller.cron === '7 * * * *') {
        const [{ cleanup, reconcileUploads }, { checkReputationAlerts }, { mailboxHourly }, { resolveRegionRuntime }] = await core.wrapModuleLoad(() => Promise.all([
          import('./maintenance.js'), import('./reputation-alerts.js'), import('./mailbox-ingest.js'), import('./ses-region-state.js'),
        ]));
        await cleanup(runtime);
        await reconcileUploads(runtime);
        // Alerts are best-effort and must not stop the minute recovery work below.
        try { await checkReputationAlerts(runtime); } catch (error) { core.log('warn', { code: error instanceof core.ApiError ? error.code : 'REPUTATION_ALERT_CHECK_FAILED' }); }
        await mailboxHourly(await resolveRegionRuntime(runtime));
      }
      // Minute ping: recovers dispatchers that missed a nudge and expired-lease or interrupted rows.
      // Mailbox outbound status and Message-IDs follow the sending pipeline; best-effort.
      if (controller.cron !== '* * * * *') return;
      // Independent of PostgreSQL: even a total DB outage must not hide DLQ growth.
      await Promise.all([['feedback',env.FEEDBACK_QUEUE],['feedback-dlq',env.FEEDBACK_DLQ],['work',env.WAKE_QUEUE],['webhooks',env.WEBHOOK_QUEUE]].map(async pair=>{
        const [name,q]=pair as [string,Queue]; if(!q?.metrics)return;
        try{const m=await q.metrics(),oldestMs=m.oldestMessageTimestamp?Math.max(0,Date.now()-m.oldestMessageTimestamp.getTime()):0;
          const alarm=(name==='feedback-dlq' && m.backlogCount>0) || oldestMs>60000;
          core.log(alarm?'error':'info',{code:alarm?'QUEUE_BACKLOG_ALERT':'QUEUE_BACKLOG',queue:name,depth:m.backlogCount,oldestMs});
        }catch{core.log('warn',{code:'QUEUE_METRICS_UNAVAILABLE',queue:name});}
      }));
      await reconcileSharedConnections(runtime); // Installation work must not depend on a workspace or a successful queue drain.
      try { await syncOutboundMessages(runtime); } catch (error) { core.log('warn', { code: error instanceof core.ApiError ? error.code : 'MAILBOX_OUTBOUND_SYNC_FAILED' }); }
      await Promise.allSettled((await dispatchPartitions(runtime, true)).map(({ region, accountId, kind }) => wakeDispatchers(env, region, accountId, undefined, kind)));
      // Minute cron: recover orchestration jobs whose wake was lost.
      await followDueJobs(runtime, () => drainJobs(runtime, 100, concurrency, 10000,'work'), delaySeconds => env.WAKE_QUEUE.send({ kind: 'wake' }, { delaySeconds }),0,'work');
      if (env.WEBHOOK_QUEUE) await followDueJobs(runtime, async()=>{}, delaySeconds=>env.WEBHOOK_QUEUE.send({kind:'wake'},{delaySeconds}),0,'webhooks');
      // Last, after recovery: GET /v1/public/stats serves only what this writes. Best-effort and time-bounded.
      await publicStatsTick(runtime);
    }, concurrency);
  },
} satisfies ExportedHandler<Env>;
