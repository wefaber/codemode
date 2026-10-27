import { describe, expect, test } from 'bun:test'
import { DEFAULT_LIMITS } from '@wefaber/codemode'
import { createLimiter, DEFAULT_LIMITER } from '@wefaber/codemode-mcp'
import { harness } from '../harness.ts'

/** Mandatory escape and limit tests (SPEC §5). They block the merge: they run the real Worker, not a mock. */

describe('sandbox: escape', () => {
  test('no network, filesystem, Bun, Node or Worker environment', async () => {
    const h = harness()
    const names = [
      'fetch',
      'Bun',
      'process',
      'require',
      'module',
      'exports',
      'XMLHttpRequest',
      'WebSocket',
      'setTimeout',
      'setInterval',
      'Worker',
      'self',
      'window',
      'document',
      'postMessage',
      'onmessage',
      'WebAssembly',
      'host',
      'spec',
    ]
    const r = await h.exec(
      'write',
      `return Object.fromEntries(${JSON.stringify(names)}.map((n) => [n, typeof globalThis[n]]))`,
    )
    expect(r.body.ok).toBe(true)
    for (const name of names) expect(r.body.result[name]).toBe('undefined')
  })

  test('Function constructors do not lead to a wider global', async () => {
    const h = harness()
    const r = await h.exec(
      'write',
      `return {
         fn: (function () {}).constructor('return typeof process + typeof Bun + typeof require')(),
         global: globalThis.constructor.constructor('return typeof process')(),
         host: codemode.todo.items.list.constructor('return typeof Bun')(),
         eval: eval('typeof process + typeof fetch'),
         thisFn: new Function('return typeof this.process')(),
       }`,
    )
    expect(r.body.ok).toBe(true)
    expect(r.body.result).toEqual({
      fn: 'undefinedundefinedundefined',
      global: 'undefined',
      host: 'undefined',
      eval: 'undefinedundefined',
      thisFn: 'undefined',
    })
  })

  test('dynamic import never loads a module', async () => {
    const h = harness()
    for (const spec of [
      'node:fs',
      'fs',
      'bun',
      'bun:sqlite',
      'file:///etc/passwd',
      'https://example.com/x.js',
    ]) {
      const r = await h.exec(
        'write',
        `try { const m = await import(${JSON.stringify(spec)}); return 'loaded:' + Object.keys(m).join(',') } catch (e) { return 'blocked' }`,
      )
      if (r.body.ok) expect(r.body.result).toBe('blocked')
      else expect(r.body.error.code).toBe('CODE_ERROR')
    }
  })

  test('the codemode object is native functions only: no token, no store, no context', async () => {
    const h = harness()
    const r = await h.exec(
      'write',
      `const seen = [];
       const walk = (o, path) => {
         for (const k of Object.getOwnPropertyNames(o)) {
           const v = o[k];
           if (typeof v === 'function') seen.push([path + k, String(v)]);
           else if (v && typeof v === 'object') walk(v, path + k + '.');
           else seen.push([path + k, typeof v]);
         }
       };
       walk(codemode, '');
       return { keys: Object.keys(codemode), seen }`,
    )
    expect(r.body.ok).toBe(true)
    expect(r.body.result.keys).toEqual(['todo'])
    const dump = JSON.stringify(r.body.result)
    expect(dump).not.toMatch(/t-write|token|secret|store|scopes/i)
    for (const [, text] of r.body.result.seen as string[][])
      expect(text).toContain('native code')
  })

  test('every run starts clean: nothing leaks from one to the next', async () => {
    const h = harness()
    const first = await h.exec(
      'write',
      `Object.prototype.polluted = 'x'; Array.prototype.at = () => 'broken'; globalThis.leak = 42; return 1`,
    )
    expect(first.body.ok).toBe(true)
    const second = await h.exec(
      'write',
      `return [typeof leak, ({}).polluted ?? null, [1, 2].at(-1)]`,
    )
    expect(second.body.result).toEqual(['undefined', null, 2])
  })

  test('the code cannot pass a tenancy parameter: the schema rejects extra keys', async () => {
    const h = harness()
    const r = await h.exec(
      'write',
      `return await codemode.todo.items.list({ orgId: 'x' })`,
    )
    expect(r.body.ok).toBe(false)
    expect(r.body.error.message).toContain('VALIDATION')
  })
})

describe('sandbox: limits', () => {
  test('an infinite loop is cut by time', async () => {
    const h = harness()
    const r = await h.exec('write', 'while (true) {}')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(false)
    expect(['TIMEOUT', 'CODE_ERROR']).toContain(r.body.error.code)
    expect(r.body.ms).toBeLessThan(2_500)
  })

  test('a builtin QuickJS does not meter is cut by terminate() and the event loop stays alive', async () => {
    const h = harness()
    let ticks = 0
    const timer = setInterval(() => (ticks += 1), 50)
    const started = performance.now()
    const r = await h.exec(
      'write',
      `for (;;) { 'x'.repeat(1e6).split('').length }`,
    )
    clearInterval(timer)
    expect(r.body.ok).toBe(false)
    expect(['TIMEOUT', 'CODE_ERROR']).toContain(r.body.error.code)
    expect(performance.now() - started).toBeLessThan(3_500)
    expect(ticks).toBeGreaterThan(8)
  })

  test('a memory explosion is cut', async () => {
    const h = harness({
      limits: { memoryBytes: 8 * 1024 * 1024, timeoutMs: 2_000 },
    })
    const r = await h.exec(
      'write',
      'const a = []; while (true) a.push({ k: a.length, s: "x".repeat(100) })',
    )
    expect(r.body.ok).toBe(false)
  })

  test('more than maxCalls host calls ends the run', async () => {
    const h = harness({ limits: { ...DEFAULT_LIMITS, timeoutMs: 3_000 } })
    const r = await h.exec(
      'write',
      `for (let i = 0; i < 60; i++) await codemode.todo.items.list(); return 'reached'`,
    )
    expect(r.body.ok).toBe(false)
    expect(r.body.error.code).toBe('TOO_MANY_CALLS')
    expect(r.body.calls).toBeGreaterThan(50)
  })

  test('the call counter cannot be dodged by catching the exception', async () => {
    const h = harness({ limits: { maxCalls: 3, timeoutMs: 1_000 } })
    const r = await h.exec(
      'write',
      `let n = 0; for (let i = 0; i < 200; i++) { try { await codemode.todo.items.list(); n++ } catch (e) {} } return n`,
    )
    expect(r.body.ok).toBe(false)
    expect(r.body.error.code).toBe('TOO_MANY_CALLS')
  })

  test('a huge result is truncated and says so', async () => {
    const h = harness()
    const r = await h.exec('write', `return 'x'.repeat(200000)`)
    expect(r.body.ok).toBe(true)
    expect(r.body.truncated).toBe(true)
    expect(String(r.body.result)).toHaveLength(64 * 1024)
  })

  test('the console is capped at 200 lines', async () => {
    const h = harness()
    const r = await h.exec(
      'write',
      `for (let i = 0; i < 1000; i++) console.log('line', i); return 1`,
    )
    expect(r.body.ok).toBe(true)
    expect(r.body.logs).toHaveLength(200)
  })

  test('too long code, a huge body or no code are rejected', async () => {
    const h = harness()
    const long = await h.post('/codemode/execute', 'write', {
      code: `return 1 // ${'x'.repeat(33 * 1024)}`,
    })
    expect(long.status).toBe(400)
    expect(((await long.json()) as any).error.code).toBe('VALIDATION')
    const huge = await h.post('/codemode/execute', 'write', {
      code: 'x'.repeat(70 * 1024),
    })
    expect(huge.status).toBe(413)
    expect((await h.post('/codemode/execute', 'write', {})).status).toBe(400)
    expect(
      (await h.post('/codemode/execute', 'write', 'not json')).status,
    ).toBe(400)
  })

  test('a second run with the same token while the first runs is 429', async () => {
    const h = harness({ limits: { timeoutMs: 3_000 } })
    const slow = h.exec(
      'write',
      `const t = Date.now(); while (Date.now() - t < 500) {} return 'slow'`,
    )
    await Bun.sleep(150)
    const second = await h.exec('write', 'return 1')
    expect(second.status).toBe(429)
    expect(second.body.error.code).toBe('RATE_LIMITED')
    expect((await slow).body.result).toBe('slow')
    expect((await h.exec('write', 'return 2')).body.result).toBe(2)
  })

  test('the per-process worker cap rejects instead of queueing', async () => {
    const h = harness({
      limits: { timeoutMs: 3_000 },
      limiter: createLimiter({ ...DEFAULT_LIMITER, maxWorkers: 1 }),
    })
    const slow = h.exec(
      'write',
      `const t = Date.now(); while (Date.now() - t < 500) {} return 1`,
    )
    await Bun.sleep(150)
    const blocked = await h.exec('other', 'return 2')
    expect(blocked.status).toBe(429)
    expect(blocked.body.error.message).toContain('busy')
    await slow
    expect((await h.exec('other', 'return 3')).body.result).toBe(3)
  })

  test('search goes through the same limits', async () => {
    const h = harness()
    const r = await h.exec('write', 'while (true) {}', 'search')
    expect(r.body.ok).toBe(false)
  })
})
