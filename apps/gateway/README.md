# codemode-gateway

The gateway of WeFaber Code Mode (`mcp.wefaber.net`, [SPEC §8](../../docs/SPEC.md)). One endpoint, one token, every product. It has no domain logic: it authenticates, routes, audits and budgets.

```
agent ──/mcp, /codemode/*──▶ gateway ──signed identity──▶ product /codemode/execute
                              │  search  → runs over the catalog (all visible ops, one flat list)
                              │  execute → codemode.<product>.<resource>.<verb>() is forwarded per call
                              └─ SQLite: catalog, tokens (sha256), runs (audit), budgets (calls/minute, bytes/day)
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

`x-wcm-via: gateway`, `x-wcm-token-hash`, `x-wcm-scopes`, `x-wcm-agent`, `x-wcm-run-id` (the same for every call of one run, so the product ties its audit row to the gateway's), `x-wcm-timestamp` and `x-wcm-signature` (HMAC-SHA256 over those fields with `WCM_GATEWAY_SECRET`). A product accepts them only through `verifyIdentity(secret, request.headers)` from `@wefaber/codemode-mcp` ([`identity.ts`](../../packages/mcp/src/identity.ts); [how a product wires it](../../packages/mcp/README.md#behind-the-gateway)): bad signature, other secret or a timestamp more than 60 s off is `null` → `UNAUTHENTICATED`. The agent's token never reaches a product, only its hash.

## Configuration

| Variable                 | Default             |                                                                                     |
| ------------------------ | ------------------- | ----------------------------------------------------------------------------------- |
| `WCM_GATEWAY_SECRET`     | required, 32+ chars | HMAC key shared with the products. Lives in `~/deploy/env/`, never in the repo      |
| `WCM_GATEWAY_DB`         | `./gateway.sqlite`  | SQLite file (`/srv/codemode/data/gateway.sqlite` on the VPS)                        |
| `PORT`                   | `4171`              | Listens on `127.0.0.1` only; Nginx proxies                                          |
| `WCM_RUN_TIMEOUT_MS`     | `15000`             | Whole run, including the product calls inside it (a product run alone may take 5 s) |
| `WCM_PRODUCT_TIMEOUT_MS` | `10000`             | One call to a product                                                               |
| `WCM_RUNS_PER_MINUTE`    | `60`                | Runs per token, in memory                                                           |
| `WCM_CALLS_PER_MINUTE`   | `600`               | Calls to products per token, across its runs, in SQLite; over it, `RATE_LIMITED`    |
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

On the VPS, blue/green, from `main` only: `.github/workflows/deploy-gateway.yml` runs
[`deploy/deploy-gateway.sh`](deploy/deploy-gateway.sh) on the `vps-wefaber` self-hosted runner
(push touching `apps/gateway/**` or `packages/**`, or `workflow_dispatch`). Nothing is copied by hand.

```
release  /srv/codemode/releases/<utc-stamp>-<sha>     one checkout + bun install per deploy
slots    /srv/codemode/{blue,green} -> release        codemode-gateway@<slot>.service, PORT 4191/4192
live     /srv/codemode/current      -> slot          what nginx proxies
data     /srv/codemode/data/gateway.sqlite           shared by both slots
env      ~/deploy/env/codemode-gateway.env           WCM_GATEWAY_SECRET + WCM_GATEWAY_DB (600, never in the repo)
         ~/deploy/env/codemode-gateway-<slot>.env    PORT of that slot
```

The deploy starts the new release in the **idle** slot, requires `GET /health` **and** `GET /ready` to
answer `200` with `ok:true` on that slot's loopback port, and only then repoints `current` and the
nginx upstream (`/etc/nginx/sites-available/mcp.wefaber.net`, one `server` line) plus a reload. The
slot that was live stays up, so a failure at any step is an automatic rollback — `current` back,
upstream back, idle slot stopped, failed release deleted — with the failing slot's log in the run.
`4171`/`4172`, the numbers this file used to name, are taken by tabula on this host, hence `4191`/`4192`.

Rehearsal (no production): the script reads `CODEMODE_ROOT`, `CODEMODE_ENVDIR`, `CODEMODE_NGINX_CONF`,
`CODEMODE_NGINX_ENABLED`, `CODEMODE_PUBLIC_URL` and `CODEMODE_SLOT_RUNNER=direct`, so a scratch root
can exercise the whole flow — including a forced failure — before touching the VPS.

`deploy/codemode-gateway@.service` and `deploy/nginx-mcp.wefaber.net.conf` are the templates; the
script installs the unit if the host lacks it.

**Cutting `mcp.wefaber.net` over** from the wegraph Worker (PLAN Task 5.4) needs the wegraf move to
`wegraph.wefaber.net` first (D1): the vhost stays in `sites-available` — written and `nginx -t`-clean
but not enabled — until that lands. Enabling it is a symlink into `sites-enabled` plus a reload.

## Budgets

Per token, three limits, all answering `RATE_LIMITED`: runs per minute (in memory), calls to products per minute and result bytes per day (both in SQLite, tables `call_usage` and `usage`). Each forwarded call counts one, whichever product serves it; a call over the limit fails inside the code (catchable, `RATE_LIMITED` in the message) and never reaches the product. The window is a fixed calendar minute: a token can spend its limit at the end of one minute and again at the start of the next. The default of 600 is 10 calls per second sustained: one run is capped at 50 calls (R6) and 60 runs per minute could make 3000, so 600 is a real ceiling (a maximal run uses 8% of it) and still lets ~60 average runs of 10 calls through. Raise it per deployment with `WCM_CALLS_PER_MINUTE`.

## Not done yet

- **Clef ranking** (D4) is not part of this: `search` returns what the code filters.
