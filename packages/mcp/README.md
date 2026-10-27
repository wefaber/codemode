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

## License

[MIT](./LICENSE) © WeFaber. Part of [wefaber/codemode](https://github.com/wefaber/codemode).
