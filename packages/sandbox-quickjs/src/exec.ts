import {
  codeOf,
  DEFAULT_LIMITS,
  type Limits,
  type RunResult,
} from '@wefaber/codemode'
import type { WorkerInit, WorkerOut } from './worker.ts'

/** After the QuickJS deadline the host waits this long and cuts the Worker. */
export const GRACE_MS = 1_000

export type ExecJob = {
  code: string
  name: string
  ops: string[]
  data?: Record<string, unknown>
  aliases?: Record<string, string>
  limits?: Limits
}

type Body =
  | { ok: true; value: unknown }
  | { ok: false; code: string; message: string }

/** Answers one sandbox operation; throws an `OpError` (or any `Error` with a string `code`) to fail it. */
export type CallHandler = (op: string, args: unknown[]) => unknown

const WORKER_URL = new URL('./worker.ts', import.meta.url).href

/**
 * Runs `job.code` in a Worker with QuickJS and serves its host calls with `handle`. Terminates the Worker on return
 * and, if it does not return in time, cuts it: the server never waits on agent code. Calls are counted again here:
 * the sandbox limit is not trusted to what runs on the other side.
 */
export function runInWorker(
  job: ExecJob,
  handle: CallHandler,
): Promise<RunResult> {
  const limits = job.limits ?? DEFAULT_LIMITS
  const started = performance.now()
  const ms = () => Math.round(performance.now() - started)
  const allowed = new Set(job.ops)
  let calls = 0

  return new Promise<RunResult>((resolve) => {
    const worker = new Worker(WORKER_URL, { smol: true })
    let settled = false
    const finish = (result: RunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate()
      resolve(result)
    }
    const fail = (
      code: 'TIMEOUT' | 'CODE_ERROR' | 'TOO_MANY_CALLS',
      message: string,
    ) =>
      finish({ ok: false, error: { code, message }, logs: [], calls, ms: ms() })

    const timer = setTimeout(
      () => fail('TIMEOUT', `Run exceeded ${limits.timeoutMs} ms`),
      limits.timeoutMs + GRACE_MS,
    )

    worker.onerror = (event) => {
      event.preventDefault?.()
      fail('CODE_ERROR', 'The sandbox ended with an error')
    }
    worker.onmessage = async (event: MessageEvent<WorkerOut>) => {
      const msg = event.data
      if (msg.type === 'done') return finish(msg.result)
      calls += 1
      const reply = (r: Body) => {
        if (!settled) worker.postMessage({ type: 'reply', id: msg.id, ...r })
      }
      if (calls > limits.maxCalls)
        return fail('TOO_MANY_CALLS', `More than ${limits.maxCalls} host calls`)
      if (!allowed.has(msg.op))
        return reply({
          ok: false,
          code: 'FORBIDDEN',
          message: `Operation ${msg.op} is not available`,
        })
      try {
        reply({ ok: true, value: await handle(msg.op, msg.args) })
      } catch (err) {
        reply({
          ok: false,
          code: codeOf(err) ?? 'HOST_ERROR',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const init: WorkerInit = {
      type: 'init',
      code: job.code,
      name: job.name,
      ops: job.ops,
      data: job.data,
      aliases: job.aliases,
      limits,
    }
    worker.postMessage(init)
  })
}
