import { Type } from '@sinclair/typebox'
import { createRegistry, defineOp, OpError } from '@wefaber/codemode'

/** A tiny in-memory product used by the toolkit tests. Mirrors the shape of a real one (named types, scopes). */
export type TodoCtx = {
  store: Map<string, { id: string; title: string; done: boolean }>
}

const Item = Type.Object(
  {
    id: Type.String(),
    title: Type.String(),
    done: Type.Boolean(),
  },
  { $id: 'Item', description: 'A todo item.' },
)

const OnlyId = Type.Object(
  { id: Type.String() },
  { additionalProperties: false },
)

export const todoRegistry = createRegistry<TodoCtx>({
  product: 'todo',
  version: '1.0.0',
  types: [Item],
  ops: [
    defineOp({
      id: 'todo.items.list',
      scope: 'todo:read',
      summary: 'Lists every item.',
      input: Type.Object({}, { additionalProperties: false }),
      output: Type.Array(Item),
      handler: (ctx) => [...ctx.store.values()],
    }),
    defineOp({
      id: 'todo.items.get',
      scope: 'todo:read',
      summary: 'Gets one item by id.',
      input: OnlyId,
      output: Item,
      handler: (ctx, input) => {
        const item = ctx.store.get(input.id)
        if (!item) throw new OpError('NOT_FOUND', `No item ${input.id}`)
        return item
      },
    }),
    defineOp({
      id: 'todo.items.create',
      scope: 'todo:write',
      summary: 'Creates an item. Returns the item.',
      input: Type.Object(
        { title: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      output: Item,
      handler: (ctx, input) => {
        const item = {
          id: `i${ctx.store.size + 1}`,
          title: input.title,
          done: false,
        }
        ctx.store.set(item.id, item)
        return item
      },
    }),
    defineOp({
      id: 'todo.items.setDone',
      scope: 'todo:write',
      verbException: 'Toggles completion; "update" would hide the intent.',
      summary: 'Marks an item done or not done.',
      input: Type.Object(
        { id: Type.String(), done: Type.Boolean() },
        { additionalProperties: false },
      ),
      output: Item,
      handler: (ctx, input) => {
        const item = ctx.store.get(input.id)
        if (!item) throw new OpError('NOT_FOUND', `No item ${input.id}`)
        item.done = input.done
        return item
      },
    }),
    defineOp({
      id: 'todo.items.boom',
      scope: 'todo:read',
      verbException: 'Test-only: throws a non-domain error.',
      summary: 'Always fails with an internal error.',
      input: Type.Object({}, { additionalProperties: false }),
      output: Type.Null(),
      handler: () => {
        throw new Error('secret stack detail')
      },
    }),
  ],
})

export { todoRegistry as registry }
