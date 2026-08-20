# ayo

Ayo (Yoruba: "joy") is my personal assistant's home — a single-user MCP server
on Cloudflare Workers.

## The idea

Every AI host I use (Claude, ChatGPT, editors) should talk to the same
assistant: my memories, my capabilities, my automations — owned by me, portable
across hosts. The host provides the model and the conversation; Ayo provides
what the assistant knows and can do.

Instead of exposing a large catalog of MCP tools, Ayo keeps the surface
compact:

- **`search`** — the host discovers capabilities (what can Ayo do, and with
  what call shape).
- **`execute`** — the host writes a small ES module that composes those
  capabilities (`await ayo.remember(...)`, `await ayo.notify(...)`) and Ayo
  runs it server-side in a sandbox.

Capabilities live behind that surface as plain typed modules. Live domains:
the **notebook** (markdown pages with versions and history, stored in my
Bureau workspace over a service binding, readable at stable
`ayo.oflabs.dev/notebook/...` links behind my own auth) and **memory** — a
considered rebuild of my earlier Jerry experiment — filed as notebook pages
with verify-first writes and ambient recall. Automations (a scheduled brief of
the day) are the next direction.

Single-user by design: no tenancy, no signup, my data only.

## Stack

Cloudflare Workers · TypeScript · pnpm · Vitest (workers pool) · KV ·
Vectorize + Workers AI (search and recall) · Dynamic Workers via
`@cloudflare/codemode` (the execute sandbox) · a service binding to Bureau
(the notebook backend) · Workers Builds (deploy on merge)

## Development

```sh
pnpm install
pnpm dev
pnpm test
```
