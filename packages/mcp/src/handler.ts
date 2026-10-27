import {
  MAX_BODY_BYTES,
  WCM_MCP_TOOLS,
  type WcmErrorCode,
  type WcmTool,
} from '@wefaber/codemode'
import { createLimiter } from './limiter.ts'
import { handleRpc, type RpcRequest, type ToolInfo } from './protocol.ts'
import { outcomeBody, runCode, type Principal, type RunEnv } from './run.ts'

export type WcmHandlerOptions<Ctx> = Omit<RunEnv<Ctx>, 'limiter'> &
  Pick<ToolInfo, 'instructions' | 'descriptions'> & {
    /**
     * Resolves the caller from the request. Return `null` for "no valid token" (401), or a `Response` to reject with
     * the product's own answer (origin checks, ingress).
     */
    auth(
      request: Request,
    ):
      | Promise<Principal<Ctx> | Response | null>
      | Principal<Ctx>
      | Response
      | null
    limiter?: RunEnv<Ctx>['limiter']
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
  code: WcmErrorCode
  constructor(code: WcmErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

async function readJson(request: Request): Promise<unknown> {
  const tooBig = new HttpError(
    'LIMIT_REACHED',
    `The body is limited to ${MAX_BODY_BYTES / 1024} KB`,
  )
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) throw tooBig
  const chunks: Uint8Array[] = []
  let size = 0
  if (request.body) {
    const reader = request.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        void reader.cancel()
        throw tooBig
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new HttpError('VALIDATION', 'The body is not JSON')
  }
}

/**
 * The three transport surfaces of SPEC §6 as one Web-standard handler: `POST /codemode/search`,
 * `POST /codemode/execute` and `POST /mcp` (Streamable HTTP, exactly `search` and `execute`). Mount it in Elysia,
 * `Bun.serve` or a Worker: it only needs `Request` and `Response`.
 */
export function createWcmHandler<Ctx>(opts: WcmHandlerOptions<Ctx>) {
  const env: RunEnv<Ctx> = { ...opts, limiter: opts.limiter ?? createLimiter() }
  const info: ToolInfo = {
    product: opts.registry.product,
    instructions: opts.instructions,
    descriptions: opts.descriptions,
  }

  const authenticate = async (request: Request) => {
    const principal = await opts.auth(request)
    if (principal === null)
      return error('UNAUTHENTICATED', 'A valid token is required', {
        'www-authenticate': 'Bearer',
      })
    return principal
  }

  const direct = async (request: Request, kind: WcmTool) => {
    const principal = await authenticate(request)
    if (principal instanceof Response) return principal
    try {
      const body = await readJson(request)
      const code = (body as { code?: unknown } | null)?.code
      if (typeof code !== 'string')
        throw new HttpError('VALIDATION', 'Missing `code` (string)')
      const outcome = await runCode(env, principal, kind, code)
      const status = outcome.ok
        ? 200
        : outcome.error.code === 'RATE_LIMITED'
          ? 429
          : outcome.error.code === 'VALIDATION'
            ? 400
            : 200
      return Response.json(outcomeBody(outcome), { status })
    } catch (e) {
      if (e instanceof HttpError) return error(e.code, e.message)
      throw e
    }
  }

  const mcp = async (request: Request) => {
    const principal = await authenticate(request)
    if (principal instanceof Response) return principal
    let message: unknown
    try {
      message = await readJson(request)
    } catch (e) {
      if (e instanceof HttpError && e.code === 'VALIDATION')
        return Response.json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: e.message },
        })
      if (e instanceof HttpError) return error(e.code, e.message)
      throw e
    }
    const reply = await handleRpc(
      message as RpcRequest,
      info,
      async (kind, code) => {
        const outcome = await runCode(env, principal, kind, code)
        return { body: outcomeBody(outcome), isError: !outcome.ok }
      },
    )
    return reply ? Response.json(reply) : new Response(null, { status: 202 })
  }

  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url)
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
}
