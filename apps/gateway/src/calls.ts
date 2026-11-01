import type { Database } from 'bun:sqlite'

const WINDOW_MS = 60_000

export type CallBudget = {
  /** Counts one call to a product against the token's current minute. `false` when the minute is already used up. */
  take(tokenHash: string): boolean
}

/**
 * Calls to products per minute per token (SPEC §8). A fixed window in SQLite (`call_usage`): it survives a restart
 * and is shared by every process on the same database, unlike the in-memory run limiter. The count and the check are
 * one statement, so concurrent calls of a token cannot both take the last slot.
 */
export function createCallBudget(
  db: Database,
  perMinute: number,
  now: () => number = Date.now,
): CallBudget {
  // The WHERE of the upsert is the check: at the limit nothing is written and no row comes back.
  const take = db.prepare<{ calls: number }, [string, number, number]>(
    `INSERT INTO call_usage (token_hash, minute, calls) VALUES (?, ?, 1)
     ON CONFLICT(token_hash, minute) DO UPDATE SET calls = calls + 1 WHERE calls < ?
     RETURNING calls`,
  )
  const prune = db.prepare('DELETE FROM call_usage WHERE minute < ?')
  let pruned = -1
  return {
    take(tokenHash) {
      const minute = Math.floor(now() / WINDOW_MS)
      // Old windows are dead weight: clear them once per minute, not per call.
      if (pruned !== minute) {
        prune.run(minute)
        pruned = minute
      }
      return take.get(tokenHash, minute, perMinute) !== null
    },
  }
}
