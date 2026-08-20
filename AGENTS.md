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

- `OAUTH_KV` — KV namespace for OAuth clients, grants, tokens, and the
  `search:capabilities:content-stamp`; replace the placeholder namespace ID in
  `wrangler.jsonc` before deployment.
- `AI` — Workers AI binding for `@cf/baai/bge-small-en-v1.5` embeddings.
- `VECTORIZE` — `ayo-search` Vectorize index. Create it with
  `pnpm exec wrangler vectorize create ayo-search --dimensions=384 --metric=cosine`.
  The model and its 384 dimensions are coupled to this index configuration.
  Capability indexing is upsert-only, so renames leave stale vectors. A clean
  rebuild requires recreating the index and clearing the capability content
  stamp so the next semantic search repopulates it.
- `SEARCH_OFFLINE=true` disables AI and Vectorize search; the development
  script and test harness set it explicitly.
- `LOADER` — Worker Loader binding used by `@cloudflare/codemode` to create a
  fresh Dynamic Worker for each execute call. Dynamic Workers are available in
  open beta on the Workers paid plan.
- `BUREAU` — service binding to the `BureauRpc` entrypoint on the `bureau`
  Worker, used as the production notebook backend.
- `ACCESS_OIDC_CLIENT_ID` — Access for SaaS OIDC client ID.
- `ACCESS_OIDC_CLIENT_SECRET` — Access for SaaS OIDC client secret.
- `ACCESS_OIDC_ISSUER` — Access for SaaS OIDC issuer, including the application
  client ID path (for example,
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id>`).
- The Access application callback URL is `https://<ayo-host>/oauth/callback`.

## Conversation

- `conversationId` is an application-level, honor-system relay: hosts reuse the
  server-issued id across related tool calls; it is not an authentication or
  isolation boundary.
- Conversation suppression is stored in `OAUTH_KV` for
  `SUPPRESSION_TTL_SECONDS` (six hours).

## Notebook

- `NotebookStore` is the storage contract for private notebook pages; capability
  code depends on this interface, not a backend implementation. Contract v2
  retains revisions, supports versioned reads and history, and provides
  segment-aware recursive listing with ordering and limits.
- `src/notebook/links.ts` is the authority for canonical notebook links under
  `https://ayo.oflabs.dev/notebook/`.
- `src/notebook/bureau-store.ts` adapts Bureau's `BureauRpc` notebook methods to
  `NotebookStore`. The test override remains first in backend resolution.

## Capability authoring rule

Search is the foundation: a capability the agent cannot find does not exist.
Every new capability must ship with:

- a `description` written in task language — how a person asks for it
  mid-conversation ("Remember a fact about me"), not what it does internally
  ("Upsert memory record")
- a few `keywords` covering synonyms and task phrasings
- two or three golden queries in the search test suite mapping realistic
  phrasings to the capability

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
5. Notebook-first storage and capabilities, with memory following as the first
   section layered on the notebook

## CI/CD

Workers Builds deploys `main` on every push: build gate `pnpm test`, deploy
`pnpm exec wrangler deploy`. Merging a PR into `main` is a production deploy.
