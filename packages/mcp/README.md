# @wefaber/codemode-mcp

Transports for WeFaber Code Mode: `/codemode/search`, `/codemode/execute` and `/mcp` (the two tools `search` and
`execute`) as a single Web `Request` handler, with a rate limiter and an audit hook.

```bash
bun add @wefaber/codemode-mcp
```

Ships TypeScript source. Runs on Bun.

## Usage

```ts
import { createWcmHandler } from '@wefaber/codemode-mcp'

const handler = createWcmHandler({
  registry, // createRegistry({ product, version, ops }) from @wefaber/codemode
  sandbox: createQuickJsSandbox(), // @wefaber/codemode-sandbox-quickjs
  auth: (req) => ({ tokenId, scopes: ['todo:write'], ctx }), // or null -> 401, or a Response
  audit: (row) => db.insert(row),
})

// Elysia: .all("/mcp", ({ request }) => handler(request));  Bun.serve: { fetch: handler }
```

Every run is audited; `auth` decides the scopes the script may use.

## Behind the gateway

A product served through the WeFaber gateway receives the caller as a signed identity (`x-wcm-*` headers, HMAC-SHA256 over `WCM_GATEWAY_SECRET`). Accept it in `auth` with `verifyIdentity`; it returns `null` for a bad signature, another secret or a timestamp more than `MAX_SKEW_MS` (60 s) off, so the handler answers 401.

```ts
import { createWcmHandler, verifyIdentity } from '@wefaber/codemode-mcp'

const handler = createWcmHandler({
  registry,
  sandbox,
  auth: async (req) => {
    const id = await verifyIdentity(
      process.env.WCM_GATEWAY_SECRET!,
      req.headers,
    )
    if (!id) return null // -> 401
    return {
      tokenId: id.tokenHash,
      scopes: id.scopes,
      label: id.label ?? undefined,
      ctx,
    }
  },
})
```

`id.runId` is the gateway's run id (the same for every call of one run): store it in your own audit row to tie both together. The agent's token never reaches the product, only its hash. `signIdentity(secret, identity)` is the other half, used by the gateway.

## License

[MIT](./LICENSE) © WeFaber. Part of [wefaber/codemode](https://github.com/wefaber/codemode).
