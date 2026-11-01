import { describe, expect, test } from 'bun:test'
import { buildSpec, type Registry } from '@wefaber/codemode'
import { createQuickJsSandbox } from '@wefaber/codemode-sandbox-quickjs'
import { todoRegistry } from '../../../tests/fixtures/todo.ts'
import { createCallBudget } from './calls.ts'
import type { GatewayConfig } from './config.ts'
import { openDb } from './db.ts'
import { createGateway } from './gateway.ts'

const MINUTE = 60_000
const T0 = 1_800_000_000_000

describe('call budget (SQLite, fixed one-minute window)', () => {
  test('allows up to the limit and refuses the next call', () => {
    const budget = createCallBudget(openDb(':memory:'), 3, () => T0)
    expect([1, 2, 3, 4].map(() => budget.take('a'))).toEqual([
      true,
      true,
      true,
      false,
    ])
    // a refused call stays refused until the window changes
    expect(budget.take('a')).toBe(false)
  })

  test('the window restarts with the next minute', () => {
    let t = T0
    const budget = createCallBudget(openDb(':memory:'), 2, () => t)
    budget.take('a')
    budget.take('a')
    expect(budget.take('a')).toBe(false)
    t += MINUTE
    expect(budget.take('a')).toBe(true)
    expect(budget.take('a')).toBe(true)
    expect(budget.take('a')).toBe(false)
  })

  test('each token has its own count', () => {
    const budget = createCallBudget(openDb(':memory:'), 1, () => T0)
    expect(budget.take('a')).toBe(true)
    expect(budget.take('a')).toBe(false)
    expect(budget.take('b')).toBe(true)
  })

  test('the count lives in the database: another budget on the same db and a restart see it', () => {
    const db = openDb(':memory:')
    createCallBudget(db, 2, () => T0).take('a')
    const second = createCallBudget(db, 2, () => T0)
    expect(second.take('a')).toBe(true)
    expect(createCallBudget(db, 2, () => T0).take('a')).toBe(false)
  })

  test('old windows are pruned', () => {
    let t = T0
    const db = openDb(':memory:')
    const budget = createCallBudget(db, 5, () => t)
    budget.take('a')
    t += 3 * MINUTE
    budget.take('a')
    const rows = db.query('SELECT minute FROM call_usage').all()
    expect(rows).toEqual([{ minute: Math.floor(t / MINUTE) }])
  })
})

describe('gateway: product calls per minute', () => {
  const config = (callsPerMinute: number): GatewayConfig => ({
    port: 0,
    dbPath: ':memory:',
    secret: 'g'.repeat(40),
    runTimeoutMs: 8_000,
    productTimeoutMs: 3_000,
    perMinute: 1_000,
    callsPerMinute,
    maxBytesPerDay: 1_000_000,
  })

  function setup(callsPerMinute: number) {
    let t = T0
    let reached = 0
    const db = openDb(':memory:')
    const gw = createGateway({
      db,
      config: config(callsPerMinute),
      sandbox: createQuickJsSandbox(),
      now: () => t,
      fetch: (async () => {
        reached += 1
        return Response.json({ ok: true, result: [] })
      }) as unknown as typeof fetch,
    })
    gw.catalog.publish(
      buildSpec(todoRegistry as Registry<never>),
      'http://todo.test',
    )
    const a = gw.tokens.create({ label: 'a', scopes: ['todo:write'] }).token
    const b = gw.tokens.create({ label: 'b', scopes: ['todo:write'] }).token
    const run = async (token: string, code: string) => {
      const res = await gw.handler(
        new Request('https://gw.test/codemode/execute', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ code }),
        }),
      )
      return (await res.json()) as {
        ok: boolean
        result?: unknown
        error?: { code: string; message: string }
      }
    }
    return {
      run,
      a,
      b,
      db,
      advance: (ms: number) => void (t += ms),
      reached: () => reached,
    }
  }

  /** Calls `n` times, swallowing the refusal so the code can report how it ended. */
  const callTimes = (n: number) => `
    const out = []
    for (let i = 0; i < ${n}; i++) {
      try { await codemode.todo.items.list({}); out.push('ok') }
      catch (e) { out.push(e.message) }
    }
    return out
  `

  test('over the limit a call fails with RATE_LIMITED and does not reach the product', async () => {
    const w = setup(3)
    const { body } = await w.run(w.a, callTimes(5)).then((body) => ({ body }))
    const out = body.result as string[]
    expect(out.slice(0, 3)).toEqual(['ok', 'ok', 'ok'])
    for (const message of out.slice(3)) {
      expect(message).toContain('RATE_LIMITED')
      expect(message).toContain('3 product calls per minute')
    }
    expect(w.reached()).toBe(3)
    // only the calls that went through are audited
    const row = w.db.query('SELECT ops FROM runs').get() as { ops: string }
    expect(JSON.parse(row.ops)).toHaveLength(3)
  })

  test('uncaught, the refusal ends the run with the code in the message', async () => {
    const w = setup(1)
    const body = await w.run(
      w.a,
      `await codemode.todo.items.list({}); return await codemode.todo.items.list({})`,
    )
    expect(body.ok).toBe(false)
    expect(body.error?.message).toContain('RATE_LIMITED')
  })

  test('the count spans runs: the next run of the same token starts exhausted', async () => {
    const w = setup(2)
    await w.run(w.a, callTimes(2))
    const second = await w.run(w.a, callTimes(1))
    expect((second.result as string[])[0]).toContain('RATE_LIMITED')
    expect(w.reached()).toBe(2)
  })

  test('the next minute the token can call again', async () => {
    const w = setup(2)
    await w.run(w.a, callTimes(3))
    w.advance(MINUTE)
    const again = await w.run(w.a, callTimes(2))
    expect(again.result).toEqual(['ok', 'ok'])
    expect(w.reached()).toBe(4)
  })

  test('another token is not affected', async () => {
    const w = setup(2)
    await w.run(w.a, callTimes(5))
    const other = await w.run(w.b, callTimes(2))
    expect(other.result).toEqual(['ok', 'ok'])
  })
})
