import { describe, expect, test } from 'bun:test'
import { harness } from '../harness.ts'

/** Scope, audit, error and alias contract of SPEC R5, R9, R10 and R12. */

describe('scope', () => {
  test('a read token does not even have the write operations', async () => {
    const h = harness()
    const r = await h.exec(
      'read',
      `return [typeof codemode.todo.items.create, typeof codemode.todo.items.list, Object.keys(codemode.todo.items).sort()]`,
    )
    expect(r.body.result).toEqual([
      'undefined',
      'function',
      ['boom', 'get', 'list'],
    ])
    const write = await h.exec(
      'read',
      `return await codemode.todo.items.create({ title: 'no' })`,
    )
    expect(write.body.ok).toBe(false)
    expect(write.body.error.code).toBe('CODE_ERROR')
    expect(write.body.error.message).toContain('not a function')
    expect(h.store.size).toBe(0)
  })

  test('search shows a read token only what it can call', async () => {
    const h = harness()
    const r = await h.exec(
      'read',
      `return spec.ops.map((o) => o.id).sort()`,
      'search',
    )
    expect(r.body.result).toEqual([
      'todo.items.boom',
      'todo.items.get',
      'todo.items.list',
    ])
  })

  test('search returns only what the code asks for', async () => {
    const h = harness()
    const r = await h.exec(
      'write',
      `return spec.ops.filter((o) => o.id.endsWith('.create')).map((o) => o.summary)`,
      'search',
    )
    expect(r.body.result).toEqual(['Creates an item. Returns the item.'])
    expect(JSON.stringify(r.body).length).toBeLessThan(2_048)
  })
})

describe('errors', () => {
  test('a domain error crosses with its code, an internal one does not leak', async () => {
    const h = harness()
    const r = await h.exec(
      'write',
      `const out = {};
       try { await codemode.todo.items.get({ id: 'nope' }) } catch (e) { out.domain = e.message }
       try { await codemode.todo.items.boom() } catch (e) { out.internal = e.message }
       return out`,
    )
    expect(r.body.result.domain).toContain('NOT_FOUND')
    expect(r.body.result.internal).toContain('HOST_ERROR')
    expect(JSON.stringify(r.body)).not.toContain('secret stack detail')
    expect(h.errors).toHaveLength(1)
  })
})

describe('audit', () => {
  test('every run leaves a row with ops, calls and the error code', async () => {
    const h = harness()
    await h.exec(
      'write',
      `const i = await codemode.todo.items.create({ title: 'a' }); return await codemode.todo.items.get({ id: i.id })`,
    )
    await h.exec(
      'write',
      `return await codemode.todo.items.get({ id: 'nope' })`,
    )
    await h.exec('read', `return 1`, 'search')
    await h.exec('write', 'return (')
    const [ok, domain, search, syntax] = h.audit
    expect(h.audit).toHaveLength(4)
    expect(ok).toMatchObject({
      product: 'todo',
      tokenId: 't-write',
      agentLabel: 'writer',
      kind: 'execute',
      ops: ['todo.items.create', 'todo.items.get'],
      calls: 2,
      errorCode: null,
      specVersion: '1.0.0',
      via: 'direct',
    })
    expect(ok!.runId).toMatch(/^[0-9a-f-]{36}$/)
    expect(domain).toMatchObject({
      ops: ['todo.items.get'],
      errorCode: 'CODE_ERROR',
    })
    expect(search).toMatchObject({ kind: 'search', tokenId: 't-read', ops: [] })
    expect(syntax!.errorCode).toBe('CODE_ERROR')
  })

  test('a rejected run is audited too', async () => {
    const h = harness()
    await h.exec('write', '')
    expect(h.audit[0]).toMatchObject({ errorCode: 'VALIDATION', calls: 0 })
  })

  test('an audit failure does not fail the run and is reported', async () => {
    const h = harness({ failAudit: true })
    const r = await h.exec('write', 'return 7')
    expect(r.body.result).toBe(7)
    expect(h.errors).toHaveLength(1)
  })
})

describe('aliases', () => {
  test('a deprecation alias points into the same API', async () => {
    const h = harness({ aliases: { todo: 'codemode.todo' } })
    const r = await h.exec(
      'write',
      `const i = await todo.items.create({ title: 'x' }); return [i.title, typeof codemode.todo.items.create]`,
    )
    expect(r.body.result).toEqual(['x', 'function'])
  })

  test('an invalid alias is a CODE_ERROR, not an injection', async () => {
    const h = harness({ aliases: { 'a;b': 'codemode.todo' } })
    const r = await h.exec('write', 'return 1')
    expect(r.body.ok).toBe(false)
    expect(r.body.error.code).toBe('CODE_ERROR')
  })
})
