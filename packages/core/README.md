# @wefaber/codemode

Core of WeFaber Code Mode: the operation registry (`defineOp`, `createRegistry`), the generator for `spec.json` and
`client.d.ts`, limits, errors and the sandbox contract. With Code Mode an MCP client sees two tools (`search`,
`execute`) and the model writes JavaScript against a typed product API inside a sandbox.

```bash
bun add @wefaber/codemode
```

Ships TypeScript source. Runs on Bun.

## Usage

Define a registry per product, then pair it with a sandbox
([`@wefaber/codemode-sandbox-quickjs`](https://www.npmjs.com/package/@wefaber/codemode-sandbox-quickjs)) and a
transport ([`@wefaber/codemode-mcp`](https://www.npmjs.com/package/@wefaber/codemode-mcp)).

Names are `product.resource.verb`, scopes are `product:read|write|admin`.

## `wcm` CLI

Generates `spec.json` and `client.d.ts` from the registry, and fails in CI when they are stale:

```bash
bunx wcm gen   --registry ./src/registry.ts --out ./generated
bunx wcm check --registry ./src/registry.ts --out ./generated
```

The module passed to `--registry` exports `registry` (or `default`).

## Packages

| Package                             | What                                                                  |
| ----------------------------------- | --------------------------------------------------------------------- |
| `@wefaber/codemode`                 | This package                                                          |
| `@wefaber/codemode-sandbox-quickjs` | QuickJS (wasm) in a terminable Bun Worker                             |
| `@wefaber/codemode-mcp`             | `/codemode/search`, `/codemode/execute` and `/mcp` as one Web handler |
| `@wefaber/codemode-cli`             | stdio MCP bridge for local agents                                     |

## License

[MIT](./LICENSE) © WeFaber. Part of [wefaber/codemode](https://github.com/wefaber/codemode).
