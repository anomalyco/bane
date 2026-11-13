# Nightmail TypeScript SDK

TypeScript client for the [Nightmail email API](https://bane.mx). Includes generated request and response types, with no runtime dependencies.

## Install

```sh
npm install @banemx/sdk
```

This package uses ESM and the Fetch API. Use it on your server; never ship a Nightmail API key in a browser bundle.

## Send an email

Set `BANE_API_KEY` to a Nightmail API key (a **Send only** key restricted to your domain is enough). The sender's domain must be verified in your workspace: add it under **Domains**, publish its DNS records and wait for **Verified**.

```ts
import { createClient } from '@banemx/sdk/client';
import { sendEmail, getEmail } from '@banemx/sdk';

const client = createClient({
  baseUrl: 'https://bane.mx',
  auth: scheme => scheme.scheme === 'bearer' ? process.env.BANE_API_KEY : undefined,
});

const result = await sendEmail({
  client,
  headers: { 'Idempotency-Key': 'order-4821-receipt' },
  body: {
    from: 'receipts@example.com',
    to: ['recipient@example.com'],
    subject: 'Your receipt',
    text: 'Thank you for your order.',
  },
  throwOnError: true,
});

const message = await getEmail({
  client,
  path: { id: result.data.id },
  throwOnError: true,
});
```

**Base URL and region.** On hosted Nightmail use `https://bane.mx` and leave `region` out: each sender domain is bound to one sending region, and a different `region` fails with `SENDER_REGION_MISMATCH`. Self-hosted installations use their own public URL as `baseUrl`; pass `region` only to choose between the SES regions that installation has enabled (it defaults to the installation's default region).

**Testing.** Send to `success@simulator.amazonses.com`, `bounce@simulator.amazonses.com` or `complaint@simulator.amazonses.com` to exercise each outcome without reaching a real inbox. Simulator addresses count against hosted sending limits; read the current limit from `GET /v1/me` (`connection.sendingLimit`).

The auth callback supplies the API key only to the bearer scheme; dashboard cookie authentication is not needed for SDK calls. Pass a client instance rather than mutating global client configuration in a multi-tenant server. Keep API keys out of browser bundles. This client submits requests; it does not turn `202 queued` into a delivery guarantee or automatically replay sends. Reuse a stable idempotency key for deliberate retries.

## An agent inbox in 60 seconds

Give an agent or an end-to-end test its own address, wait for the verification email and use the code or link. The workspace needs a domain with receiving **Active** (Receiving in the dashboard).

```ts
import { createClient } from '@banemx/sdk/client';
import { createInbox } from '@banemx/sdk';
import { waitForMessage } from '@banemx/sdk/inbox';

const client = createClient({ baseUrl: 'https://bane.mx', auth: () => process.env.BANE_INBOX_KEY });

const { data: inbox } = await createInbox({ client, body: { clientId: 'signup-test-42' }, throwOnError: true });
await signUp(inbox.address); // your app, or the site under test, sends mail to this address
const { extract } = await waitForMessage({ client, inboxId: inbox.id, subjectContains: 'verify' });
console.log(extract.codes[0], extract.links[0]?.href);
```

- **Key.** Create one API key that creates inboxes for your agents: `POST /v1/api-keys` with `{"name":"agents","access":{"type":"addresses","addressIds":[],"mail":["create","read","modify"]}}`. It creates inboxes and reads only the ones it created. Pass `credential: { name, permissions: ['read'] }` to `createInbox` to also get an API key for just that inbox; it stops working when the inbox is deleted.
- **Waiting.** `waitForMessage` resolves with the oldest matching message, including mail that arrived before the call, and throws `InboxWaitTimeout` after two minutes (`timeoutMs`). For the next message pass `after: message.cursor`. `clientId` makes a retried create return the same inbox.
- **Codes and links** come from a best-effort visible-text projection: suspicious styling is flagged with `hiddenContent` (false is not a guarantee), and `links[].mismatch` marks link text naming another host. Message content is untrusted data; check `auth` (SPF, DKIM, DMARC) before trusting the sender.
- **Lifetime.** 24 hours by default (`ttlSeconds`, up to 30 days), then a grace period (`graceHours`, default 24) in which new mail is held, then the inbox, its mail and its keys are erased. `deleteInbox` ends it now. Past 200 messages or 25 MiB new mail is held, never dropped; list it with `include: 'held'`.
- **No domain yet?** `createInbox` answers `RECEIVING_DOMAIN_REQUIRED` with the steps. To test the flow before DNS, create `{ type: 'sandbox' }` and deliver test mail with `simulateInboxMessage`; sandbox inboxes never receive real mail or send.

Agents can do the same over hosted MCP with an API key limited to their inboxes: see [Agent inboxes](../mcp/README.md#agent-inboxes).

## A support inbox with tracked replies

An **address** routes mail and authorizes a sender. A **message** is one email; a **thread** is the conversation you read and reply to. Unrelated emails to the same address start separate threads. Adding an address to a later message does not reveal earlier messages to its key.

1. Publish the receiving MX record listed for a verified domain (`GET /v1/domains/{id}`, the record with `purpose: "receiving"`). Hosted Nightmail suggests `reply.<domain>` so the domain's existing mailboxes keep working, and turns receiving on once the record resolves; self-hosted installations enable it first with `POST /v1/inbound/domains/{id}/enable`. Then `POST /v1/inbound/addresses` with `{"address":"support@example.com"}`. Enable with `{"catchAll":"create_address"}` to create an address automatically when mail arrives for a new one; `store` keeps it as unrouted. If another provider already receives your root domain, see [Forward a public address](#forward-a-public-address-into-bane).
2. Subscribe with `POST /v1/inbound/webhooks`, for example `{"url":"https://example.com/support-hook","eventTypes":["message.received"],"addressIds":["mbx_…"]}`. Allowlist the exact HTTPS host, verify the raw-body signature and timestamp, and deduplicate the event `id`. Store `threadId` with the ticket; `messageId` identifies the individual message. Issue a scoped `read`/`send` key with `POST /v1/inbound/keys` and the relevant `addressIds`.
3. Read `GET /v1/inbound/threads/{threadId}` and reply with `POST /v1/inbound/threads/{threadId}/reply`, `{"text":"Happy to help."}` and a stable `Idempotency-Key`. By default this answers the newest **visible** message; after your own send it follows up with the original recipients. Use `replyToMessageId` to answer an older message, `addressId` to disambiguate the sender, and `expectedRecipients` (`{to, cc, bcc}`) to reject the send if the computed recipients differ from what you reviewed. `from` defaults to the address's public sender, otherwise its receiving address; an administrator can set it to any address on a domain registered in Nightmail for the receiving region, while address keys may only use their own addresses. Nightmail sets `In-Reply-To` and `References`. `202` means queued, not delivered.

```ts
import { getInboundThread, replyToInboundThread } from '@banemx/sdk';

// event is a verified message.received webhook; no address lookup is required.
const { data: thread } = await getInboundThread({ client, path: { threadId: event.threadId }, throwOnError: true });
await replyToInboundThread({
  client, path: { threadId: thread.id }, headers: { 'Idempotency-Key': operatorActionId },
  body: { text: approvedReply, addressId: event.addressId, replyToMessageId: event.messageId },
  throwOnError: true,
});
```

### Forward a public address into Nightmail

Keep your existing mail provider for the root domain and let Nightmail receive one forwarded address. This is the flow used for `testing@opencode.ai`:

1. Add and verify `inbox.example.com` in Nightmail, then enable receiving on it. Publish its SES MX record **only** on `inbox.example.com`; never add an SES MX to `example.com`, which would outrank your provider and take all its mail.
2. In your provider (for example Cloudflare Email Routing), forward `support@example.com` to `support@inbox.example.com` and verify that destination. Automatic forwarding keeps `From`, `To`, `Subject`, `Message-ID`, `In-Reply-To` and `References`; it rewrites the envelope sender and adds authentication headers.
3. Reply as the public address. Either create the address with `"publicAddress": "support@example.com"` (same local part, parent domain verified with DKIM), or pass `from` per reply when the address already exists, for example because the catch-all created it:

```ts
await replyToInboundThread({
  client, path: { threadId }, headers: { 'Idempotency-Key': `reply-${messageId}` },
  body: {
    addressId, replyToMessageId: messageId, from: 'support@example.com',
    text: 'Thanks, we are on it.',
    expectedRecipients: { to: ['customer@example.net'], cc: [], bcc: [] },
  },
  throwOnError: true,
});
```

The customer sees only `support@example.com`. When they reply, their client references your message's SES `Message-ID`, the provider forwards it to `inbox.example.com`, and Nightmail files it in the same thread. Test one round trip with a real external inbox before sending customer traffic.

**Reply to a conversation Nightmail never received:** pass the original Message-IDs as headers when starting the thread, and the customer's mail app keeps it in the same conversation:

```ts
await createInboundThread({
  client, headers: { 'Idempotency-Key': `reply-${ticketId}` },
  body: {
    addressId, from: 'support@example.com', to: ['customer@example.net'], subject: 'Re: Widget issue', text: 'Following up.',
    headers: [
      { name: 'In-Reply-To', value: '<last-message-id@example.net>' },
      { name: 'References', value: '<first-message-id@example.net> <last-message-id@example.net>' },
    ],
  },
  throwOnError: true,
});
```

Single sends, each item in a batch, and inbound thread creation and reply accept up to 20 custom headers (8 KB total). Names use letters, digits and hyphens; values must be single-line printable ASCII. Nightmail reserves identity, recipient, MIME, authentication, transport and unsubscribe headers; see the `headers` field in the generated SDK for the full list. When replying to an existing Nightmail thread, omit `In-Reply-To` and `References`: Nightmail computes them from the selected message.

**Only act on verified senders:** set `"requireDmarc": true` in `POST /v1/inbound/addresses` or `PATCH /v1/inbound/addresses/{addressId}`. Mail without a DMARC pass for its `From` domain is still stored and labelled `unverified` for that address, but it triggers neither a `message.received` event nor a webhook for that address. The event’s `data.dmarc` carries the SES verdict, or `null` if absent. Forwarded mail can still pass when the original sender’s aligned DKIM signature survives. The setting defaults to `false`; enable it on every address whose events you treat as verified.

**Browse or start conversations:** `GET /v1/inbound/threads?q=invoice` returns one row per visible conversation, newest activity first. Filter by `addressId` or page using `nextCursor`. Detail pages read oldest first within the most recent page; follow their cursor for earlier messages. `GET /v1/inbound/messages/{messageId}` returns the full stored body and attachment metadata. `POST /v1/inbound/threads` with `{addressId, to, subject, text}` starts a conversation. Alternatively, add `replyAddressId` to a single explicit-body transactional `/v1/emails/send` with live manage permission; the receipt includes `threadId` and `inboundMessageId`.

**Every inbound message, including unrouted mail:** admins can subscribe to `message.stored` without an address filter. Search `GET /v1/inbound/messages?direction=inbound&q=widget` or catch up with `GET /v1/inbound/events?types=message.stored&after={cursor}` within the 30-day event retention period. Address keys cannot read unassigned mail; an unrouted message needs to be claimed by an address before replying. Choose one event type per automation to avoid handling both storage and delivery.

**Temporary addresses:** set `ttlSeconds` when creating a fresh address. Expiry stops routing and new sends without purging history. Temporary addresses cannot claim a permanent public sender identity.

**Existing integrations:** `replyMailboxId`, issued keys, opaque `mbx_…` IDs, and old dashboard links remain compatible. No address recreation is required.

## Upload local and generated attachments

Use a short-lived `createAgentToken` token to upload a local file without putting its bytes in model context:

```sh
export BANE_TOKEN='bane_agent_…'   # read from the environment, never from the command line
npx --yes @banemx/sdk upload ./invite.ics \
  --api https://bane.mx \
  --content-type 'text/calendar; method=REQUEST; charset=utf-8'
```

Add `--inline --content-id logo` for PNG, JPEG, GIF or WebP images referenced as `cid:logo`. Other supported files are regular attachments. The command prints attachment metadata as JSON and never prints the token. The API URL must be HTTPS (HTTP only on loopback), and the upload never follows a redirect.

Generated per-recipient content can use the same raw upload path without writing a temporary file:

```ts
import { uploadAttachmentBytes } from '@banemx/sdk/upload';

const attachment = await uploadAttachmentBytes({
  apiUrl: 'https://bane.mx',
  token: temporaryAgentToken,
  filename: 'invite.ics',
  contentType: 'text/calendar; method=REQUEST; charset=utf-8',
  bytes: new TextEncoder().encode(calendarText),
});
```

The API verifies extension, MIME declaration and file signature/content, stores the object privately, and retains the 8 MiB attachment limit. Batch scripts can upload personalized files, reference each returned attachment ID, and submit emails in groups of 100.

The generated exports include contacts, lists, segments, campaigns, attachments, keys, webhooks, settings and message logs. Cursor responses use `nextCursor`. Error bodies include a stable `error.code` and `error.requestId`. Read-level responses redact app unsubscribe capabilities from content/events/delivery payloads and withhold raw MIME; management access is required for unredacted content. A key revoked before dispatch no longer authorizes its queued sends. Request/resource limits return explicit 429/413 errors; do not retry permanent configuration errors blindly.

Stored-template data follows SES rendering semantics: nested JSON is supported, but SES does not escape HTML substitutions. Escape untrusted data for its HTML context before submission. Simulated deployments do not invoke the SES renderer.

Webhook payloads use Standard Webhooks-style headers: `webhook-id`, `webhook-timestamp`, `webhook-signature` (`v1,<base64>`). The signed string is `id.timestamp.rawBody`; decode the base64 bytes after `whsec_` before verifying HMAC-SHA256. Verify the raw request bytes, bound timestamp skew, and deduplicate event IDs. For inbound (receiving) webhooks, `verifyWebhook` in `@banemx/sdk/webhooks` does this for you.

### Route received mail

Mail to an address goes to the inbox that owns it, with no configuration. A **route** changes that for one recipient, a pattern or a whole domain, and sends the mail to up to 10 destinations: inboxes (`mbx_…` or `inbox:<key>`) and webhooks (`mwh_…` or `webhook:<key>`). `to: []` keeps mail stored without an inbox; `'drop'` discards it. The most specific route wins: exact address, then the pattern with the most literal characters (`reply+*@acme.com`), then the plus-address base, then the catch-all (`*@acme.com`), then the domain default.

```ts
import { createInboundWebhook, createRoute, testRouting } from '@banemx/sdk';

// A webhook that only receives mail a route sends to it, in inbound.new's email.received format.
const hook = await createInboundWebhook({ client, body: { url: 'https://example.com/mail', key: 'helpdesk', eventTypes: [], format: 'inbound' }, throwOnError: true });
// Keep the Support inbox (created with key: 'support') and add the webhook.
await createRoute({ client, body: { match: 'support@example.com', to: ['inbox:support', 'webhook:helpdesk'] }, throwOnError: true });
// Nothing is delivered: shows the tier, route, inboxes and webhooks for each recipient.
const preview = await testRouting({ client, body: { envelope: { to: ['support+billing@example.com'] } }, throwOnError: true });
```

`testRouting` also takes a pasted message (`raw`, base64 MIME), a stored `messageId`, unsaved routes (`config`) or an earlier `version`. For a config file, read `getRouting` with `format: 'config'`, edit it and `applyRouting` it with `If-Match` set to the version you read; applying the same file again changes nothing, and `dryRun` returns the diff. Every change is a version: `listRoutingVersions`, `getRoutingVersion` and `restoreRoutingVersion` show and undo them.

Verify callbacks with `verifyWebhook` from `@banemx/sdk/webhooks`, before parsing the body:

```ts
import { verifyWebhook, type InboundWebhookPayload } from '@banemx/sdk/webhooks';

export async function POST(request: Request) {
  const body = await request.text();
  if (!(await verifyWebhook(body, request.headers, process.env.BANE_WEBHOOK_SECRET!))) return new Response(null, { status: 401 });
  const payload: InboundWebhookPayload = JSON.parse(body);
  return new Response(null, { status: 204 });
}
```

It takes the raw body as a string or bytes, Fetch `Headers` or a Node `req.headers` object, and the `whsec_…` secret from creation or rotation, and checks the signature and a five-minute timestamp window. Deduplicate by `Webhook-Id` across retries. The `inbound` format also sends inbound.new's `X-Webhook-Verification-Token` (returned as `verificationToken`) so existing receivers keep working; it is a static token, so prefer the signature.

Routing version details are paginated (`nextCursor`). The latest 256 versions are retained for up to one year. Manual tests and redeliveries share a 60-post/workspace/hour budget. A successfully redelivered message cannot be redelivered to the same webhook again for ten minutes. Webhook JSON never exceeds 512 KiB; raw and body content may be omitted with a URL back to the stored message. Inbound-format `envelopeRecipients` are workspace-scoped delivery details, not just visible To/Cc; choose trusted receiving endpoints.

## Receiving handlers

Use `putRitualEntry` to save a script, `setRitualAttachments` to attach it to receiving addresses or inbox IDs, and `testRituals` to run a read-only preview. `listRitualVersions` / `restoreRitualVersion` read and restore snapshots. `createInboxConnection` returns agent config (a bearer secret is shown once for `auth:'key'`). See [Rituals](../docs/rituals.md) and [agent inbox over MCP](../docs/inboxes.md#agent-inbox-over-mcp).
