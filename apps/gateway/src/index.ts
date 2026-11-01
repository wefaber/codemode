import { MAX_BODY_BYTES } from '@wefaber/codemode'
import { createQuickJsSandbox } from '@wefaber/codemode-sandbox-quickjs'
import { loadConfig } from './config.ts'
import { openDb } from './db.ts'
import { createGateway } from './gateway.ts'

const config = loadConfig()
const gateway = createGateway({
  db: openDb(config.dbPath),
  config,
  sandbox: createQuickJsSandbox(),
})

// Loopback only: Nginx terminates TLS and proxies mcp.wefaber.net here (docs/PLAN.md, Task 5.1).
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: config.port,
  maxRequestBodySize: MAX_BODY_BYTES + 1024,
  fetch: gateway.handler,
})

console.log(
  `codemode-gateway listening on http://${server.hostname}:${server.port} (db: ${config.dbPath})`,
)
