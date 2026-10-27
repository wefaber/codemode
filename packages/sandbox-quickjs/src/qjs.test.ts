import { describe, expect, test } from 'bun:test'
import { DEFAULT_LIMITS, type HostApi } from '@wefaber/codemode'
import { runSandboxed } from './qjs.ts'

const none: HostApi = {}

describe('sandbox (QuickJS)', () => {
  test('devuelve lo que el código retorna, como JSON', async () => {
    const r = await runSandboxed('return { a: 1 + 2, b: [1, 2] }', none)
    expect(r).toMatchObject({ ok: true, result: '{"a":3,"b":[1,2]}' })
  })

  test('console.log queda en logs', async () => {
    const r = await runSandboxed('console.log("hola", 2); return 1', none)
    expect(r.logs).toEqual(['hola 2'])
  })

  test('encadena varias llamadas al host en una sola ejecución', async () => {
    const host: HostApi = {
      items: {
        create: async (title) => ({ id: `id-${String(title)}` }),
        list: async () => [{ id: 'x' }, { id: 'y' }],
      },
    }
    const r = await runSandboxed(
      `const before = await host.items.list();
       const made = [];
       for (const t of ["a", "b", "c"]) made.push(await host.items.create(t));
       return { before: before.length, made: made.map((m) => m.id) }`,
      host,
    )
    expect(r).toMatchObject({
      ok: true,
      result: '{"before":2,"made":["id-a","id-b","id-c"]}',
      calls: 4,
    })
  })

  test('un error del host llega al código como excepción', async () => {
    const host: HostApi = {
      boom: async () => {
        throw new Error('FORBIDDEN')
      },
    }
    const r = await runSandboxed(
      'try { await host.boom() } catch (e) { return [e instanceof Error, e.message] } return "no"',
      host,
    )
    expect(r).toMatchObject({ ok: true, result: '[true,"FORBIDDEN"]' })
  })

  test('no existen fetch, Bun, require, process ni import dinámico de red', async () => {
    const r = await runSandboxed(
      `return [typeof fetch, typeof Bun, typeof require, typeof process, typeof XMLHttpRequest, typeof WebSocket, typeof setTimeout]`,
      none,
    )
    expect(r).toMatchObject({
      ok: true,
      result:
        '["undefined","undefined","undefined","undefined","undefined","undefined","undefined"]',
    })
  })

  test('un bucle infinito se corta por tiempo', async () => {
    const r = await runSandboxed('while (true) {}', none, {
      ...DEFAULT_LIMITS,
      timeoutMs: 200,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(['TIMEOUT', 'CODE_ERROR']).toContain(r.error.code)
    expect(r.ms).toBeLessThan(2_000)
  })

  test('una explosión de memoria se corta', async () => {
    const r = await runSandboxed(
      'const a = []; while (true) a.push({ k: a.length })',
      none,
      { ...DEFAULT_LIMITS, memoryBytes: 8 * 1024 * 1024, timeoutMs: 2_000 },
    )
    expect(r.ok).toBe(false)
  })

  test('más de maxCalls llamadas al host corta la ejecución', async () => {
    const host: HostApi = { ping: async () => 1 }
    const r = await runSandboxed(
      'for (let i = 0; i < 10; i++) await host.ping(); return 1',
      host,
      { ...DEFAULT_LIMITS, maxCalls: 3 },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('TOO_MANY_CALLS')
  })

  test('un resultado enorme se trunca y avisa', async () => {
    const r = await runSandboxed('return "x".repeat(5000)', none, {
      ...DEFAULT_LIMITS,
      maxResultChars: 100,
    })
    expect(r).toMatchObject({ ok: true, truncated: true })
    if (r.ok) expect(r.result).toHaveLength(100)
  })

  test('un error de sintaxis se informa como CODE_ERROR', async () => {
    const r = await runSandboxed('return (', none)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('CODE_ERROR')
  })

  test('latencia de una ejecución trivial (spike M0)', async () => {
    await runSandboxed('return 1', none) // carga el wasm
    const r = await runSandboxed('return 1', none)
    console.log(`quickjs trivial run: ${r.ms} ms`)
    expect(r.ms).toBeLessThan(500)
  })
})
