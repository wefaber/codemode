# @wefaber/codemode-sandbox-quickjs

The default sandbox for WeFaber Code Mode: QuickJS compiled to wasm, run in a terminable Bun Worker. The sandbox has
no network; scripts reach the product only through the operations in the registry.

```bash
bun add @wefaber/codemode-sandbox-quickjs
```

Ships TypeScript source. Runs on Bun.

## Usage

```ts
import { createQuickJsSandbox } from '@wefaber/codemode-sandbox-quickjs'

const sandbox = createQuickJsSandbox()
```

Pass it as `sandbox` to `createWcmHandler` from
[`@wefaber/codemode-mcp`](https://www.npmjs.com/package/@wefaber/codemode-mcp). Time and size limits come from
[`@wefaber/codemode`](https://www.npmjs.com/package/@wefaber/codemode); a script that overruns is terminated by
killing its Worker.

## Exports

`createQuickJsSandbox`, `collectOps`, `runInWorker`, `GRACE_MS`, `runSandboxed`.

## License

[MIT](./LICENSE) © WeFaber. Part of [wefaber/codemode](https://github.com/wefaber/codemode).
