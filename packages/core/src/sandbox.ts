import type { Limits } from './limits.ts'

export type HostFn = (...args: unknown[]) => Promise<unknown>
/** Nested namespaces of host functions: `{ items: { create } }` becomes `host.items.create(...)` in the sandbox. */
export type HostApi = { [name: string]: HostFn | HostApi }

export type SandboxErrorCode =
  | 'TIMEOUT'
  | 'TOO_MANY_CALLS'
  | 'CODE_ERROR'
  | 'HOST_ERROR'

export type RunResult =
  | {
      ok: true
      /** JSON text of what the code returned (`undefined` becomes `null`). */
      result: string
      truncated: boolean
      logs: string[]
      calls: number
      ms: number
    }
  | {
      ok: false
      error: { code: SandboxErrorCode; message: string }
      logs: string[]
      calls: number
      ms: number
    }

export type RunInput = {
  /** Body of an async function. The code returns its result with `return`. */
  code: string
  /** Namespaces of functions with the scope already applied. */
  host: HostApi
  limits?: Partial<Limits>
  /** Name of the global that carries `host` (`host` by default; Code Mode uses `codemode`). */
  name?: string
  /** JSON values exposed as read-only globals (`search` receives `spec`). */
  data?: Record<string, unknown>
  /** Extra globals that point into `host`: `{ checklist: 'codemode.checklist' }` (deprecation aliases). */
  aliases?: Record<string, string>
}

/** The sandbox contract (SPEC §5). Adapters: `quickjs`, `quickjs-wasm`, `dynamic-workers`. */
export interface Sandbox {
  run(input: RunInput): Promise<RunResult>
}
