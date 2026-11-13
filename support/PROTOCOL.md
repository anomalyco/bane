# Support chat protocol (v1)

The contract between the dashboard's Help panel and the support Worker (`support.bane.mx`, dev `support.dev.bane.mx`). The panel never talks to the model or to Bane's support routes: it talks to one conversation over one WebSocket, and the Worker does the rest.

Everything here is JSON. Unknown fields must be ignored and unknown `type`s skipped, so the server can add fields and message types without breaking an older panel. A breaking change bumps `v`.

| Stage | Support origin | Dashboard origin allowed |
| --- | --- | --- |
| production | `https://support.bane.mx` | `https://bane.mx` |
| dev | `https://support.dev.bane.mx` | `https://dev.bane.mx` (and `http://localhost:5173` when the Worker runs locally) |

## 1. Opening a conversation

```
panel ── POST /v1/contact-support (dashboard session) ──▶ bane.mx           → { token }        (handoff JWS, 10 min)
panel ── POST /chat/start { handoff } ─────────────────▶ support.bane.mx   → { conversationId, chatToken, socketUrl, expiresAt }
panel ══ WebSocket socketUrl ══════════════════════════▶ support.bane.mx   (this protocol)
```

1. **Handoff.** `POST https://bane.mx/v1/contact-support` with the signed-in session (any role), as today: `{ kind: "support", page, requestIds, shareContent }`. Leave `message` empty: the agent always speaks first (§3). Read `token` from the response (the support URL's `#handoff=` fragment carries the same value).
2. **Start.** `POST {support}/chat/start`, `content-type: application/json`, body `{ "handoff": "<token>" }`. CORS allows the dashboard origin only; no cookies.

   | Status | Body | Meaning |
   | --- | --- | --- |
   | `200` | `{ conversationId, chatToken, socketUrl, expiresAt }` | `socketUrl` already carries the token. `expiresAt` is ISO 8601 (12 hours). |
   | `400` | `{ error: { code: "INVALID_REQUEST" } }` | No handoff in the body |
   | `401` | `{ error: { code: "HANDOFF_INVALID" } }` | Bad signature, wrong audience or expired: get a fresh handoff and retry once |
   | `409` | `{ error: { code: "HANDOFF_USED" } }` | This handoff already opened a conversation: get a fresh one |
   | `429` | `{ error: { code: "RATE_LIMITED", retryAfter } }` | Too many conversations today (10 per person) |

3. **Connect.** `new WebSocket(socketUrl)`, i.e. `wss://support.bane.mx/c/<conversationId>?token=<chatToken>`. The Worker checks the token (bound to this conversation and this person) and the `Origin`. A refused upgrade is a plain `401`/`403`/`404` with no body; get a fresh handoff and call `/chat/resume`.

Keep `conversationId`, `socketUrl` and `expiresAt` in `sessionStorage` so a reload reconnects to the same conversation. Switching workspace in the dashboard starts a new conversation (the handoff's workspace is the conversation's scope).

## 2. Resuming, renewing and granting content access

`POST {support}/chat/resume` with `{ "conversationId", "handoff" }` returns the same shape as `/chat/start`. Use it when:

- the chat token expired (connect refused, or `expiresAt` passed);
- the server sent `{ type: "error", code: "GRANT_EXPIRED" }` (account access ends after two hours; a fresh handoff renews it);
- the person pressed **Allow** on a consent card (§4.3): get the handoff with `shareContent: true`;
- the person opened the dashboard from a support email's "continue in Bane" link: `https://bane.mx/?support=<conversationId>&share=1`. Open the panel, tick the share box, call `contact-support` then `/chat/resume`. Email conversations can be viewed this way; replies still go by email.

The handoff's user must be the conversation's user (`403 { error: { code: "NOT_YOUR_CONVERSATION" } }` otherwise). `404 { error: { code: "CONVERSATION_NOT_FOUND" } }` means it expired: start a new one.

## 3. Message flow at a glance

```
server → hello                      (always first, on every connect)
server → history                    (on reconnect; empty on a new conversation)
server → message.start  kind=first  (new conversation only: the agent's greeting)
server → text.delta …
server → message.end
client → user.message
server → message.start  kind=reply
server → tool.start / tool.end …    (zero or more, interleaved with text)
server → text.delta …
server → consent.request            (optional)
server → ticket.filed               (optional)
server → message.end
```

Every server message has `v: 1`, a `type` and a `seq`: a per-conversation counter that only increases. After a reconnect, `history` replaces what the panel shows and the stream continues from there.

## 4. Server → panel

### 4.1 Session

```jsonc
{ "v": 1, "type": "hello", "seq": 0,
  "conversationId": "conv_7m2k…",
  "channel": "chat",                               // or "email" (view only: §2)
  "status": "open",                                // "open" | "ticketed" | "closed"
  "agent": { "name": "Bane support", "ai": true }, // show "AI support agent" in the header
  "customer": { "firstName": "Ada" },
  "workspace": { "id": "ws_…", "name": "Acme Prod" },
  "contentAccess": false,                          // true once the person allowed content (§4.3)
  "busy": false }                                  // true while a turn is running (a reconnect mid-answer)

{ "v": 1, "type": "history", "seq": 1,
  "messages": [
    { "id": "msg_…", "role": "assistant", "kind": "first", "text": "Hi Ada, …", "at": "2026-11-12T10:00:00Z" },
    { "id": "msg_…", "role": "user", "text": "Why did …", "at": "…" },
    { "id": "msg_…", "role": "assistant", "kind": "reply", "text": "…", "at": "…",
      "tools": [{ "id": "call_…", "label": "Checked your Gmail bounces", "ok": true }] }
  ],
  "pending": { "consent": null, "ticket": null } } // re-show an open consent card or a filed ticket

{ "v": 1, "type": "status", "seq": 9, "busy": true }   // a turn started (false when it ended)
```

### 4.2 Streaming an answer

```jsonc
{ "v": 1, "type": "message.start", "seq": 2, "messageId": "msg_…", "kind": "first" }  // "first" | "reply" | "notice"
{ "v": 1, "type": "text.delta",    "seq": 3, "messageId": "msg_…", "delta": "Hi Ada, I see you sent " }
{ "v": 1, "type": "message.end",   "seq": 8, "messageId": "msg_…",
  "text": "Hi Ada, I see you sent …",  // the final text: replace the streamed text with this
  "redacted": false }                  // true when the output gate replaced it (§6)
```

- `kind: "first"` is the greeting the agent writes when the conversation opens, from the person's account (name, recent campaigns and sends, standing, open issues). The panel shows a typing state until it starts; it never sends a canned greeting of its own.
- `kind: "notice"` is a short line from the harness, not the model (for example "Account access renewed"). Render it smaller.
- Text is **Markdown, restricted**: paragraphs, `**bold**`, `` `code` ``, fenced code, numbered and bulleted lists, links. Render links only to `https://bane.mx`, `https://dev.bane.mx`, `https://support.bane.mx`, `https://support.dev.bane.mx` and `https://github.com/anomalyco/bane`; show any other URL as plain text. Never render images or raw HTML.
- Always use `message.end.text` as the stored text. When `redacted` is true, it is a replacement such as "I've sent this to the team to check".

### 4.3 Tool activity, consent and tickets

```jsonc
{ "v": 1, "type": "tool.start", "seq": 4, "messageId": "msg_…", "toolCallId": "call_…",
  "tool": "bounce_reasons", "label": "Checking your Gmail bounces…" }
{ "v": 1, "type": "tool.end", "seq": 5, "toolCallId": "call_…",
  "ok": true, "label": "Checked your Gmail bounces" }   // ok:false → "Couldn't check …"; keep going
```

Show `label` as a quiet progress line under the message. Labels are already written for people; `tool` is for tests and analytics only. The panel never sees tool arguments or results.

```jsonc
{ "v": 1, "type": "consent.request", "seq": 6, "requestId": "cns_…",
  "workspace": { "id": "ws_…", "name": "Acme Prod" },
  "why": "To check why the screen rejected your Nov 3 promo, I need to read its HTML." }
{ "v": 1, "type": "consent.resolved", "seq": 7, "requestId": "cns_…", "decision": "allow" }  // or "deny"
```

Render a card: "Let Bane support read the content of your emails in **Acme Prod** for this conversation." with the `why` and two buttons, **Allow** and **Not now**.

- **Allow:** call `POST /v1/contact-support` with `shareContent: true` (the dashboard must be on the card's workspace), then send `consent.respond` with the handoff (§5). If the call fails, send `decision: "deny"`.
- **Not now:** send `consent.respond` with `decision: "deny"`.

The agent finishes its current answer by saying it has asked, and continues on its own once the person decides: after `consent.resolved` a new `message.start` follows. A card whose request was resolved elsewhere (another tab) closes.

```jsonc
{ "v": 1, "type": "ticket.filed", "seq": 10, "ticketId": "tkt_…",
  "ticketType": "billing",         // billing | bug | deliverability | account | abuse_report | feature_request | other
  "category": "refund",            // the topic within the type when there is one, else the type (kept for v1 panels)
  "replyTo": "a…@acme.com",        // masked: where the team will reply
  "expect": "usually within one business day" }
```

Show a small card: "Passed to the Bane team as **tkt_…**. Someone will reply by email to a…@acme.com, usually within one business day." After a ticket the conversation stays open: the person can keep asking, and the agent keeps answering what it can.

### 4.4 Errors and the end

```jsonc
{ "v": 1, "type": "error", "seq": 11, "code": "GRANT_EXPIRED", "message": "…", "retryable": true }
{ "v": 1, "type": "closed", "seq": 12, "reason": "idle" }   // "idle" | "limit" | "ended"
```

| `code` | What the panel does |
| --- | --- |
| `GRANT_EXPIRED` | Get a fresh handoff, call `/chat/resume`, reconnect. The agent continues. |
| `RATE_LIMITED` | Show the message; the input stays disabled until `retryAfter` (seconds) passes. |
| `TURN_FAILED` | Show the message with a **Try again** button that resends the last `user.message` with the same `clientMessageId`. |
| `BAD_MESSAGE` | A bug in the panel: log it. |
| `BUDGET_EXHAUSTED` | The conversation reached its limit; a ticket follows. Disable the input. |

`closed` means the conversation ended (24 hours idle, the turn limit, or the person ended it). Disable the input and offer "Start a new conversation".

## 5. Panel → server

```jsonc
{ "type": "user.message", "clientMessageId": "c_…", "text": "Why are Gmail opens down?" }  // ≤ 8,000 characters
{ "type": "user.message", "clientMessageId": "c_…", "text": "This is what I see", "attachments": ["att_…"] }  // uploaded first (§5.1); text may be empty
{ "type": "consent.respond", "requestId": "cns_…", "decision": "allow", "handoff": "<JWS with shareContent>" }
{ "type": "consent.respond", "requestId": "cns_…", "decision": "deny" }
{ "type": "human.request" }                     // "Talk to a person": files a ticket (once per conversation)
{ "type": "cancel" }                            // stop the answer being written
{ "type": "feedback", "rating": "up" }          // or "down"; optional, once per conversation
{ "type": "end" }                               // the person closed the conversation
{ "type": "ping" }                              // server answers { "type": "pong" }; send every 30 s while open
```

- `clientMessageId` makes resends safe: the server ignores a `user.message` it has already accepted.
- `attachments` are IDs from §5.1 that no earlier message used; an unknown or reused ID gets `BAD_MESSAGE`.
- Messages sent while a turn is running are queued and answered in order.
- The server answers `pong` to `ping`, and closes the socket with `1000` when the conversation ends. If the socket drops, reconnect with the same `socketUrl` until `expiresAt`, then renew through `/chat/resume`.

### 5.1 Screenshots

The person can attach images: PNG, JPEG or WebP, up to 5 MB each and 5 per conversation. They're uploaded over HTTP, not the socket: socket frames stay small (16 KB), and a plain request gets a size limit, a status code and its own retry.

```
POST {support}/c/<conversationId>/attachments
Authorization: Bearer <chatToken>
Content-Type: image/png | image/jpeg | image/webp
X-Filename: <URI-encoded file name, optional>
<the raw image bytes>
```

| Status | Body | Meaning |
| --- | --- | --- |
| `201` | `{ attachment: { id: "att_…", type, size, width, height, name } }` | Stored. Send its `id` in the next `user.message.attachments`. |
| `401` | `{ error: { code: "CHAT_TOKEN_INVALID" } }` | Renew through `/chat/resume` |
| `409` | `{ error: { code: "TOO_MANY_ATTACHMENTS" \| "CONVERSATION_CLOSED" } }` | 5 already, or the conversation ended |
| `413` | `{ error: { code: "ATTACHMENT_TOO_LARGE" } }` | Over 5 MB |
| `415` | `{ error: { code: "UNSUPPORTED_TYPE" } }` | Not PNG, JPEG or WebP. The bytes decide, not the header or the name. |
| `422` | `{ error: { code: "INVALID_IMAGE" } }` | A damaged file, or more than 8,000 pixels on a side |

- **What the server does:** it checks the type from the file's own bytes, and removes metadata (EXIF, XMP, text chunks, comments) before storing. The panel never gets the image back from the server, so show your own local preview.
- **In `history`:** user messages carry `attachments: [{ id, type, width, height, name }]`. After a reload, show a placeholder such as "Screenshot · name".
- **What the agent does:** it sees the images with the message and treats their content as untrusted. They attach to any ticket.
- **Email:** image attachments on support emails are handled the same way.

## 6. What the panel can rely on

- It never receives grant tokens, tool arguments, raw tool results, internal IDs other than the ones above, or other customers' data.
- The final text of every assistant message has passed the output gate. Streamed deltas are shown as they arrive; if the gate trips, `message.end` replaces the text with `redacted: true`.
- One conversation, one person: a chat token for one conversation is refused on another.

## 7. Testing without a model

`support/test/fakes.ts` has the scripted model and the fake Bane the Worker's tests use. The model script decides its next move from the request: the greeting, a reply with a tool step (`bounce_reasons`), a consent card ("look at the content"), a ticket ("refund") and a gated answer ("leak please"). `bun run test` in `support/` drives the real bundle through these, so the frame sequences in §3 are exactly what the tests assert.
