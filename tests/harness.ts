import { DEFAULT_LIMITS, type Limits } from '@wefaber/codemode'
import {
  createLimiter,
  createWcmHandler,
  DEFAULT_LIMITER,
  type AuditRow,
  type Limiter,
} from '@wefaber/codemode-mcp'
import { createQuickJsSandbox } from '@wefaber/codemode-sandbox-quickjs'
import { todoRegistry, type TodoCtx } from './fixtures/todo.ts'

export const TOKENS = {
  write: { tokenId: 't-write', scopes: ['todo:write'], label: 'writer' },
  read: { tokenId: 't-read', scopes: ['todo:read'], label: 'reader' },
  other: { tokenId: 't-other', scopes: ['todo:write'], label: 'other' },
} as const

/** The fixture product behind the real handler, the real QuickJS Worker and an audit sink. */
export function harness(
  opts: {
    limits?: Partial<Limits>
    limiter?: Limiter
    aliases?: Record<string, string>
    failAudit?: boolean
  } = {},
) {
  const store: TodoCtx['store'] = new Map()
  const audit: AuditRow[] = []
  const errors: unknown[] = []
  const handler = createWcmHandler<TodoCtx>({
    registry: todoRegistry,
    sandbox: createQuickJsSandbox(),
    limits: { ...DEFAULT_LIMITS, timeoutMs: 400, ...opts.limits },
    limiter:
      opts.limiter ?? createLimiter({ ...DEFAULT_LIMITER, perMinute: 1000 }),
    aliases: opts.aliases,
    audit: (row) => {
      if (opts.failAudit) throw new Error('audit sink down')
      audit.push(row)
    },
    onError: (err) => void errors.push(err),
    auth: (request) => {
      const header = request.headers.get('authorization') ?? ''
      const name = /^Bearer\s+(\S+)$/i.exec(header)?.[1]
      const token = TOKENS[name as keyof typeof TOKENS]
      return token
        ? { ...token, scopes: [...token.scopes], ctx: { store } }
        : null
    },
  })
  const post = (
    path: string,
    token: string | null,
    body: unknown,
    method = 'POST',
  ) =>
    handler(
      new Request(`https://todo.test${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(method === 'POST'
          ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
          : {}),
      }),
    )
  const exec = async (
    token: keyof typeof TOKENS | null,
    code: string,
    kind: 'execute' | 'search' = 'execute',
  ) => {
    const res = await post(`/codemode/${kind}`, token, { code })
    // oxlint-disable-next-line no-explicit-any
    return { status: res.status, body: (await res.json()) as any }
  }
  return { store, audit, errors, handler, post, exec }
}
