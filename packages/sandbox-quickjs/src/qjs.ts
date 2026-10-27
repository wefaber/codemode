import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSHandle,
} from 'quickjs-emscripten'
import {
  DEFAULT_LIMITS,
  type HostApi,
  type Limits,
  type RunResult,
  type SandboxErrorCode,
} from '@wefaber/codemode'

/**
 * QuickJS runner (SPEC §5). The agent's code runs in QuickJS compiled to wasm: no network, no filesystem, no `Bun`,
 * no `require`. The only way out is `host`, an object of async functions the caller provides.
 *
 * QuickJS polls the interrupt handler every N bytecode ops and does not meter big string builtins well
 * (`"x".repeat(1e6)` in a loop ran 12 s past a 2 s deadline, measured in the mychecklist spike). So production runs
 * execute this module inside a Bun Worker that the host can `terminate()` (see `exec.ts`): that is the hard deadline,
 * and it keeps the server's event loop free while the agent's code runs.
 */

export type RunOptions = {
  /** Name of the global that carries the host API (`host` by default). */
  name?: string
  /** JSON values exposed as read-only globals (`search` receives `spec`). */
  data?: Record<string, unknown>
  /** Extra globals that point into the host API: `{ checklist: 'codemode.checklist' }`. */
  aliases?: Record<string, string>
}

class LimitError extends Error {
  code: SandboxErrorCode
  constructor(code: SandboxErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** Evaluates JSON text inside the VM without going through the JS parser (`__proto__` is not object syntax). */
function parseJson(vm: QuickJSContext, json: string) {
  return vm.evalCode(`JSON.parse(${JSON.stringify(json)})`)
}

/** JSON text of a handle, or `null` text when the value has none (`undefined`, functions). */
function dumpJson(vm: QuickJSContext, handle: QuickJSHandle): string {
  const stringify = vm.getProp(vm.global, 'JSON')
  try {
    const fn = vm.getProp(stringify, 'stringify')
    try {
      const out = vm.callFunction(fn, stringify, handle)
      if (out.error) {
        const err = vm.dump(out.error)
        out.error.dispose()
        throw new Error(String(err?.message ?? err))
      }
      const type = vm.typeof(out.value)
      const text = type === 'string' ? vm.getString(out.value) : 'null'
      out.value.dispose()
      return text
    } finally {
      fn.dispose()
    }
  } finally {
    stringify.dispose()
  }
}

/**
 * Runs `code` as the body of an async function. The host API is exposed as a global (`host` unless `options.name`
 * says otherwise) next to `console.log` and the JSON globals of `options.data`.
 * The code returns its result with `return`.
 */
export async function runSandboxed(
  code: string,
  host: HostApi,
  limits: Limits = DEFAULT_LIMITS,
  options: RunOptions = {},
): Promise<RunResult> {
  const started = performance.now()
  const QuickJS = await getQuickJS()
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(limits.memoryBytes)
  runtime.setMaxStackSize(limits.stackBytes)
  const deadline = started + limits.timeoutMs
  runtime.setInterruptHandler(() => performance.now() > deadline)
  const vm = runtime.newContext()

  const logs: string[] = []
  let calls = 0
  let failure: LimitError | undefined
  const pending = new Set<Promise<unknown>>()
  // Every handle the run creates; QuickJS aborts on dispose if any is still alive.
  const owned: { alive: boolean; dispose(): void }[] = []
  let closed = false
  const ms = () => Math.round(performance.now() - started)

  try {
    // console.log -> logs (bounded)
    const consoleObj = vm.newObject()
    const log = vm.newFunction('log', (...args) => {
      if (logs.length < limits.maxConsoleLines) {
        logs.push(
          args
            .map((a) => {
              const v = vm.dump(a)
              return typeof v === 'string' ? v : JSON.stringify(v)
            })
            .join(' '),
        )
      }
    })
    vm.setProp(consoleObj, 'log', log)
    vm.setProp(vm.global, 'console', consoleObj)
    log.dispose()
    consoleObj.dispose()

    const install = (target: QuickJSHandle, api: HostApi) => {
      for (const [name, entry] of Object.entries(api)) {
        if (typeof entry === 'function') {
          const fn = vm.newFunction(name, (...argHandles) => {
            calls += 1
            if (calls > limits.maxCalls) {
              failure ??= new LimitError(
                'TOO_MANY_CALLS',
                `More than ${limits.maxCalls} host calls`,
              )
              throw new Error(failure.message)
            }
            const args = argHandles.map((h) => vm.dump(h))
            const deferred = vm.newPromise()
            owned.push(deferred)
            // A real `Error` (with `message`), not bare text: it is what the agent's code expects to catch.
            const rejectWith = (message: string) => {
              const error = vm.newError(message)
              deferred.reject(error)
              error.dispose()
            }
            const work = entry(...args)
              .then((value) => {
                if (closed) return
                const json = JSON.stringify(value ?? null)
                const handle = parseJson(vm, json)
                if (handle.error) {
                  handle.error.dispose()
                  rejectWith('Host returned a bad value')
                } else {
                  deferred.resolve(handle.value)
                  handle.value.dispose()
                }
              })
              .catch((err: unknown) => {
                if (closed) return
                const message = err instanceof Error ? err.message : String(err)
                rejectWith(message)
              })
              .finally(() => {
                pending.delete(work)
                if (!closed) runtime.executePendingJobs()
              })
            pending.add(work)
            return deferred.handle
          })
          vm.setProp(target, name, fn)
          fn.dispose()
        } else {
          const child = vm.newObject()
          install(child, entry)
          vm.setProp(target, name, child)
          child.dispose()
        }
      }
    }
    const hostObj = vm.newObject()
    install(hostObj, host)
    vm.setProp(vm.global, options.name ?? 'host', hostObj)
    hostObj.dispose()

    for (const [name, value] of Object.entries(options.data ?? {})) {
      const parsed = parseJson(vm, JSON.stringify(value ?? null))
      if (parsed.error) {
        parsed.error.dispose()
        return fail('CODE_ERROR', `Could not load ${name}`)
      }
      vm.setProp(vm.global, name, parsed.value)
      parsed.value.dispose()
    }

    for (const [alias, path] of Object.entries(options.aliases ?? {})) {
      if (
        !/^[A-Za-z_$][\w$]*$/.test(alias) ||
        !/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(path)
      )
        return fail('CODE_ERROR', `Invalid alias ${alias}`)
      const done = vm.evalCode(`globalThis.${alias} = ${path}`)
      if (done.error) {
        done.error.dispose()
        return fail('CODE_ERROR', `Invalid alias ${alias}`)
      }
      done.value.dispose()
    }

    const wrapped = `(async () => {\n${code}\n})()`
    const evaluated = vm.evalCode(wrapped, 'agent.js')
    if (evaluated.error) {
      const err = vm.dump(evaluated.error)
      evaluated.error.dispose()
      return fail('CODE_ERROR', String(err?.message ?? err))
    }
    const promise = evaluated.value
    owned.push(promise)

    // getPromiseState hands back a live handle once settled, so the polling check must release it.
    const isPending = () => {
      const probe = vm.getPromiseState(promise)
      if (probe.type === 'fulfilled') probe.value.dispose()
      else if (probe.type === 'rejected') probe.error.dispose()
      return probe.type === 'pending'
    }

    // Pump jobs and host calls until the promise settles or the deadline passes.
    while (isPending()) {
      if (failure) break
      if (performance.now() > deadline) {
        failure = new LimitError(
          'TIMEOUT',
          `Run exceeded ${limits.timeoutMs} ms`,
        )
        break
      }
      const jobs = runtime.executePendingJobs()
      if (jobs.error) {
        const err = vm.dump(jobs.error)
        jobs.error.dispose()
        return fail('CODE_ERROR', String(err?.message ?? err))
      }
      if (pending.size > 0) {
        await Promise.race([
          Promise.race(pending),
          new Promise((r) =>
            setTimeout(r, Math.max(1, deadline - performance.now())),
          ),
        ])
      } else if (jobs.value === 0) {
        break
      }
    }

    if (failure) return fail(failure.code, failure.message)

    const state = vm.getPromiseState(promise)
    if (state.type === 'pending') {
      return fail(
        performance.now() > deadline ? 'TIMEOUT' : 'CODE_ERROR',
        performance.now() > deadline
          ? `Run exceeded ${limits.timeoutMs} ms`
          : 'The code never finished',
      )
    }
    if (state.type === 'rejected') {
      const err = vm.dump(state.error)
      state.error.dispose()
      return fail('CODE_ERROR', String(err?.message ?? err))
    }
    const text = dumpJson(vm, state.value)
    state.value.dispose()
    const truncated = text.length > limits.maxResultChars
    return {
      ok: true,
      result: truncated ? text.slice(0, limits.maxResultChars) : text,
      truncated,
      logs,
      calls,
      ms: ms(),
    }
  } finally {
    closed = true
    for (const handle of owned) if (handle.alive) handle.dispose()
    vm.dispose()
    runtime.dispose()
  }

  function fail(code: SandboxErrorCode, message: string): RunResult {
    return { ok: false, error: { code, message }, logs, calls, ms: ms() }
  }
}
