import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { ApiError, type App, type Runtime } from './core.js';
import { assertMailKey, r2MailObjects } from './mail-objects.js';

const tag = (secret:string, data:string) => createHmac('sha256',hkdfSync('sha256',secret,'','bane:mail-object:v1',32)).update(data).digest('base64url');
const missing = () => new ApiError(404,'MAILBOX_OBJECT_NOT_FOUND','This download is unavailable.');
export function mailObjectUrl(runtime:Runtime,w:string,k:string,f:string,t:string) {
  assertMailKey(w,k);
  const e=Math.floor(Date.now()/1000)+300, data=Buffer.from(JSON.stringify({w,k,f,t,e})).toString('base64url');
  return {url:`${runtime.config.publicUrl}/v1/objects/${data}.${tag(runtime.config.authSecret,data)}`,expiresAt:new Date(e*1000).toISOString()};
}
export function registerMailObjects(app:App) {
  app.get('/v1/objects/:token',async c=>{
    const token=c.req.param('token');
    if(token.length>8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw missing();
    const [data,mac]=token.split('.');
    if(!timingSafeEqual(Buffer.from(mac),Buffer.from(tag(c.env.config.authSecret,data))))throw missing();
    const {w,k,t,f,e}=JSON.parse(Buffer.from(data,'base64url').toString());
    if(!Number.isSafeInteger(e) || e<=Date.now()/1000 || !c.env.mailR2) throw missing();
    const body=await r2MailObjects(w,c.env.mailR2.bucket).get(k); if(!body)throw missing();
    return new Response(body,{headers:{'Content-Type':t,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(f).replace(/'/g,'%27')}`,'Content-Security-Policy':"sandbox; default-src 'none'",'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
  });
}
