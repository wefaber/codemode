/**
 * How much sandbox one caller can trigger: one run at a time per key (the token), `perMinute` per minute per key and
 * a cap of Workers per process. In memory (lost on restart, like login attempts); there is no queue: when there is no
 * room, the run is rejected.
 */

export type LimiterOptions = {
  maxWorkers: number
  perMinute: number
}

export const DEFAULT_LIMITER: LimiterOptions = { maxWorkers: 4, perMinute: 60 }

const WINDOW_MS = 60_000

export type Slot = { release(): void }
export type Acquire = { ok: true; slot: Slot } | { ok: false; message: string }

export type Limiter = { acquire(key: string): Acquire }

export function createLimiter(
  opts: LimiterOptions = DEFAULT_LIMITER,
  now: () => number = Date.now,
): Limiter {
  const running = new Set<string>()
  const stamps = new Map<string, number[]>()
  let workers = 0
  return {
    acquire(key) {
      if (running.has(key))
        return {
          ok: false,
          message: 'A run is already in progress for this token',
        }
      const t = now()
      const recent = (stamps.get(key) ?? []).filter((s) => t - s < WINDOW_MS)
      if (recent.length >= opts.perMinute) {
        stamps.set(key, recent)
        return {
          ok: false,
          message: `Up to ${opts.perMinute} runs per minute per token`,
        }
      }
      if (workers >= opts.maxWorkers)
        return {
          ok: false,
          message: 'The server is busy with other runs; retry',
        }
      recent.push(t)
      stamps.set(key, recent)
      // A key that never comes back must not stay in the map forever.
      if (stamps.size > 1000)
        for (const [id, list] of stamps)
          if (list.every((s) => t - s >= WINDOW_MS)) stamps.delete(id)
      running.add(key)
      workers += 1
      let released = false
      return {
        ok: true,
        slot: {
          release() {
            if (released) return
            released = true
            running.delete(key)
            workers -= 1
          },
        },
      }
    },
  }
}
