import { describe, expect, test } from 'bun:test'
import { createLimiter } from './limiter.ts'

describe('limiter', () => {
  test('per-minute cap per key, sliding window', () => {
    let now = 1_000_000
    const limiter = createLimiter({ maxWorkers: 100, perMinute: 3 }, () => now)
    const go = (id: string) => {
      const r = limiter.acquire(id)
      if (r.ok) r.slot.release()
      return r.ok
    }
    expect([go('t'), go('t'), go('t'), go('t')]).toEqual([
      true,
      true,
      true,
      false,
    ])
    expect(go('other')).toBe(true)
    now += 59_000
    expect(go('t')).toBe(false)
    now += 2_000
    expect(go('t')).toBe(true)
  })

  test('a busy rejection does not count for the minute and releasing frees the slot', () => {
    const limiter = createLimiter({ maxWorkers: 4, perMinute: 2 }, () => 0)
    const first = limiter.acquire('t')
    expect(first.ok).toBe(true)
    expect(limiter.acquire('t').ok).toBe(false)
    expect(limiter.acquire('t').ok).toBe(false)
    if (first.ok) {
      first.slot.release()
      first.slot.release() // releasing twice does not free two slots
    }
    expect(limiter.acquire('t').ok).toBe(true)
  })

  test('the worker cap rejects instead of queueing', () => {
    const limiter = createLimiter({ maxWorkers: 1, perMinute: 100 }, () => 0)
    const one = limiter.acquire('a')
    expect(one.ok).toBe(true)
    expect(limiter.acquire('b').ok).toBe(false)
    if (one.ok) one.slot.release()
    expect(limiter.acquire('b').ok).toBe(true)
  })
})
