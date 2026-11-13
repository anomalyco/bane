# Bane support (the AI support agent's backend)

A Cloudflare Worker per stage, beside Bane in the same account:

| Stage | Worker | URL | Account | Binds |
| --- | --- | --- | --- | --- |
| dev | `bane-support-dev` | `https://support.dev.bane.mx` | anomaly-dev | `bane-dev` |
| production | `bane-support` | `https://support.bane.mx` | anomaly-production | `bane-production` |

Each conversation (a chat from the dashboard's Help panel, or an email thread at the support address) is one `SupportConversation` Durable Object. The agent inside it is **OpenCode**, embedded with `@opencode/sdk/workerd`. The panel talks to it over the WebSocket protocol in [PROTOCOL.md](PROTOCOL.md). How it writes is in [VOICE.md](VOICE.md), and what it knows and may do is in [src/agent/system.md](src/agent/system.md). The design is in the Bane plans (`support-agent-design.md`).

## How it fits together

```
dashboard Help ─ POST /v1/contact-support (Bane) ─▶ handoff JWS
              ─ POST /chat/start {handoff} ─▶ router ─ BANE.verifyHandoff ─▶ Bane SupportPlatform (service binding)
                                                     └ DO.openChat ─ BANE.mintGrant ─▶ grant (private DO table)
              ═ WebSocket /c/<conv>?token= ═▶ DO ─ OpenCode turn ─ tools ─ BANE.read(/v1/support/*, grant)
                                                                └ model ─▶ Console gateway (Opus 5.5, medium)
support@ mail ─ Bane route → webhook ritual ─▶ POST /hooks/bane-inbound ─▶ DO inbox + alarm
                                              DO ─ BANE_API (inbox key) ─ read message, reply in thread
tickets ─ D1 + email to the team from the support address (Bane API) + the customer's follow-up thread
```

- **Bane access** is a service binding to Bane's `SupportPlatform` entrypoint (`api/src/support-platform.ts`), with no token. It can verify a handoff, verify an email sender, mint and revoke a grant, and run grant-scoped `GET /v1/support/*` reads. The grant is stored only in the DO's private `support_grant` table, and tool closures add it to each read. It never reaches the model, the panel, logs or D1.
- **Email and tickets** go through Bane's public API as a normal customer would: the support address's own inbox key (`BANE_SUPPORT_INBOX_KEY`) over the `BANE_API` binding.
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
2. **DNS:** nothing to add by hand. The Worker's Custom Domain (`support.dev.bane.mx` / `support.bane.mx`) creates its record on first deploy, as long as the zone `bane.mx` is in the same account.
3. **The support address** in Bane's platform workspace (production `ws_90b0…`, or dev's own), through Bane's API with an admin key:
   - create the inbound address `support@bane.mx` (dev: `support@dev.bane.mx`) and put its ID (`adr_…`) in `SUPPORT_ADDRESS_ID`;
   - create an inbox key for that address only, with read and send: this is `BANE_SUPPORT_INBOX_KEY`;
   - create a webhook (Bane format, `include: ["message"]`) to `https://support.bane.mx/hooks/bane-inbound` (dev: `support.dev.bane.mx`). Its `whsec_…` is `BANE_INBOUND_WEBHOOK_SECRET`;
   - add a route for the address to `["inbox:support", "webhook:<that webhook>"]`. Keep the root catch-all at `store`.
4. **Secrets**, set with `wrangler secret put <NAME> --config wrangler.<stage>.jsonc` and never through CI:
   - `CONSOLE_GATEWAY_KEY`: the Console service key (`models:request`, budgeted). Without it, chat turns refuse with "isn't fully set up" and emails wait in the inbox.
   - `SUPPORT_ROOT_SECRET`: 32+ random bytes as hex (`openssl rand -hex 32`). It's the root for the chat-token and confirm-link keys.
   - `BANE_INBOUND_WEBHOOK_SECRET` and `BANE_SUPPORT_INBOX_KEY`, from step 3.
5. **Deploy.** CI deploys after Bane (below) once the repository variable `SUPPORT_DEPLOY` is `true`. By hand: `wrangler deploy --config wrangler.<stage>.jsonc`. Deploy Bane first: the binding needs Bane's `SupportPlatform` entrypoint.
6. **Point the dashboard at it:** set Bane's `BANE_SUPPORT_URL` to `https://support.bane.mx/chat` (dev: `support.dev.bane.mx`).

## Develop and test

```sh
bun install
bun run check   # types
bun run test    # builds the real bundle, then drives it in Miniflare with a fake Bane and a scripted model
```

The tests run the deployed bundle in Miniflare, as Console's agent tests do. `@cloudflare/vitest-pool-workers` can't load the OpenCode SDK. They cover:

- the greeting;
- a tool turn and its projection, and that the grant never reaches the model or the panel;
- a refund ticket and its emails;
- the consent re-mint;
- the output gate;
- the email path, from signature to DMARC to grant to reply;
- failing closed without the gateway key.

They make no network or model calls. `test/*.local.ts` scripts, which are git-ignored, are for a few real turns against the gateway with a key read from a file.

## Limits and retention

- **Per conversation:** 60 turns, and 500K tokens weighted by cost (cache reads count a tenth). Past either, the conversation files a ticket.
- **Per person:** 10 chats a day.
- **Per email thread:** 5 messages in 10 minutes.
- **Tool steps:** 25 per turn.
- **Retention:** chats close after 24 hours idle, email threads after 7 days. The DO deletes its storage 7 days after closing. D1 keeps the conversation index and tickets.
