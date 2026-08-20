# ayo — agent instructions

Ayo is Oladayo's personal assistant server: a single-user MCP server on
Cloudflare Workers. It is a deliberate, from-scratch rebuild of what
Jerry did, this time built for understanding. The architecture follows the
compact-surface idea (as in Cloudflare Code Mode / Kody): two public MCP tools,
`search` for capability discovery and `execute` for running short ES modules
against those capabilities, instead of one MCP tool per capability.

## Decisions (do not relitigate without asking)

- Single user. No multi-tenancy, no per-user isolation layers, no signup.
  Auth is OAuth: Ayo is the OAuth server to MCP hosts (dynamic registration,
  consent gate) and an OAuth client of a Cloudflare Access OIDC app for the
  login itself.
- Two-tool MCP surface: `search` + `execute`. No static tool catalog.
- One Worker, one repo, no monorepo. Split only when a second deploy unit
  actually exists.
- Package manager: pnpm. Never npm.
- Scaffolded with create-cloudflare (Hello World / Worker only / TypeScript).
- The notebook backend is Bureau (service binding); capability code only ever
  sees the `NotebookStore` interface. Canonical links are Ayo-owned.

## Layout

- `src/index.ts` — Worker entrypoint and OAuth provider wiring
- `src/mcp.ts` — MCP server, transport, conversationId/memoryContext relay
- `src/oauth/` — Cloudflare Access OIDC login flow, consent gate, and the
  `/notebook/*` canonical-link redirect
- `src/capabilities/` — the registry: one file per domain (`meta`, `notebook`,
  `memory`), keyed and flattened in `index.ts`
- `src/search.ts` — search modes, lexical scoring, embeddings, RRF fusion
- `src/execute.ts` — codemode sandbox and the `ayo.*` dispatch table
- `src/notebook/` — `NotebookStore` contract, in-memory reference store,
  Bureau RPC adapter, link authority
- `src/memory/` — memory index (self-healing embeddings), recall, ambient
  surfacing
- `src/conversation.ts` — conversationId minting and KV suppression
- `wrangler.jsonc` — Worker config
- `test/` — Vitest with `@cloudflare/vitest-pool-workers`; golden queries and
  the interface-driven store suite live here

## Bindings and secrets

- `OAUTH_KV` — KV namespace for OAuth clients, grants, tokens, and the
  `search:capabilities:content-stamp`; replace the placeholder namespace ID in
  `wrangler.jsonc` before deployment.
- `AI` — Workers AI binding for `@cf/baai/bge-small-en-v1.5` embeddings.
- `VECTORIZE` — `ayo-search` Vectorize index (namespaces: `capabilities` for
  search, `memories` for memory recall). Create it with
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
  `SUPPRESSION_TTL_SECONDS` (six hours). Ambient memory surfacing is its first
  consumer: returned memory paths are suppressed for the rest of the
  conversation.

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

## Memory

- Memories are notebook pages under `memory/`; the filing charter is a
  notebook page itself (`memory/readme`) — edit it there, not in code.
- `memory_remember` is verify-first: similar existing memories block the write
  and are returned for update-or-force; wording steers merge-over-force.
- Similarity thresholds in `src/memory/index.ts` are calibration knobs
  (separate duplicate and relevance bars); tune from real use, and never
  compare the RRF fusion score against a threshold.

## Status

v1 is complete and deployed: OAuth, two-signal search, the execute sandbox,
notebook capabilities on the Bureau backend, memory with ambient
memoryContext surfacing, and canonical links. Known backlog: similarity
calibration from real use, Bureau reader polish, a scheduled brief-of-the-day
routine (needs a scheduler and a notify channel), and the 2026-07-28 MCP
envelope once hosts speak it.

## CI/CD

Workers Builds deploys `main` on every push: build gate `pnpm test`, deploy
`pnpm exec wrangler deploy`. Merging a PR into `main` is a production deploy.
