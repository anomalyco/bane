import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { log } from './core.js';
import { postgresConnection } from './adapters/node.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { deriveEncryptionKey, loadConfig, migrationSettings } from './config.js';
import { decrypt, reencryptWebhookSecrets } from './operations.js';
import { ensureRegionSettings } from './ses-region-state.js';

const rotation = process.env.PREVIOUS_BETTER_AUTH_SECRET || process.env.ENCRYPTION_KEY ? loadConfig(process.env) : null;
const config = rotation ?? migrationSettings(process.env);

const client = new Client(postgresConnection(process.env.DATABASE_URL));
await client.connect();
try {
  await client.query("SET lock_timeout='10s'");
  await client.query('SELECT pg_advisory_lock(78291344)');
  await client.query('RESET lock_timeout');
  // Before workspaces existed (migration 038), installations had one internal namespace: never silently
  // strand an older tenant. Once the workspaces table exists, other workspaces are legitimate data.
  const workspacesTable = await client.query("SELECT to_regclass('public.workspaces') AS t, to_regclass('opensend_migrations') IS NOT NULL AND to_regclass('bane_migrations') IS NOT NULL AS ambiguous");
  if (workspacesTable.rows[0].ambiguous) throw new Error('MIGRATION_LEDGER_AMBIGUOUS: both opensend_migrations and bane_migrations exist');
  const scopedTables = workspacesTable.rows[0]?.t ? { rows: [] as { table_name: string }[] }
    : await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'workspace_id'");
  for (const { table_name } of scopedTables.rows) {
    const table = table_name.replaceAll('"', '""');
    const foreign = await client.query(`SELECT 1 FROM public."${table}" WHERE workspace_id <> $1 LIMIT 1`, [config.workspaceId]);
    if (foreign.rowCount) throw new Error('LEGACY_WORKSPACE_MIGRATION_REQUIRED: non-default workspace data requires an explicit migration plan before this upgrade. No data was modified.');
  }
  // Fresh databases have neither table. Older schemas still include environment in the binding.
  if (!rotation && process.env.BETTER_AUTH_SECRET !== undefined) {
    for (const table of ['operation_webhooks','mailbox_webhooks']) {
      if (!(await client.query('SELECT to_regclass($1) AS t',[table])).rows[0].t) continue;
      const sample=(await client.query(`SELECT id,workspace_id,encrypted_secret,coalesce(to_jsonb(w)->>'environment','live') AS env FROM ${table} w LIMIT 1`)).rows[0];
      if (!sample) continue;
      const binding=`${sample.workspace_id}:${sample.env}:${table==='mailbox_webhooks'?'mailbox:':''}${sample.id}`;
      try { await decrypt({config:{encryptionKey:deriveEncryptionKey(process.env.BETTER_AUTH_SECRET)}},sample.encrypted_secret,binding); }
      catch { throw new Error('KEY_ROTATION_REQUIRED: BETTER_AUTH_SECRET differs from the secret that encrypted the stored webhooks. Restore it or configure explicit rotation. No data was modified.'); }
      break;
    }
  }
  // The advisory lock serializes this rename with old and new migrators.
  await client.query(`DO $$ BEGIN
    SET LOCAL lock_timeout='1s';
    IF to_regclass('opensend_migrations') IS NOT NULL THEN
      ALTER TABLE opensend_migrations RENAME TO bane_migrations;
    ELSE
      CREATE TABLE IF NOT EXISTS bane_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
    END IF;
  END $$`);
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(n => /^\d+_[a-z_]+\.sql$/.test(n)).sort()) {
    const source = await readFile(new URL(name, directory), 'utf8');
    const hash = createHash('sha256').update(source).digest('hex');
    const previous = await client.query<{ checksum: string }>('SELECT checksum FROM bane_migrations WHERE name = $1', [name]);
    if (previous.rowCount) {
      if (previous.rows[0]!.checksum !== hash) throw new Error(`MIGRATION_CHANGED: ${name} differs from the applied migration. Add a new migration instead.`);
      continue;
    }
    // Marked files contain one restartable concurrent index build per line. Separate query
    // messages matter: sending all the DDL together creates an implicit transaction in pg.
    if(source.startsWith('-- bane:no-transaction\n')) {
      await client.query("SET lock_timeout='2s'; SET statement_timeout='10min'");
      for(const statement of source.split('\n').map(s=>s.trim()).filter(s=>s && !s.startsWith('--'))) {
        const match=/^CREATE (?:UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS ([a-z_][a-z0-9_]*) ON .+;$/i.exec(statement);
        if(!match)throw new Error(`Invalid online index statement in ${name}`);
        const idx=match[1]!;
        for(let attempt=1;;attempt++) {
          try {
            if((await client.query('SELECT FROM pg_index WHERE indexrelid=to_regclass($1) AND NOT indisvalid',[idx])).rowCount)await client.query(`DROP INDEX CONCURRENTLY "${idx}"`);
            await client.query(statement); break;
          } catch(error) {
            if((error as {code?:string}).code!=='55P03' || attempt>=5) throw error;
            log('warn',{code:'INDEX_LOCK_RETRY',migration:name,index:idx,attempt});
            await new Promise(resolve=>setTimeout(resolve,attempt*250));
          }
        }
      }
      await client.query('INSERT INTO bane_migrations(name,checksum) VALUES ($1,$2)',[name,hash]);
      await client.query('RESET lock_timeout; RESET statement_timeout');
      log('info',{code:'MIGRATION_APPLIED',migration:name});continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(source);
      await client.query('INSERT INTO bane_migrations(name, checksum) VALUES ($1, $2)', [name, hash]);
      await client.query('COMMIT');
      log('info', { code: 'MIGRATION_APPLIED', migration: name });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
  await ensureRegionSettings(drizzle(client), config);
  if (rotation) {
    const rekeyed = await reencryptWebhookSecrets(drizzle(client), rotation);
    if (rekeyed.conflicted) throw new Error('SECRET_REKEY_CONFLICT: concurrent changes occurred; rerun migrate before removing the previous secret.');
    log('info', { code: 'WEBHOOK_SECRETS_REKEYED', ...rekeyed });
  } else log('info', { code: 'WEBHOOK_SECRETS_REKEY_SKIPPED' });
} finally { await client.end(); }
