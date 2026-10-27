import {
  DEFAULT_LIMITS,
  type HostApi,
  type HostFn,
  type RunInput,
  type RunResult,
  type Sandbox,
} from '@wefaber/codemode'
import { runInWorker } from './exec.ts'

/** Dotted paths of every function in `host`: `{ a: { b } }` gives `['a.b']`. */
export function collectOps(host: HostApi, prefix = ''): string[] {
  return Object.entries(host).flatMap(([name, entry]) =>
    typeof entry === 'function'
      ? [`${prefix}${name}`]
      : collectOps(entry, `${prefix}${name}.`),
  )
}

function resolveOp(host: HostApi, path: string): HostFn | undefined {
  let node: HostApi | HostFn | undefined = host
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = Object.hasOwn(node, part) ? node[part] : undefined
  }
  return typeof node === 'function' ? node : undefined
}

/**
 * The `quickjs` adapter (SPEC §5): QuickJS in a terminable Bun Worker. Default for products that live on the VPS.
 * The host functions stay on the calling thread; the Worker only sees their names.
 */
export function createQuickJsSandbox(): Sandbox {
  return {
    run(input: RunInput): Promise<RunResult> {
      const { host } = input
      return runInWorker(
        {
          code: input.code,
          name: input.name ?? 'host',
          ops: collectOps(host),
          data: input.data,
          aliases: input.aliases,
          limits: { ...DEFAULT_LIMITS, ...input.limits },
        },
        (op, args) => {
          const fn = resolveOp(host, op)
          if (!fn) throw new Error(`Operation ${op} is not available`)
          return fn(...args)
        },
      )
    },
  }
}
