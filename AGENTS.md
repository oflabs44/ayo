# ayo — agent instructions

Ayo is Oladayo's personal assistant server: an OAuth-less, single-user MCP
server on Cloudflare Workers. It is a deliberate, from-scratch rebuild of what
Jerry did, this time built for understanding. The architecture follows the
compact-surface idea (as in Cloudflare Code Mode / Kody): two public MCP tools,
`search` for capability discovery and `execute` for running short ES modules
against those capabilities, instead of one MCP tool per capability.

## Decisions (do not relitigate without asking)

- Single user. No multi-tenancy, no per-user isolation layers, no signup.
  Auth is a simple bearer secret until there is a reason for more.
- Two-tool MCP surface: `search` + `execute`. No static tool catalog.
- One Worker, one repo, no monorepo. Split only when a second deploy unit
  actually exists.
- Package manager: pnpm. Never npm.
- Scaffolded with create-cloudflare (Hello World / Worker only / TypeScript).

## Layout

- `src/index.ts` — Worker entrypoint
- `wrangler.jsonc` — Worker config
- `test/` — Vitest with `@cloudflare/vitest-pool-workers`

## Working style

- Smallest coherent diff; no speculative abstractions or scaffolding.
- Understand and trace before changing; fix root causes.
- Check current Cloudflare docs before using platform APIs; do not assume.
- Run `pnpm test` before committing.

## Roadmap (v1)

1. MCP endpoint at `/mcp` with `search` and `execute`
2. Capability registry as plain typed modules (domain → capabilities)
3. Sandboxed `execute` via Dynamic Workers (Worker Loader) once access exists;
   until then, capabilities callable host-side only
4. Memory capabilities (the Jerry redo) on D1
