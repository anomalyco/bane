# Nightmail support (the AI support agent's backend)

A Cloudflare Worker per stage, beside Nightmail in the same account:

| Stage | Worker | URL | Account | Binds |
| --- | --- | --- | --- | --- |
| dev | `bane-support-dev` | `https://support.dev.bane.mx` | anomaly-dev | `bane-dev` |
| production | `bane-support` | `https://support.bane.mx` | anomaly-production | `bane-production` |

Each conversation (a chat from the dashboard's Help panel, or an email thread at the support address) is one `SupportConversation` Durable Object. The agent inside it is **OpenCode**, embedded with `@opencode/sdk/workerd`. The panel talks to it over the WebSocket protocol in [PROTOCOL.md](PROTOCOL.md). How it writes is in [VOICE.md](VOICE.md), and what it knows and may do is in [src/agent/system.md](src/agent/system.md). The design is in the Nightmail plans (`support-agent-design.md`).

## How it fits together

```
dashboard Help ─ POST /v1/contact-support (Nightmail) ─▶ handoff JWS
              ─ POST /chat/start {handoff} ─▶ router ─ BANE.verifyHandoff ─▶ Nightmail SupportPlatform (service binding)
                                                     └ DO.openChat ─ BANE.mintGrant ─▶ grant (private DO table)
              ═ WebSocket /c/<conv>?token= ═▶ DO ─ OpenCode turn ─ tools ─ BANE.read(/v1/support/*, grant)
                                                                └ model ─▶ Console gateway (Opus 5.5, medium)
support@ mail ─ Nightmail route → webhook ritual ─▶ POST /hooks/bane-inbound ─▶ DO inbox + alarm
                                              DO ─ BANE_API (address API key) ─ read message, reply in thread
tickets ─ D1 (typed: billing, bug, deliverability, account, abuse_report, feature_request, other)
        ─ email "[Nightmail <type>] tkt_…" to the team (Nightmail API) + the customer's follow-up thread
        ─ staff list at /staff (Nightmail operator sign-in), mark done
screenshots ─ POST /c/<conv>/attachments (chat) or email image attachments ─ checked + stripped ─ R2 UPLOADS
            ─ shown to the model as images ─ linked from tickets (7-day signed links)
```

- **Nightmail access** is a service binding to Nightmail's `SupportPlatform` entrypoint (`api/src/support-platform.ts`), with no token. It can verify a handoff, verify an email sender, mint and revoke a grant, and run grant-scoped `GET /v1/support/*` reads. The grant is stored only in the DO's private `support_grant` table, and tool closures add it to each read. It never reaches the model, the panel, logs or D1.
- **Email and tickets** go through Nightmail's public API as a normal customer would: an API key limited to the support address (`BANE_SUPPORT_INBOX_KEY`) over the `BANE_API` binding.
- **The model** is pinned to Claude Opus 5.5 at medium effort, through Console's inference gateway (`GATEWAY_URL`, key `CONSOLE_GATEWAY_KEY`). It's pinned in the config, the agent, the session and a provider policy. A fetch guard also refuses any other model or effort. Nothing falls back.

## Why OpenCode, embedded this way

Ryan's decision was to use the OpenCode harness, a custom agent plus custom tools, rather than a hand-rolled loop. `@opencode/sdk` 2.2.7 ships a **workerd profile** (`@opencode/sdk/workerd`) that boots OpenCode's full application graph inside a Durable Object. It keeps its database on the DO's SQLite and stubs out the filesystem, the shell and the pty. Console's own agents run on the same SDK.

So the agent loop, history, streaming, retries and eviction recovery are OpenCode's. We supply only these:

- one `support` agent (system prompt = `system.md` + `VOICE.md`, 25 steps);
- our tools as a Promise plugin (`src/agent/opencode.ts`, `src/agent/tools.ts`), native rather than Code Mode;
- session permissions that deny `*` and allow only our tools. The agent-level list alone leaks the built-in `skill` tool;
- a `fetch` that adds the gateway key and enforces the model pin;
- title, summary and compaction turned off, so there are no extra or smaller-model calls.

The DO talks to OpenCode only through `src/agent/harness.ts` (run a turn, stream events, report usage). **To upgrade**, bump `@opencode/sdk` and `@opencode/plugin` together, run `bun run test`, and check the event names in `opencode.ts` if it fails. The other options were weaker:

- the `packages/llm` / AI SDK route keeps no OpenCode agent or tool model;
- a container would bring a cold start and a sandbox we don't need.

The bundle is 16 MB raw and 2.9 MB gzipped, against a 10 MB limit. In Miniflare a cold boot takes about 0.5 s, and a new conversation in a warm isolate about 12 ms.

## One-time setup (per stage)

Run these from `support/` with the stage's Cloudflare account. Ryan's work profile is `wwrangler`; use `--config wrangler.prod.jsonc` for production.

1. **D1:** run `wrangler d1 create bane-support-dev` (production: `bane-support`), put the id in `wrangler.<stage>.jsonc`, then `bun run migrate:dev` (production: `migrate:production`).
2. **Uploads bucket:** create `bane-support-dev-uploads` (production: `bane-support-uploads`) with a 90-day lifecycle rule, which matches transcript retention: `wrangler r2 bucket create <name>`, then add a rule with `wrangler r2 bucket lifecycle add` that deletes objects after 90 days. The Images binding (`IMAGES`) downscales screenshots over 1.4 MB before the model sees them. It needs no setup beyond Images being enabled on the account.
3. **DNS:** nothing to add by hand. The Worker's Custom Domain (`support.dev.bane.mx` / `support.bane.mx`) creates its record on first deploy, as long as the zone `bane.mx` is in the same account.
4. **The support address** in Nightmail's platform workspace (production `ws_90b0…`, or dev's own), through Nightmail's API with an admin key:
   - create the inbound address `support@bane.mx` (dev: `support@dev.bane.mx`) and put its ID (`mbx_…`) in `SUPPORT_ADDRESS_ID`. Give it the key `support`: routes name an inbox by its address's key;
   - create an API key limited to that address, read and reply (`POST /v1/api-keys` with `access: {"type":"addresses","addressIds":["mbx_…"],"mail":["read","send"]}`): this is `BANE_SUPPORT_INBOX_KEY`;
   - create a webhook (Nightmail format, `include: ["message"]`) to `https://support.bane.mx/hooks/bane-inbound` (dev: `support.dev.bane.mx`). Its `whsec_…` is `BANE_INBOUND_WEBHOOK_SECRET`;
   - add a route for the address to `["inbox:support", "webhook:<that webhook>"]`. Keep the root catch-all at `store`.
5. **The intake addresses** `abuse@`, `privacy@` and `legal@bane.mx` (dev: `@dev.bane.mx`), in the same platform workspace. These go straight to typed tickets and never reach the agent (`src/intake.ts`):
   - create the three inbound addresses, and one API key limited to those three, read and reply. This is `BANE_INTAKE_INBOX_KEY`;
   - create a second webhook (Nightmail format, `include: ["message"]`) to `https://support.bane.mx/hooks/bane-intake`. Its `whsec_…` is `BANE_INTAKE_WEBHOOK_SECRET`;
   - add a route for each address to its own inbox and the shared webhook, such as `abuse@bane.mx` → `["inbox:abuse", "webhook:<that webhook>"]` (an inbox is per address, so there's no single `inbox:intake`). The team reads full messages and non-image attachments in those inboxes;
   - `INTAKE_ADDRESSES` in the wrangler config lists them.
6. **Secrets**, set with `wrangler secret put <NAME> --config wrangler.<stage>.jsonc` and never through CI:
   - `CONSOLE_GATEWAY_KEY`: the Console service key (`models:request`, budgeted). Without it, chat turns refuse with "isn't fully set up" and emails wait in the inbox.
   - `SUPPORT_ROOT_SECRET`: 32+ random bytes as hex (`openssl rand -hex 32`). It's the root for the chat-token and confirm-link keys.
   - `BANE_INBOUND_WEBHOOK_SECRET` and `BANE_SUPPORT_INBOX_KEY`, from step 4.
   - `BANE_INTAKE_WEBHOOK_SECRET` and `BANE_INTAKE_INBOX_KEY`, from step 5.
7. **Deploy.** CI deploys after Nightmail (below) once the repository variable `SUPPORT_DEPLOY` is `true`. By hand: `wrangler deploy --config wrangler.<stage>.jsonc`. Deploy Nightmail first: the binding needs Nightmail's `SupportPlatform` entrypoint.
8. **Point the dashboard at it:** set Nightmail's `BANE_SUPPORT_URL` to `https://support.bane.mx/chat` (dev: `support.dev.bane.mx`).

## Staff ticket page

`https://support.bane.mx/staff` (dev: `support.dev.bane.mx`) lists tickets by type and status. Each ticket shows its details, a bug's reproduction and its screenshots, and can be marked done with a note.

- **Sign-in:** "Sign in with Nightmail" goes to Nightmail's `GET /v1/operator/support/staff-sign-in`. That route needs an operator's dashboard session, then redirects back with a 2-minute signed token.
- **Verification:** this Worker has Nightmail verify the token over the binding (`verifyStaff`), which also confirms the person is still an operator. It uses the token once, then sets an 8-hour, host-only `__Host-` cookie.
- **Writes:** these need the session's CSRF token and a same-origin form post.

## Develop and test

```sh
bun install
bun run check   # types
bun run test    # builds the real bundle, then drives it in Miniflare with a fake Nightmail and a scripted model
```

The tests run the deployed bundle in Miniflare, as Console's agent tests do. `@cloudflare/vitest-pool-workers` can't load the OpenCode SDK. They cover:

- the greeting;
- a tool turn and its projection, and that the grant never reaches the model or the panel;
- a refund ticket and its emails;
- the consent re-mint;
- the output gate;
- the email path, from signature to DMARC to grant to reply;
- failing closed without the gateway key;
- image checks: type by magic bytes, EXIF/XMP/text removed for PNG, JPEG and WebP, damage and oversize refused;
- uploads: chat token, origin, 413, 415 and the 5-image cap. The model receives the stripped bytes;
- a bug ticket: refused without its reproduction, then filed with request IDs from `api_errors`. The `[Nightmail bug]` email carries signed screenshot links, and tampered or expired links are refused;
- the staff page: sign-in, single-use token, a demoted operator, filters, CSRF, origin and session checks on "mark done", and the hourly operator re-check;
- email image attachments.

They make no network or model calls. `test/*.local.ts` scripts, which are git-ignored, are for a few real turns against the gateway with a key read from a file.

## Email: who gets a turn

Each email conversation is bound to the first address that writes in it, and once verified, to that address's Nightmail account.

- **Every later message is checked again.** It must come from that address, pass DMARC, and still map to the same account. Anything else goes to a conversation of its own and never touches the session, its context or its grant: another sender, a DMARC failure, or a changed account.
- **No model turn until a sender is verified.**
  - Without a DMARC pass, the sender gets a fixed reply with a confirm link. Follow-ups from the address wait in the open confirmation, and each later message after a confirmation needs a new one.
  - With a DMARC pass but no account, the sender gets a fixed "no account" reply.
- **Tickets from unverified senders** lead with "UNVERIFIED SENDER" and name no customer.
- **Links in email replies** must point to Nightmail's own sites, or the reply is held.

## Limits and retention

- **Daily caps** (`src/limits.ts`; override each with a `LIMIT_*` var). The budgets are separate, so one can't starve another:
  - model turns: 1,500 a day, and 100 per person;
  - tickets: a 60-a-day reserve for verified customers, 40 a day per intake address for everyone else, and 3 per customer or DMARC-passing sender;
  - mail: 20 a day per DMARC-passing sender, 30 per address for all unauthenticated mail together (a spoofed From can't spread across keys), and 2,000 in total;
  - confirm links: 3 per address a day, at most one an hour per open confirmation. Later mail from the address joins the open confirmation and is answered once it's confirmed.

  Mail over a cap is never dropped. It's kept, bounded, in D1 `overflow`, and the daily cron (00:10 UTC) emails the team one "N messages over cap" digest. The first time a global cap is hit each day, the team gets an alert at once. The same cron runs the retention sweep.
- **Per conversation:** 60 turns, and 500K tokens weighted by cost (cache reads count a tenth). Past either, the conversation files a ticket.
- **Per person:** 10 chats a day.
- **Per email thread:** 5 messages in 10 minutes.
- **Tool steps:** 25 per turn.
- **Retention:** chats close after 24 hours idle, email threads after 7 days. The DO deletes its storage 7 days after closing. D1 keeps the conversation index and tickets.
