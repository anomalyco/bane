// The rule every tear host shares (the access host, tear/access, uses the same marker and data
// check): a tear host rewrites column defaults and changes rows freely, so it runs only on
// - a loopback destination that the connection string cannot redirect: node-postgres lets query
//   parameters (host, port, hostaddr, options, ...) override the URL's authority, so a URL with
//   any query string is refused, and the destination node-postgres actually resolves is checked;
// - a database whoever created it marked disposable with this exact COMMENT ON DATABASE (tear
//   never sets it), because a tunnel or proxy to a real database also listens on loopback;
// - a database holding no workspace or user that tear did not create.
// Hosts check the URL before connecting, and the marker and data before any write and again
// before every fixture.
import { createRequire } from 'node:module';

export const DISPOSABLE = 'bane-tear: disposable test database, every row may be changed or deleted';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
type Parameters = { host?: string; port?: number; database?: string };
const ConnectionParameters = createRequire(import.meta.url)('pg/lib/connection-parameters.js') as new (config: { connectionString: string }) => Parameters;

/** Returns the URL if it names a loopback PostgreSQL database with nothing that could redirect it. */
export function disposableUrl(url: string | undefined, name = 'TEAR_DATABASE_URL'): string {
  if (!url) throw new Error(`tear host: set ${name} to a dedicated, migrated, loopback database marked disposable (see tear/README.md).`);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`tear host: ${name} is not a PostgreSQL URL.`); }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') throw new Error(`tear host: ${name} is not a PostgreSQL URL.`);
  if (parsed.search || url.includes('?')) throw new Error(`tear host: refusing ${name} with query parameters; they can override the host, port or session (use a plain postgresql://user:password@127.0.0.1:port/database).`);
  const bare = (host: unknown) => String(host).replace(/^\[(.*)\]$/, '$1');
  const effective = bare(new ConnectionParameters({ connectionString: url }).host);
  if (!LOOPBACK.has(bare(parsed.hostname)) || !LOOPBACK.has(effective)) throw new Error(`tear host: refusing ${name}: ${effective} is not a loopback address.`);
  return url;
}

type Query = (text: string) => Promise<{ rows: Record<string, unknown>[] }>;
/** Throws unless the connected database carries the marker and holds only tear's own data. */
export async function assertDisposable(query: Query) {
  let row: Record<string, unknown> | undefined;
  try {
    ({ rows: [row] } = await query(`SELECT shobj_description(d.oid, 'pg_database') AS marker, current_database() AS name,
      (SELECT count(*)::int FROM workspaces WHERE id <> 'default' AND id NOT LIKE 'tear\\_%') AS workspaces,
      (SELECT count(*)::int FROM auth_user WHERE id NOT LIKE 'tear-user-%') AS users
      FROM pg_database d WHERE d.datname = current_database()`));
  } catch (error) {
    throw new Error(`tear host: refusing a database that is not a migrated Bane database (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (row?.marker !== DISPOSABLE) throw new Error(`tear host: refusing database ${String(row?.name ?? '(unknown)')}: it is not marked disposable. Create a dedicated, migrated database and mark it with COMMENT ON DATABASE ... IS '${DISPOSABLE}' (see tear/README.md).`);
  if (row.workspaces || row.users) throw new Error(`tear host: refusing database ${String(row.name)}: it holds ${String(row.workspaces)} workspaces and ${String(row.users)} users that tear did not create.`);
}
