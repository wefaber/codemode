import {
  buildSpec,
  MAX_CODE_CHARS,
  type Limits,
  type Registry,
  type RunResult,
  type Sandbox,
  type WcmErrorCode,
  type WcmTool,
} from '@wefaber/codemode'
import type { Limiter } from './limiter.ts'

/** Who is calling, as the product resolved it from its token. The sandbox never sees any of this. */
export type Principal<Ctx> = {
  /** Stable id of the token: rate-limit key and audit subject. */
  tokenId: string
  /** `product:read|write|admin` scopes of the token. */
  scopes: string[]
  /** What the handlers receive (user, org, tenancy...). */
  ctx: Ctx
  /** Human label of the agent, for the audit row. */
  label?: string
}

/** One row per run (SPEC R10 and §9). */
export type AuditRow = {
  runId: string
  product: string
  tokenId: string
  agentLabel: string | null
  kind: WcmTool
  /** Operations the code called, in order. */
  ops: string[]
  calls: number
  ms: number
  resultBytes: number
  truncated: boolean
  errorCode: WcmErrorCode | 'INVALID_INPUT' | string | null
  specVersion: string
  via: 'direct' | 'gateway' | 'cli'
  createdAt: number
}

export type RunEnv<Ctx> = {
  registry: Registry<Ctx>
  sandbox: Sandbox
  limiter: Limiter
  /** Only tests lower the limits. */
  limits?: Partial<Limits>
  /** Extra globals that point into the API (deprecation aliases). */
  aliases?: Record<string, string>
  audit?: (row: AuditRow) => void | Promise<void>
  onError?: (err: unknown, where: string) => void
  now?: () => number
  newRunId?: () => string
}

type Rejected = {
  ok: false
  error: { code: 'RATE_LIMITED' | 'VALIDATION'; message: string }
  logs: string[]
  calls: number
  ms: number
}

export type CodeOutcome = RunResult | Rejected

const rejected = (
  code: Rejected['error']['code'],
  message: string,
): Rejected => ({
  ok: false,
  error: { code, message },
  logs: [],
  calls: 0,
  ms: 0,
})

/**
 * `search` runs the code over `spec` (the API as data, with no access to anything); `execute` runs it with
 * `codemode.<product>.*` bound to the token's scopes and context. Both live in the sandbox adapter (SPEC §5).
 */
export async function runCode<Ctx>(
  env: RunEnv<Ctx>,
  principal: Principal<Ctx>,
  kind: WcmTool,
  code: string,
): Promise<CodeOutcome> {
  const ops: string[] = []
  let outcome: CodeOutcome
  if (code.length === 0) outcome = rejected('VALIDATION', 'Missing code to run')
  else if (code.length > MAX_CODE_CHARS)
    outcome = rejected(
      'VALIDATION',
      `Code is limited to ${MAX_CODE_CHARS / 1024} KB`,
    )
  else {
    const acquired = env.limiter.acquire(principal.tokenId)
    if (!acquired.ok) outcome = rejected('RATE_LIMITED', acquired.message)
    else {
      try {
        outcome =
          kind === 'search'
            ? await env.sandbox.run({
                code,
                host: {},
                data: {
                  spec: buildSpec(env.registry as Registry<never>, {
                    scopes: principal.scopes,
                  }),
                },
                limits: env.limits,
              })
            : await env.sandbox.run({
                code,
                name: 'codemode',
                host: env.registry.host(principal.scopes, principal.ctx, {
                  onCall: (id) => ops.push(id),
                  onError: (err, id) => env.onError?.(err, id),
                }),
                aliases: env.aliases,
                limits: env.limits,
              })
      } finally {
        acquired.slot.release()
      }
    }
  }
  if (env.audit) {
    const row: AuditRow = {
      runId: env.newRunId?.() ?? crypto.randomUUID(),
      product: env.registry.product,
      tokenId: principal.tokenId,
      agentLabel: principal.label ?? null,
      kind,
      ops,
      calls: outcome.calls,
      ms: outcome.ms,
      resultBytes: outcome.ok ? outcome.result.length : 0,
      truncated: outcome.ok ? outcome.truncated : false,
      errorCode: outcome.ok ? null : outcome.error.code,
      specVersion: env.registry.version,
      via: 'direct',
      createdAt: (env.now ?? Date.now)(),
    }
    try {
      await env.audit(row)
    } catch (err) {
      env.onError?.(err, 'audit')
    }
  }
  return outcome
}

/** Response body of `/codemode/*` and text of `tools/call`: the same for both transports. */
export function outcomeBody(outcome: CodeOutcome) {
  if (!outcome.ok)
    return {
      ok: false as const,
      error: outcome.error,
      logs: outcome.logs,
      calls: outcome.calls,
      ms: outcome.ms,
    }
  let result: unknown = outcome.result
  // A truncated result is no longer valid JSON: it is delivered as text.
  if (!outcome.truncated) {
    try {
      result = JSON.parse(outcome.result)
    } catch {
      result = outcome.result
    }
  }
  return {
    ok: true as const,
    result,
    truncated: outcome.truncated,
    logs: outcome.logs,
    calls: outcome.calls,
    ms: outcome.ms,
  }
}
