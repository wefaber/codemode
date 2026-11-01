import type { Database } from 'bun:sqlite'
import {
  DEFAULT_LIMITS,
  MAX_BODY_BYTES,
  MAX_CODE_CHARS,
  WCM_MCP_TOOLS,
  type Sandbox,
  type WcmErrorCode,
  type WcmTool,
} from '@wefaber/codemode'
import {
  createLimiter,
  handleRpc,
  outcomeBody,
  type AuditRow,
  type CodeOutcome,
  type RpcRequest,
  type ToolInfo,
} from '@wefaber/codemode-mcp'
import { createCatalog } from './catalog.ts'
import type { GatewayConfig } from './config.ts'
import { buildHost, type ForwardDeps } from './forward.ts'
import { createTokenStore, type GatewayPrincipal } from './tokens.ts'

export type GatewayDeps = {
  db: Database
  config: GatewayConfig
  sandbox: Sandbox
  fetch?: typeof fetch
  now?: () => number
  newRunId?: () => string
  onError?: (err: unknown, where: string) => void
}

const STATUS: Partial<Record<WcmErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  VALIDATION: 400,
  LIMIT_REACHED: 413,
  RATE_LIMITED: 429,
}

const error = (
  code: WcmErrorCode,
  message: string,
  headers?: Record<string, string>,
) =>
  Response.json(
    { ok: false, error: { code, message } },
    { status: STATUS[code] ?? 500, headers },
  )

class HttpError extends Error {
  constructor(
    readonly code: WcmErrorCode,
    message: string,
  ) {
    super(message)
  }
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES)
    throw new HttpError(
      'LIMIT_REACHED',
      `The body is limited to ${MAX_BODY_BYTES / 1024} KB`,
    )
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError('VALIDATION', 'The body is not JSON')
  }
}

const rejected = (
  code: 'RATE_LIMITED' | 'VALIDATION',
  message: string,
): CodeOutcome => ({
  ok: false,
  error: { code, message },
  logs: [],
  calls: 0,
  ms: 0,
})

const INFO: ToolInfo = {
  product: 'gateway',
  instructions:
    'WeFaber Code Mode: one endpoint for every WeFaber product. `search` runs JavaScript over `spec` ' +
    '({ products: { <name>: { version, types } }, ops: [{ id, scope, summary, input, output }] }) and returns only what ' +
    'the code returns: filter `spec.ops` to find operations. `execute` runs JavaScript with ' +
    '`codemode.<product>.<resource>.<verb>(input)` (async); chain every call you need, across products, in a single ' +
    'run and `return` only what matters. No network or files.',
  descriptions: {
    search:
      'Runs JavaScript over `spec` ({ products, ops }) and returns what the code returns. Filter `spec.ops` by id or summary to fetch only the operations you need.',
    execute:
      'Runs JavaScript with `codemode.<product>.<resource>.<verb>(input)` for every product your token can use. Several calls per run, across products; returns what the code returns. Find the operations first with `search`.',
  },
}

/**
 * The gateway as one Web-standard handler (SPEC §8): `search` over the whole catalog, `execute` routed by product,
 * `/catalog`, `/health`. Domain logic lives in the products; this only authenticates, routes, audits and budgets.
 */
export function createGateway(deps: GatewayDeps) {
  const { db, config, sandbox } = deps
  const now = deps.now ?? Date.now
  const newRunId = deps.newRunId ?? (() => crypto.randomUUID())
  const onError =
    deps.onError ??
    ((err: unknown, where: string) => console.error('[gateway]', where, err))
  const catalog = createCatalog(db, now)
  const tokens = createTokenStore(db, now)
  const limiter = createLimiter(
    { maxWorkers: 4, perMinute: config.perMinute },
    now,
  )
  const forward: ForwardDeps = {
    secret: config.secret,
    timeoutMs: config.productTimeoutMs,
    fetch: deps.fetch ?? fetch,
    now,
    onError,
  }
  const limits = { ...DEFAULT_LIMITS, timeoutMs: config.runTimeoutMs }

  const usedToday = db.prepare<{ bytes: number }, [string, string]>(
    'SELECT bytes FROM usage WHERE token_hash = ? AND day = ?',
  )
  const addUsage = db.prepare(
    `INSERT INTO usage (token_hash, day, bytes) VALUES (?, ?, ?)
     ON CONFLICT(token_hash, day) DO UPDATE SET bytes = bytes + excluded.bytes`,
  )
  const insertRun = db.prepare(
    `INSERT INTO runs (run_id, products, token_hash, agent_label, kind, ops, calls, ms, result_bytes, truncated,
       error_code, spec_versions, via, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const day = () => new Date(now()).toISOString().slice(0, 10)

  const record = (row: AuditRow) => {
    try {
      insertRun.run(
        row.runId,
        row.product,
        row.tokenId,
        row.agentLabel,
        row.kind,
        JSON.stringify(row.ops),
        row.calls,
        row.ms,
        row.resultBytes,
        row.truncated ? 1 : 0,
        row.errorCode,
        row.specVersion,
        row.via,
        row.createdAt,
      )
      if (row.resultBytes > 0) addUsage.run(row.tokenId, day(), row.resultBytes)
    } catch (err) {
      onError(err, 'audit')
    }
  }

  /** One run: validate, budget, sandbox, audit. `execute` is routed by product; `search` sees the visible catalog. */
  async function run(
    principal: GatewayPrincipal,
    kind: WcmTool,
    code: string,
  ): Promise<{ outcome: CodeOutcome; runId: string }> {
    const runId = newRunId()
    if (code.length === 0)
      return { outcome: rejected('VALIDATION', 'Missing code to run'), runId }
    if (code.length > MAX_CODE_CHARS)
      return {
        outcome: rejected(
          'VALIDATION',
          `Code is limited to ${MAX_CODE_CHARS / 1024} KB`,
        ),
        runId,
      }
    const used = usedToday.get(principal.tokenId, day())?.bytes ?? 0
    if (used >= config.maxBytesPerDay)
      return {
        outcome: rejected(
          'RATE_LIMITED',
          'The daily result budget of this token is exhausted',
        ),
        runId,
      }
    const acquired = limiter.acquire(principal.tokenId)
    if (!acquired.ok)
      return { outcome: rejected('RATE_LIMITED', acquired.message), runId }

    const ops: string[] = []
    const touched = new Map<string, string>()
    let outcome: CodeOutcome
    try {
      const visible = catalog.visible(principal.scopes)
      if (kind === 'search') {
        for (const { product } of visible)
          touched.set(product.product, product.version)
        outcome = await sandbox.run({
          code,
          host: {},
          data: { spec: catalog.visibleSpec(principal.scopes) },
          limits,
        })
      } else {
        outcome = await sandbox.run({
          code,
          name: 'codemode',
          host: buildHost(
            forward,
            {
              tokenHash: principal.tokenId,
              scopes: principal.scopes,
              label: principal.label ?? null,
              runId,
            },
            visible,
            {
              onCall: (id, product) => {
                ops.push(id)
                const entry = catalog.get(product)
                if (entry) touched.set(product, entry.version)
              },
            },
          ),
          limits,
        })
      }
    } finally {
      acquired.slot.release()
    }

    record({
      runId,
      product: [...touched.keys()].join(','),
      tokenId: principal.tokenId,
      agentLabel: principal.label ?? null,
      kind,
      ops,
      calls: outcome.calls,
      ms: outcome.ms,
      resultBytes: outcome.ok ? outcome.result.length : 0,
      truncated: outcome.ok ? outcome.truncated : false,
      errorCode: outcome.ok ? null : outcome.error.code,
      specVersion: [...touched].map(([p, v]) => `${p}@${v}`).join(','),
      via: 'gateway',
      createdAt: now(),
    })
    return { outcome, runId }
  }

  const authenticate = (request: Request) => {
    const principal = tokens.authenticate(request)
    return (
      principal ??
      error('UNAUTHENTICATED', 'A valid token is required', {
        'www-authenticate': 'Bearer',
      })
    )
  }

  const direct = async (request: Request, kind: WcmTool) => {
    const principal = authenticate(request)
    if (principal instanceof Response) return principal
    try {
      const body = await readJson(request)
      const code = (body as { code?: unknown } | null)?.code
      if (typeof code !== 'string')
        throw new HttpError('VALIDATION', 'Missing `code` (string)')
      const { outcome, runId } = await run(principal, kind, code)
      const status = outcome.ok
        ? 200
        : outcome.error.code === 'RATE_LIMITED'
          ? 429
          : outcome.error.code === 'VALIDATION'
            ? 400
            : 200
      return Response.json(outcomeBody(outcome), {
        status,
        headers: { 'x-wcm-run-id': runId },
      })
    } catch (err) {
      if (err instanceof HttpError) return error(err.code, err.message)
      throw err
    }
  }

  const mcp = async (request: Request) => {
    const principal = authenticate(request)
    if (principal instanceof Response) return principal
    let message: unknown
    try {
      message = await readJson(request)
    } catch (err) {
      if (err instanceof HttpError && err.code === 'VALIDATION')
        return Response.json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: err.message },
        })
      if (err instanceof HttpError) return error(err.code, err.message)
      throw err
    }
    const reply = await handleRpc(
      message as RpcRequest,
      INFO,
      async (kind, code) => {
        const { outcome } = await run(principal, kind, code)
        return { body: outcomeBody(outcome), isError: !outcome.ok }
      },
    )
    return reply ? Response.json(reply) : new Response(null, { status: 202 })
  }

  const handler = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url)
    if (pathname === '/health' && request.method === 'GET')
      return Response.json({ ok: true })
    if (pathname === '/ready' && request.method === 'GET') {
      try {
        db.query('SELECT 1').get()
        return Response.json({ ok: true, products: catalog.list().length })
      } catch (err) {
        onError(err, 'ready')
        return Response.json({ ok: false }, { status: 503 })
      }
    }
    if (pathname === '/catalog') {
      if (request.method !== 'GET')
        return new Response(null, { status: 405, headers: { allow: 'GET' } })
      const principal = authenticate(request)
      if (principal instanceof Response) return principal
      // Products and operation counts the token can use. The product URLs never leave the gateway.
      const counts = new Map<
        string,
        { version: string; major: number; ops: number }
      >()
      for (const { product } of catalog.visible(principal.scopes)) {
        const row = counts.get(product.product) ?? {
          version: product.version,
          major: product.major,
          ops: 0,
        }
        row.ops += 1
        counts.set(product.product, row)
      }
      return Response.json({
        products: [...counts].map(([product, info]) => ({ product, ...info })),
      })
    }
    if (pathname === '/mcp') {
      // No SSE and no sessions: nothing to open with GET or close with DELETE.
      if (request.method !== 'POST')
        return new Response(null, { status: 405, headers: { allow: 'POST' } })
      return mcp(request)
    }
    const tool = WCM_MCP_TOOLS.find((t) => pathname === `/codemode/${t}`)
    if (tool) {
      if (request.method !== 'POST')
        return new Response(null, { status: 405, headers: { allow: 'POST' } })
      return direct(request, tool)
    }
    return new Response(null, { status: 404 })
  }

  return { handler, catalog, tokens }
}

export type Gateway = ReturnType<typeof createGateway>
