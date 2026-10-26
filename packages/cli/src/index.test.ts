import { describe, expect, test } from 'bun:test'
import { harness } from '../../../tests/harness.ts'
import { runStdio } from './index.ts'

/** Drives the stdio bridge against the real handler: initialize, tools/list and a tools/call that creates an item. */
async function session(lines: unknown[], token = 'write') {
  const h = harness()
  const out: string[] = []
  await runStdio({
    url: 'https://todo.test',
    token,
    product: 'todo',
    input: [lines.map((l) => `${JSON.stringify(l)}\n`).join('')],
    write: (line) => out.push(line),
    fetch: ((url: string, init: RequestInit) =>
      h.handler(new Request(url, init))) as unknown as typeof fetch,
  })
  return { h, replies: out.map((l) => JSON.parse(l)) }
}

describe('codemode-cli', () => {
  test('lists exactly two tools and forwards execute to /codemode/execute', async () => {
    const { h, replies } = await session([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'execute',
          arguments: {
            code: `return (await codemode.todo.items.create({ title: 'cli' })).title`,
          },
        },
      },
    ])
    expect(replies).toHaveLength(3) // the notification gets no reply
    expect(replies[0].result.serverInfo.name).toBe('todo')
    expect(
      replies[1].result.tools.map((t: { name: string }) => t.name),
    ).toEqual(['search', 'execute'])
    expect(JSON.parse(replies[2].result.content[0].text)).toMatchObject({
      ok: true,
      result: 'cli',
    })
    expect(h.store.size).toBe(1)
  })

  test('a bad token comes back as an error result and a broken line as a parse error', async () => {
    const { replies } = await session(
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'search', arguments: { code: 'return 1' } },
        },
      ],
      'nope',
    )
    expect(replies[0].result.isError).toBe(true)
    expect(JSON.parse(replies[0].result.content[0].text).error.code).toBe(
      'UNAUTHENTICATED',
    )

    const out: string[] = []
    await runStdio({
      url: 'https://x',
      input: ['{broken\n'],
      write: (l) => out.push(l),
    })
    expect(JSON.parse(out[0]!).error.code).toBe(-32700)
  })

  test('an unreachable product is PRODUCT_UNAVAILABLE', async () => {
    const out: string[] = []
    await runStdio({
      url: 'https://down.test',
      input: [
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute', arguments: { code: 'return 1' } } })}\n`,
      ],
      write: (l) => out.push(l),
      fetch: (() =>
        Promise.reject(
          new Error('connect ECONNREFUSED'),
        )) as unknown as typeof fetch,
    })
    expect(
      JSON.parse(JSON.parse(out[0]!).result.content[0].text).error.code,
    ).toBe('PRODUCT_UNAVAILABLE')
  })
})
