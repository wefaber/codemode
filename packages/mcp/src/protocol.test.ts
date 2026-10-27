import { describe, expect, test } from 'bun:test'
import { harness } from '../../../tests/harness.ts'

const rpc = (id: number, method: string, params?: object) => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
})

describe('/mcp (stateless Streamable HTTP)', () => {
  test('initialize, tools/list is exactly search and execute, tools/call', async () => {
    const h = harness()
    const call = async (body: unknown) =>
      (await (await h.post('/mcp', 'write', body)).json()) as any

    const init = await call(
      rpc(1, 'initialize', { protocolVersion: '2025-03-26' }),
    )
    expect(init.result.protocolVersion).toBe('2025-03-26')
    expect(init.result.capabilities).toEqual({ tools: {} })
    expect(init.result.serverInfo.name).toBe('todo')
    expect(init.result.instructions).toContain('search')
    expect(
      (await call(rpc(2, 'initialize', { protocolVersion: '1999-01-01' })))
        .result.protocolVersion,
    ).toBe('2025-06-18')

    const list = await call(rpc(3, 'tools/list'))
    expect(list.result.tools.map((t: any) => t.name)).toEqual([
      'search',
      'execute',
    ])
    expect(list.result.tools[1].inputSchema.required).toEqual(['code'])

    const exec = await call(
      rpc(4, 'tools/call', {
        name: 'execute',
        arguments: {
          code: `const i = await codemode.todo.items.create({ title: 'por mcp' }); return i.title`,
        },
      }),
    )
    expect(exec.result.isError).toBe(false)
    expect(JSON.parse(exec.result.content[0].text)).toMatchObject({
      ok: true,
      result: 'por mcp',
      calls: 1,
    })

    const found = await call(
      rpc(5, 'tools/call', {
        name: 'search',
        arguments: {
          code: `return spec.ops.filter((o) => o.id === 'todo.items.create').length`,
        },
      }),
    )
    expect(JSON.parse(found.result.content[0].text).result).toBe(1)
  })

  test('a code failure comes back as isError, not as a protocol error', async () => {
    const h = harness()
    const res = (await (
      await h.post(
        '/mcp',
        'write',
        rpc(1, 'tools/call', {
          name: 'execute',
          arguments: { code: 'throw new Error("boom")' },
        }),
      )
    ).json()) as any
    expect(res.error).toBeUndefined()
    expect(res.result.isError).toBe(true)
    expect(JSON.parse(res.result.content[0].text).error.message).toContain(
      'boom',
    )
  })

  test('notifications 202, GET and DELETE 405, unknown methods and tools, broken JSON', async () => {
    const h = harness()
    const json = async (body: unknown) =>
      (await (await h.post('/mcp', 'write', body)).json()) as any
    expect(
      (
        await h.post('/mcp', 'write', {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        })
      ).status,
    ).toBe(202)
    for (const method of ['GET', 'DELETE'])
      expect((await h.post('/mcp', 'write', null, method)).status).toBe(405)
    expect((await json(rpc(1, 'resources/list'))).error.code).toBe(-32601)
    expect(
      (await json(rpc(2, 'tools/call', { name: 'rm', arguments: {} }))).error
        .code,
    ).toBe(-32602)
    expect(
      (await json(rpc(3, 'tools/call', { name: 'execute', arguments: {} })))
        .error.code,
    ).toBe(-32602)
    expect((await json('{not json')).error.code).toBe(-32700)
    expect((await json([rpc(1, 'ping')])).error.code).toBe(-32600)
    expect(await json(rpc(9, 'ping'))).toEqual({
      jsonrpc: '2.0',
      id: 9,
      result: {},
    })
  })

  test('no token is 401 and an unknown path is 404', async () => {
    const h = harness()
    expect((await h.post('/mcp', null, rpc(1, 'ping'))).status).toBe(401)
    expect((await h.post('/nope', 'write', {})).status).toBe(404)
  })
})
