import {mimeIndex} from './mailbox-mime-index.js';
import { sql } from 'drizzle-orm';
import { ApiError, id, type Runtime } from './core.js';
import { mailKey, sandboxMailStore } from './mail-objects.js';
import { storeIncoming } from './mailbox-ingest-store.js';

// Only literal, validated fields cross this boundary. There is no SMTP, DNS, SES or URL fetch.
export async function simulateInbox(
  runtime: Runtime,
  wid: string,
  bid: string,
  input: { from: string; subject: string; text: string; html?: string },
) {
  const result = await runtime.db.execute<{
    address: string;
    ok: boolean;
  }>(sql`WITH target AS MATERIALIZED (SELECT b.address,s.inbox_id FROM mailboxes b JOIN inbox_state s ON s.inbox_id=b.id WHERE b.workspace_id=${wid} AND b.id=${bid} AND b.create_request->>'type'='sandbox' AND b.delete_after>now() AND s.simulated_count<50 FOR UPDATE OF s),
    debit AS (INSERT INTO api_request_budgets AS b(workspace_id,key_id,window_start,used) SELECT ${wid},'inbox-simulate:'||${wid}::text,date_trunc('day',now()),1 FROM target ON CONFLICT(workspace_id,key_id) DO UPDATE SET used=CASE WHEN b.window_start=excluded.window_start THEN b.used+1 ELSE 1 END,window_start=excluded.window_start WHERE b.window_start<>excluded.window_start OR b.used<1000 RETURNING 1),
    reserved AS (UPDATE inbox_state SET simulated_count=simulated_count+1 FROM debit WHERE inbox_id IN(SELECT inbox_id FROM target) RETURNING 1)
    SELECT address,EXISTS(SELECT FROM reserved) ok FROM mailboxes WHERE workspace_id=${wid} AND id=${bid} AND create_request->>'type'='sandbox' AND delete_after>now()`);
  const box = result.rows[0];
  if (!box) throw new ApiError(404, 'SANDBOX_NOT_FOUND', 'This operation requires a sandbox inbox.');
  if (!box.ok)
    throw new ApiError(
      429,
      'SIMULATION_LIMIT',
      'Limit: 50 simulated messages per inbox and 1,000 per workspace per UTC day.',
    );
  const mid = id('msg'),
    key = mailKey(wid, 'ephemeral', bid, mid),
    boundary = `bane_${crypto.randomUUID()}`;
  const b64 = (s: string) =>
    Buffer.from(s)
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? '';
  const part = (type: string, s: string) =>
    `Content-Type: text/${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(s)}`;
  const subject = Buffer.from(input.subject).toString('base64');
  const wire = Buffer.from(
    `From: ${input.from}\r\nTo: ${box.address}\r\nSubject: =?UTF-8?B?${subject}?=\r\nMIME-Version: 1.0\r\n${input.html ? `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${part('plain', input.text)}\r\n--${boundary}\r\n${part('html', input.html)}\r\n--${boundary}--` : part('plain', input.text)}\r\n`,
  );
  // A workspace need not own a receiving bucket: on Node this is the private object storage.
  const { bucket, objects } = sandboxMailStore(runtime, wid);
  await objects.put(key, wire, 'message/rfc822');
  await storeIncoming(
    runtime.db,
    {
      id: mid,
      workspaceId: wid,
      direction: 'inbound',
      region: 'sandbox',
      sesMessageId: mid,
      envelopeTo: [box.address],
      lifecycle: 'ephemeral',
      receivedAt: new Date().toISOString(),
      subject: input.subject,
      fromAddress: input.from.toLowerCase(),
      to: [{ name: null, address: box.address }],
      cc: [],
      bcc: [],
      replyTo: [],
      references: [],
      text: input.text,
      html: input.html ?? null,
      snippet: input.text.slice(0, 240),
      bodyTruncated: false,
      mime:mimeIndex(wire), headers: [],
      attachmentCount: 0,
      sizeBytes: wire.length,
      rawBucket: bucket,
      rawKey: key,
      verdicts: { simulated: true, spf: 'NONE', dkim: 'NONE', dmarc: 'NONE' },
      spam: false,
      automated: false,
      status: 'received',
    },
    [],
    false,
    false,
  );
  return { messageId: mid, simulated: true as const };
}
