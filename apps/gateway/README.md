# codemode-gateway

The gateway of WeFaber Code Mode (`mcp.wefaber.net`, [SPEC §8](../../docs/SPEC.md)). One endpoint, one token, every product. It has no domain logic: it authenticates, routes, audits and budgets.

```
agent ──/mcp, /codemode/*──▶ gateway ──signed identity──▶ product /codemode/execute
                              │  search  → runs over the catalog (all visible ops, one flat list)
                              │  execute → codemode.<product>.<resource>.<verb>() is forwarded per call
                              └─ SQLite: catalog, tokens (sha256), runs (audit), daily byte budget
```

## Routes

| Route                                             | Auth   | What                                                                                          |
| ------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| `POST /mcp`                                       | Bearer | Streamable HTTP MCP, exactly `search` and `execute` (R2)                                      |
| `POST /codemode/search`, `POST /codemode/execute` | Bearer | Plain HTTP, `{ "code": "..." }` → [SPEC §6](../../docs/SPEC.md) response, plus `x-wcm-run-id` |
| `GET /catalog`                                    | Bearer | Products and operation counts the token can use. Product URLs never leave the gateway         |
| `GET /health`, `GET /ready`                       | none   | `{"ok":true}`; ready also checks the database                                                 |

`search` receives `spec = { products: { <name>: { version, types } }, ops: [{ id, scope, summary, input, output }] }`, already limited to the scopes of the token (R5). `execute` only has the operations the token can use; the rest do not exist in the sandbox.

## How `execute` reaches a product

Each call `await codemode.todo.items.create({ ... })` becomes one `POST <product url>/codemode/execute` with the code `return await codemode.todo.items.create({...})` and a signed identity. The product validates the input and applies the scope again, so a product keeps working the same behind the gateway or directly.

- A product that is down, slow (over `WCM_PRODUCT_TIMEOUT_MS`) or answering 5xx → `PRODUCT_UNAVAILABLE`; the gateway and the other products keep serving.
- A product that announces another major in `x-wcm-spec-version` than the catalog knows → `SPEC_MISMATCH` (R8).
- A product that rejects the signed identity → `HOST_ERROR` to the agent, the cause only in the server log.
- Errors of the product (`NOT_FOUND`, `VALIDATION`, `FORBIDDEN`...) keep their code: the code can branch on `e.code`, and uncaught, the run fails with that same code (SPEC R12), so an agent can tell the user what went wrong. `CODE_ERROR` is only for mistakes in the agent's own code.
- A product result that the product truncated is `LIMIT_REACHED`: ask for less.

### Identity a product receives

`x-wcm-via: gateway`, `x-wcm-token-hash`, `x-wcm-scopes`, `x-wcm-agent`, `x-wcm-run-id` (the same for every call of one run, so the product ties its audit row to the gateway's), `x-wcm-timestamp` and `x-wcm-signature` (HMAC-SHA256 over those fields with `WCM_GATEWAY_SECRET`). A product accepts them only through `verifyIdentity(secret, request.headers)` ([`src/identity.ts`](src/identity.ts)): bad signature, other secret or a timestamp more than 60 s off is `null` → `UNAUTHENTICATED`. The agent's token never reaches a product, only its hash.

## Configuration

| Variable                 | Default             |                                                                                     |
| ------------------------ | ------------------- | ----------------------------------------------------------------------------------- |
| `WCM_GATEWAY_SECRET`     | required, 32+ chars | HMAC key shared with the products. Lives in `~/deploy/env/`, never in the repo      |
| `WCM_GATEWAY_DB`         | `./gateway.sqlite`  | SQLite file (`/srv/codemode/data/gateway.sqlite` on the VPS)                        |
| `PORT`                   | `4171`              | Listens on `127.0.0.1` only; Nginx proxies                                          |
| `WCM_RUN_TIMEOUT_MS`     | `15000`             | Whole run, including the product calls inside it (a product run alone may take 5 s) |
| `WCM_PRODUCT_TIMEOUT_MS` | `10000`             | One call to a product                                                               |
| `WCM_RUNS_PER_MINUTE`    | `60`                | Per token                                                                           |
| `WCM_MAX_BYTES_PER_DAY`  | `10485760`          | Result bytes per token per day; over it, `RATE_LIMITED`                             |

## Admin (on the host that holds the database)

```bash
bun src/cli.ts catalog publish ./spec.json --url https://checklist.wefaber.net [--accept-major]
bun src/cli.ts catalog list
bun src/cli.ts token create --label hermes --scopes checklist:write,wegraph:read [--days 90]
echo "$OLD_PRODUCT_TOKEN" | bun src/cli.ts token import --label "mychecklist agent" --scopes checklist:write
bun src/cli.ts token list
bun src/cli.ts token revoke <hash-prefix>
```

`catalog publish` validates the spec (ids, scopes, semver), because the gateway builds code and routes from it. A different major than the one on record is refused without `--accept-major`: agents code against the old shape. `token create` prints the token once; only its sha256 is stored. `token import` registers a token a product already issued (`mck_…`) so it keeps working.

## Deploy

Templates in [`deploy/`](deploy): the systemd unit and the Nginx vhost. The delivery path is the usual one (branch → PR → merge → self-hosted runner → blue/green on `/srv/codemode/current`), not a manual copy. Cutting `mcp.wefaber.net` over from wegraf (PLAN Task 5.4) needs the wegraf move to `wegraph.wefaber.net` first (D1) and is an infra step: DNS, certificate and the Nginx reload.

## Not done yet

- **Per-minute call budget.** The gateway limits runs per minute and result bytes per day per token; a run is capped at 50 calls (R6). A calls-per-minute counter on top is the stricter reading of SPEC §8.
- **`verifyIdentity` for products** lives here. When the first product adopts the gateway (PLAN Phase 4), it moves to `@wefaber/codemode-mcp` so products import it instead of copying it.
- **Clef ranking** (D4) is not part of this: `search` returns what the code filters.
