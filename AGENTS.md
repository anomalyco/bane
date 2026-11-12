# Bane

Self-hosted transactional and marketing email on Amazon SES. Read `README.md` for the starting points and `api/README.md` for setup, deployment, and operational details.

## Ownership

This codebase is yours: what it's for and how it's built are your call, and you'll keep building on it. You are the primary builder of Bane, not a guest in it. When you touch an area, leave it better: merge duplicated code, fix the related bugs you find instead of only mentioning them, and simplify structure that no longer fits. Keep the conventions below and the public API contract stable; record decisions that change direction in the commit message.

## Repository map

- `app/` — React/Vite dashboard. `app/index.html` loads `src/main.tsx`; `src/App.tsx` defines routes. Screens live in `src/features/`, shared UI in `src/components/`, API adapters in `src/data/`, and design tokens/styles in `src/styles/`.
- `api/` — Hono API with Zod/OpenAPI schemas. `src/app.ts` assembles routes; `src/server.ts` runs on Node and `src/worker.ts` runs on Cloudflare. `src/runner.ts` runs the Node job worker. PostgreSQL schemas are in `src/db/`, migrations in `migrations/`, and platform/database/storage adapters in `src/adapters/`.
- `sdk/` — Generated TypeScript client, published on npm as `@banemx/sdk`. Usage is in `sdk/README.md`.
- `mcp/` — MCP integration and client connection documentation. See `mcp/README.md`.
- `docs/` — Public demo screenshots, SES research, and `dispatch-scaling.md` (measured throughput ceilings, dispatcher design rationale, and the scaling playbook by SES quota). Prefer `api/README.md` over older research notes for current setup instructions.

The dashboard builds to `app/dist/`. Cloudflare serves that directory; Docker copies it into the API image's `public/` directory. There is no root HTML entry point or root package.json: each package installs its own dependencies with `bun install`.

## Common commands

Run commands from the directory shown; install that package's dependencies first.

| Directory | Command | Purpose |
| --- | --- | --- |
| `app/` | `bun run dev` | Dashboard development server |
| `app/` | `bun run build` | Type-check and build the dashboard |
| `api/` | `bun run dev` / `bun run worker` | Node API / background job worker |
| `api/` | `bun run check` / `bun run sdk` | Type-check API / regenerate OpenAPI and SDK |
| `mcp/` | `bun run check` / `bun run build` | Type-check / compile the MCP adapter |

Docker, Cloudflare, and local development have separate setup instructions in `api/README.md`; do not mix their URLs or configuration.

## Working conventions

- Keep business behavior in the public API. The dashboard, SDK, and MCP use that contract rather than implementing separate sending logic.
- Install and run scripts with bun (`bun install`, `bun run <script>`). Bun only runs dependency install scripts for packages listed in that package's `trustedDependencies`; add a dependency there, with the reason, before relying on its postinstall.
- Do not hand-edit `api/openapi.json` or generated `sdk/src/` files. Change the API schemas, then regenerate from `api/` with `bun run sdk`.
- Reuse shared dashboard components and tokens. Preserve OpenTUI Mono, the shared 53px table-row sizing, and concise, installation-neutral copy.
- CLS gate: `bun run cls` in `app/` builds the dashboard and measures layout shift on every main page (light and dark, cold load and in-app navigation, slow out-of-order API responses) against a throwaway API with synthetic data (Docker or `CLS_PG_URL` for Postgres); CI's `cls` job fails above CLS 0.001, so add new pages to `app/scripts/cls.mjs` and fix a shift by reserving the loaded layout's space, never by raising the limit.
- Keep tests in `api/api.acceptance.test.ts`; do not add separate test files. Run acceptance tests only with an isolated synthetic database/configuration, never production credentials or data.
- After deploying a hosted MCP catalog change, refresh OpenCode with `opencode2 api post /api/mcp/bane/disconnect` followed by `opencode2 api post /api/mcp/bane/connect`.
- Use the operator's own deployment resources. Keep credentials, private configuration, database dumps, and real mail out of Git. Ask before provisioning infrastructure, deploying, migrating a live database, or sending real email.
