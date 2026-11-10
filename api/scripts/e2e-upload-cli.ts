// Exercise the shipped bin, including argument parsing and file IO. The disposable key
// enters the isolated child via env, not the shell/OS command line or an execFile error.
import { assertResponse } from './e2e-contract.js';
const [file, origin] = process.argv.slice(2);
const send = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) !== `${origin}/v1/attachments/upload`) throw new Error('Unexpected CLI upload URL');
  const res = await send(url,{...init,redirect:'error',signal:AbortSignal.timeout(12000)});
  const id = res.headers.get('x-request-id');
  if (id?.match(/^req_[a-zA-Z0-9_-]+$/)) process.stderr.write(`requestId=${id}\n`);
  // Binary upload is not an OpenAPI operation, but returns the same Attachment/ApiError as JSON upload.
  assertResponse('uploadAttachment',res.status,res.headers.get('content-type'),await res.clone().json());
  return res;
};
process.env.BANE_TOKEN = process.env.CLI_TEMP_KEY!;
process.argv = ['node','bane','upload',file!, '--api',origin!,'--content-type','text/plain'];
const bin = new URL('../../sdk/dist/cli.js',import.meta.url);
await import(bin.href);
