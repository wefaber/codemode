import { describe, expect, test } from 'bun:test'
import { Type } from '@sinclair/typebox'
import { allows, createRegistry, defineOp, OpError } from './index.ts'

const base = {
  summary: 's',
  input: Type.Object({}),
  output: Type.Null(),
  handler: () => null,
}

describe('defineOp', () => {
  test('rejects ids that are not product.resource.verb', () => {
    for (const id of [
      'items.list',
      'a.b',
      'Todo.items.list',
      'todo.items.1x',
      'todo.items.list.x',
    ])
      expect(() => defineOp({ ...base, id, scope: 'todo:read' })).toThrow(
        /Invalid op id/,
      )
  })

  test('rejects a verb outside the base set without verbException', () => {
    expect(() =>
      defineOp({ ...base, id: 'todo.items.rename', scope: 'todo:write' }),
    ).toThrow(/verbException/)
    expect(() =>
      defineOp({
        ...base,
        id: 'todo.items.rename',
        scope: 'todo:write',
        verbException: 'domain verb',
      }),
    ).not.toThrow()
  })

  test('rejects verbException on a base verb', () => {
    expect(() =>
      defineOp({
        ...base,
        id: 'todo.items.list',
        scope: 'todo:read',
        verbException: 'x',
      }),
    ).toThrow(/base verb/)
  })

  test('effect verbs need write or admin', () => {
    expect(() =>
      defineOp({ ...base, id: 'todo.items.delete', scope: 'todo:read' }),
    ).toThrow(/write or admin/)
  })

  test('the scope belongs to the product of the id', () => {
    expect(() =>
      defineOp({ ...base, id: 'todo.items.list', scope: 'other:read' }),
    ).toThrow(/another product/)
    expect(() =>
      defineOp({
        ...base,
        id: 'todo.items.list',
        scope: 'todo:owner' as 'todo:read',
      }),
    ).toThrow(/invalid scope/)
  })
})

describe('createRegistry', () => {
  const list = defineOp({ ...base, id: 'todo.items.list', scope: 'todo:read' })

  test('rejects duplicates, foreign products and bad versions', () => {
    expect(() =>
      createRegistry({ product: 'todo', version: '1.0.0', ops: [list, list] }),
    ).toThrow(/Duplicate/)
    expect(() =>
      createRegistry({ product: 'other', version: '1.0.0', ops: [list] }),
    ).toThrow(/does not belong/)
    expect(() =>
      createRegistry({ product: 'todo', version: '1', ops: [list] }),
    ).toThrow(/semver/)
  })

  test('call validates the input and maps unknown or out-of-scope ops to FORBIDDEN', async () => {
    const create = defineOp({
      ...base,
      id: 'todo.items.create',
      scope: 'todo:write',
      input: Type.Object(
        { title: Type.String() },
        { additionalProperties: false },
      ),
      output: Type.String(),
      handler: (_ctx: null, input) => input.title,
    })
    const registry = createRegistry({
      product: 'todo',
      version: '1.0.0',
      ops: [list, create],
    })
    expect(
      await registry.call(['todo:write'], null, 'todo.items.create', {
        title: 'a',
      }),
    ).toBe('a')
    const fail = async (scopes: string[], id: string, args: unknown) =>
      registry.call(scopes, null, id, args).catch((e: OpError) => e.code)
    expect(await fail(['todo:write'], 'todo.items.create', { title: 1 })).toBe(
      'VALIDATION',
    )
    expect(
      await fail(['todo:write'], 'todo.items.create', {
        title: 'a',
        orgId: 'x',
      }),
    ).toBe('VALIDATION')
    expect(await fail(['todo:read'], 'todo.items.create', { title: 'a' })).toBe(
      'FORBIDDEN',
    )
    expect(await fail(['todo:write'], 'todo.items.nope', {})).toBe('FORBIDDEN')
    expect(registry.visible(['todo:read']).map((o) => o.id)).toEqual([
      'todo.items.list',
    ])
  })
})

describe('allows', () => {
  test('a higher level covers a lower one, never another product', () => {
    expect(allows(['todo:admin'], 'todo:read')).toBe(true)
    expect(allows(['todo:write'], 'todo:read')).toBe(true)
    expect(allows(['todo:read'], 'todo:write')).toBe(false)
    expect(allows(['other:admin'], 'todo:read')).toBe(false)
    expect(allows([], 'todo:read')).toBe(false)
  })
})
