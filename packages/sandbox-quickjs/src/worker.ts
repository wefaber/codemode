import type { HostApi, Limits, RunResult } from '@wefaber/codemode'
import { runSandboxed } from './qjs.ts'

/**
 * Worker entry (SPEC §5). Runs QuickJS with the agent's code and has no access to anything on the server: the only
 * way out is `postMessage`. Every operation travels to the host as a `call` message and the host (which holds the
 * token's scope) answers with `reply`. The host can `terminate()` this Worker at any time: that is the hard deadline
 * QuickJS cannot guarantee by itself.
 */

export type WorkerInit = {
  type: 'init'
  code: string
  /** Name of the global that carries the API (`codemode`). */
  name: string
  /** Operations that exist in the object, e.g. `checklist.items.create`. */
  ops: string[]
  data?: Record<string, unknown>
  aliases?: Record<string, string>
  limits: Limits
}

export type WorkerReply =
  | { type: 'reply'; id: number; ok: true; value: unknown }
  | { type: 'reply'; id: number; ok: false; code: string; message: string }

export type WorkerOut =
  | { type: 'call'; id: number; op: string; args: unknown[] }
  | { type: 'done'; result: RunResult }

declare const self: {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage(message: WorkerOut): void
}

const waiting = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void }
>()
let nextId = 0

function remote(op: string) {
  return (...args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++
      waiting.set(id, { resolve, reject })
      self.postMessage({ type: 'call', id, op, args })
    })
}

/** `['checklist.items.create']` becomes `{ checklist: { items: { create } } }`. */
function hostApi(ops: string[]): HostApi {
  const api: HostApi = {}
  for (const op of ops) {
    const path = op.split('.')
    let bucket = api
    for (const part of path.slice(0, -1))
      bucket = (bucket[part] ??= {}) as HostApi
    bucket[path.at(-1)!] = remote(op)
  }
  return api
}

self.onmessage = (event) => {
  const msg = event.data as WorkerInit | WorkerReply
  if (msg.type === 'reply') {
    const entry = waiting.get(msg.id)
    if (!entry) return
    waiting.delete(msg.id)
    if (msg.ok) entry.resolve(msg.value)
    else entry.reject(new Error(`${msg.code}: ${msg.message}`))
    return
  }
  void runSandboxed(msg.code, hostApi(msg.ops), msg.limits, {
    name: msg.name,
    data: msg.data,
    aliases: msg.aliases,
  }).then((result) => self.postMessage({ type: 'done', result }))
}
