# codemode

Shared toolkit for exposing WeFaber products to AI agents through **Code Mode**: the client sees at most two MCP tools (`search`, `execute`), and the model writes JavaScript that calls a typed product API inside a sandbox.

Status: **specification** (v0.1, 2026-10-26). No packages implemented yet.

## Why

The current fleet exposes ~40 MCP tools across four servers (`wegraph`, `kit`, `ohmydocs`, `ohmydiagrams`) with three transports and two auth models. `wegraph` alone ships 16,670 bytes of tool schemas — roughly 4,100 tokens paid on every session — and chains such as `resolve_context → query_org_graph → trace_node` cost three model round-trips.

Code Mode collapses that into one script per task: intermediate data stays in the sandbox, only the final result reaches the model.

## Read first

| Document | What it defines |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | The standard: 12 rules, operation contract, sandbox contract, transports, auth, gateway, observability |
| [`docs/PLAN.md`](docs/PLAN.md) | Nine phases with file paths, commands, verification and estimates |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | D1/D2/D3 with the evidence behind each |

## The rules, compressed

1. One registry per product (`defineOp`); `spec.json` and `client.d.ts` are generated and CI fails when stale.
2. Exactly two MCP tools: `search` and `execute`.
3. Operations call the product's existing service layer; the sandbox has no network.
4. Names are `product.resource.verb`; scopes are `product:read|write|admin`; every run is audited.
5. A shared conformance suite is the arbiter of the standard, not the document.

## Layout (planned)

```
packages/core/            defineOp, registry, spec generation, limits, errors
packages/sandbox-quickjs/ QuickJS + terminable Bun Worker (default runtime)
packages/sandbox-workers/ @cf-wasm/quickjs adapter for Cloudflare products
packages/mcp/             MCP handler exposing search + execute
packages/cli/             generated stdio server for local agents
apps/gateway/             mcp.wefaber.net router (Bun service on the VPS)
tests/conformance/        @wefaber/codemode-conformance
```

## Migration order

`mychecklist` (reference implementation) → `wegraph` (24 tools to 2) → gateway on `mcp.wefaber.net` → `kit`, `ohmydocs`, `ohmydiagrams` → VPS products (`jobit`, `mercuria`, `lux`, `cdn-panel`, `wefiles`).
