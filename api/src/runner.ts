import { setTimeout } from 'node:timers/promises';
import { Client } from 'pg';
import { nodeRuntime, postgresConnection } from './adapters/node.js';
import { drain,drainJobs } from './dispatch.js';
import type { GateState } from './dispatcher.js';
import { jobConcurrency } from './jobs.js';
import { hourlyUpkeep } from './maintenance.js';
import { reconcileSharedConnections } from './provider-connections.js';
import { publicStatsTick } from './public-stats.js';
import { syncOutboundMessages } from './mailbox-send.js';
import { queueStartupDiscovery } from './ses-regions.js';
import { ApiError, log, logError, setLogContext } from './core.js';
setLogContext({ service: 'runner', deploy: process.env.DEPLOY_SHA });
try {
  const { runtime, close } = nodeRuntime(process.env);
  const concurrency = jobConcurrency(process.env.JOB_CONCURRENCY);
  let stopped = false; let lastCleanup = 0; let lastOutboundSync = 0; let lastRecovery = 0;
  let sharedSetup: Promise<void> | undefined, lastSharedSetup = 0;
  let publicStats: Promise<void> | undefined, lastPublicStats = 0;
  let hourly: Promise<unknown> | undefined;
  // In-process pacing state per account/region. Run one runner per installation (or split
  // the quota explicitly): separate processes do not share this gate.
  const gates = new Map<string, GateState>();
  // LISTEN requires a session connection, not a checked-out query/transaction connection. Losing
  // this best-effort nudge only costs latency: ordinary leases still discover every due row.
  const priorityWake = new EventTarget();
  let listener: Client | undefined, lastListen = 0;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stopped = true; });
  log('info', { code: 'RUNNER_READY', liveSesEnabled: runtime.config.liveEnabled });
  const hooks=(async()=>{while(!stopped){try{if(await drainJobs(runtime,20,2,5000,'webhooks'))continue;}catch{log('warn',{code:'WEBHOOK_DRAIN_FAILED'});}await setTimeout(1000);}})();
  try {
    await queueStartupDiscovery(runtime);
    while (!stopped) {
      try {
        if (!listener && Date.now() - lastListen >= 15000) {
          lastListen = Date.now();
          const client = new Client(postgresConnection(process.env.DATABASE_URL));
          client.on('notification', msg => { if (msg.payload) priorityWake.dispatchEvent(new Event(msg.payload)); });
          client.on('error', () => log('warn', { code: 'DISPATCH_LISTENER_FAILED', message: 'Priority wakes disconnected; ordinary leases continue.' }));
          client.on('end', () => { if (listener === client) listener = undefined; });
          try { await client.connect(); await client.query('LISTEN bane_priority'); listener = client; }
          catch { await client.end(); }
        }
        // Don't stall mail dispatch while waiting for a platform pool to come online.
        if (runtime.config.multiTenant && !sharedSetup && Date.now() - lastSharedSetup >= 60_000) {
          lastSharedSetup = Date.now();
          sharedSetup = reconcileSharedConnections(runtime).catch(() => log('warn', { code: 'SHARED_SETUP_FAILED' })).finally(() => { sharedSetup = undefined; });
        }
        // GET /v1/public/stats serves only what this writes. In the background, so dispatch never waits on it.
        if (!publicStats && Date.now() - lastPublicStats >= 60_000) {
          lastPublicStats = Date.now();
          publicStats = publicStatsTick(runtime).finally(() => { publicStats = undefined; });
        }
        // In the background, like shared setup: retention can take minutes, and a step that keeps failing used to throw
        // here before drain() on every pass, so no job ran and no mail was dispatched until it succeeded.
        if (!hourly && Date.now() - lastCleanup > 3600000) {
          lastCleanup = Date.now();
          hourly = hourlyUpkeep(runtime).finally(() => { hourly = undefined; });
        }
        if (Date.now() - lastOutboundSync > 15000) {
          lastOutboundSync = Date.now();
          try { await syncOutboundMessages(runtime); } catch (error) { log('warn', { code: error instanceof ApiError ? error.code : 'MAILBOX_OUTBOUND_SYNC_FAILED' }); }
        }
        const recover = Date.now() - lastRecovery >= 60_000;
        const count = await drain(runtime, concurrency * 10, concurrency, 5000, gates, recover, priorityWake,'work');
        if (recover) lastRecovery = Date.now();
        if (!count) await setTimeout(1000);
      } catch (error) {
        logError(error, { code: error instanceof ApiError ? error.code : 'RUNNER_FAILED' }); // Job polling failed: check database connectivity and migrations.
        await setTimeout(5000);
      }
    }
  } finally { stopped=true;await hooks;await sharedSetup;await publicStats;await hourly; await listener?.end(); await close(); }
} catch (error) {
  logError(error, { code: error instanceof ApiError ? error.code : 'STARTUP_FAILED' });
  process.exitCode = 1;
}
