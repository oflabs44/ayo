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

Capabilities live behind that surface as plain typed modules. The first real
domain is memory — a considered rebuild of my earlier Jerry experiment — with
automations and durable saved code as the long-term direction.

Single-user by design: no tenancy, no signup, my data only.

## Stack

Cloudflare Workers · TypeScript · pnpm · Vitest (workers pool) · D1 (planned)
· Dynamic Workers for the execute sandbox (planned)

## Development

```sh
pnpm install
pnpm dev
pnpm test
```
