import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { ApiError, type App, type Runtime } from './core.js';
import { assertMailKey, r2MailObjects } from './mail-objects.js';
import { sql } from 'drizzle-orm';

const tag = (secret: string, data: string) =>
  createHmac('sha256', hkdfSync('sha256', secret, '', 'bane:mail-object:v1', 32))
    .update(data)
    .digest('base64url');
const missing = () => new ApiError(404, 'MAILBOX_OBJECT_NOT_FOUND', 'This download is unavailable.');
export function mailObjectUrl(runtime: Runtime, w: string, k: string, f: string, t: string,inbox?:string) {
  assertMailKey(w, k);
  const e = Math.floor(Date.now() / 1000) + 300,
    data = Buffer.from(JSON.stringify({ w, k, f, t, e,inbox })).toString('base64url');
  return {
    url: `${runtime.config.publicUrl}/v1/objects/${data}.${tag(runtime.config.authSecret, data)}`,
    expiresAt: new Date(e * 1000).toISOString(),
  };
}
/**
 * Every check on a Bane-signed object link (format, signature, expiry, a live owning inbox, the tenant
 * key) and its download response. The public route passes no workspace: the link is a bearer capability.
 * A server-side read on a caller's behalf passes the caller's workspace, which must own the object.
 */
async function openMailObject(runtime: Runtime, token: string, workspace?: string) {
  if (token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw missing();
  const [data, mac] = token.split('.');
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(tag(runtime.config.authSecret, data)))) throw missing();
  const { w, k, t, f, e,inbox } = JSON.parse(Buffer.from(data, 'base64url').toString());
  if (!Number.isSafeInteger(e) || e <= Date.now() / 1000 || !runtime.mailR2 || (workspace !== undefined && w !== workspace)) throw missing();
  const bound=inbox??(k.startsWith('e/')?k.split('/')[2]:null);
  if(bound&&!(await runtime.db.execute(sql`SELECT FROM mailboxes WHERE workspace_id=${w} AND id=${bound} AND kind='inbox' AND delete_after>statement_timestamp()`)).rowCount)throw missing();
  const body = await r2MailObjects(w, runtime.mailR2.bucket).get(k);
  if (!body) throw missing();
  return new Response(body, {
    headers: {
      'Content-Type': t,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f).replace(/'/g, '%27')}`,
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
/**
 * Reads this installation's own `PUBLIC_URL/v1/objects/<token>` link in process, for server-side code
 * that would otherwise fetch it over HTTP (a Worker cannot fetch its own custom domain). The route's
 * checks apply, and the caller's workspace must own the object. A refused link reads as the route's
 * 404 response. Any other URL returns null.
 */
export async function readOwnMailObject(runtime: Runtime, value: string, workspace: string) {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const token = /^\/v1\/objects\/([^/]+)$/.exec(url.pathname)?.[1];
  if (!token || url.username || url.password || url.origin !== new URL(runtime.config.publicUrl).origin) return null;
  try { return await openMailObject(runtime, token, workspace); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return new Response(null, { status: 404 }); throw error; }
}
export function registerMailObjects(app: App) {
  app.get('/v1/objects/:token', (c) => openMailObject(c.env, c.req.param('token')));
}
