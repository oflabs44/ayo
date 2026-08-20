# ayo — agent instructions

Ayo is Oladayo's personal assistant server: a single-user MCP server on
Cloudflare Workers. It is a deliberate, from-scratch rebuild of what
Jerry did, this time built for understanding. The architecture follows the
compact-surface idea (as in Cloudflare Code Mode / Kody): two public MCP tools,
`search` for capability discovery and `execute` for running short ES modules
against those capabilities, instead of one MCP tool per capability.

## Decisions (do not relitigate without asking)

- Single user. No multi-tenancy, no per-user isolation layers, no signup.
  Auth starts as a static bearer secret (step 1) and moves to OAuth-issued
  tokens (step 2); the bearer check on `/mcp` stays the validation core.
- Two-tool MCP surface: `search` + `execute`. No static tool catalog.
- One Worker, one repo, no monorepo. Split only when a second deploy unit
  actually exists.
- Package manager: pnpm. Never npm.
- Scaffolded with create-cloudflare (Hello World / Worker only / TypeScript).

## Layout

- `src/index.ts` — Worker entrypoint and OAuth provider wiring
- `src/mcp.ts` — MCP server and transport
- `src/oauth/` — Cloudflare Access OIDC login flow
- `wrangler.jsonc` — Worker config
- `test/` — Vitest with `@cloudflare/vitest-pool-workers`

## Bindings and secrets

- `OAUTH_KV` — KV namespace for OAuth clients, grants, and tokens; replace the
  placeholder namespace ID in `wrangler.jsonc` before deployment.
- `ACCESS_OIDC_CLIENT_ID` — Access for SaaS OIDC client ID.
- `ACCESS_OIDC_CLIENT_SECRET` — Access for SaaS OIDC client secret.
- `ACCESS_OIDC_ISSUER` — Access for SaaS OIDC issuer, including the application
  client ID path (for example,
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id>`).
- The Access application callback URL is `https://<ayo-host>/oauth/callback`.

## Working style

- Smallest coherent diff; no speculative abstractions or scaffolding.
- Understand and trace before changing; fix root causes.
- Check current Cloudflare docs before using platform APIs; do not assume.
- Run `pnpm test` before committing.

## Roadmap (v1)

1. MCP endpoint at `/mcp` with `search` and `execute`, bearer-secret auth
2. OAuth via `@cloudflare/workers-oauth-provider`, with Cloudflare Access OIDC
   verifying the single user; grants live in KV and issued tokens replace the
   static secret (required for ChatGPT / claude.ai hosts)
3. Capability registry as plain typed modules (domain → capabilities)
4. Sandboxed `execute` via Dynamic Workers (Worker Loader) once access exists;
   until then, capabilities callable host-side only
5. Memory capabilities (the Jerry redo) on D1
