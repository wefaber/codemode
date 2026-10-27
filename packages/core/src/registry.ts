import type { Static, TObject, TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { codeOf, OpError } from './errors.ts'
import type { HostApi } from './sandbox.ts'

/** Base verbs of SPEC R4. Anything else needs `verbException`. */
export const BASE_VERBS = [
  'list',
  'get',
  'create',
  'update',
  'delete',
  'search',
  'run',
  'move',
  'restore',
] as const

/** Verbs with side effects: their scope must be `write` or `admin` (SPEC R5). */
const EFFECT_VERBS = new Set([
  'create',
  'update',
  'delete',
  'run',
  'move',
  'restore',
])

const ID = /^[a-z]+\.[a-z]+\.[a-z][a-zA-Z]*$/
const PRODUCT = /^[a-z]+$/
const SEMVER = /^\d+\.\d+\.\d+$/

export type Level = 'read' | 'write' | 'admin'
export type Scope = `${string}:${Level}`

const RANK: Record<Level, number> = { read: 1, write: 2, admin: 3 }

/**
 * Whether `granted` covers `required`: same product and an equal or higher level
 * (`checklist:admin` covers `checklist:write` covers `checklist:read`).
 */
export function allows(granted: readonly string[], required: Scope): boolean {
  const [product, level] = required.split(':') as [string, Level]
  return granted.some((scope) => {
    const [p, l] = scope.split(':')
    return (
      p === product &&
      l !== undefined &&
      l in RANK &&
      RANK[l as Level] >= RANK[level]
    )
  })
}

export type Op<Ctx = unknown> = {
  /** `product.resource.verb`. */
  id: string
  scope: Scope
  summary: string
  input: TObject
  output: TSchema
  /** Why the verb is outside the base set (SPEC R4). Published in `spec.json`. */
  verbException?: string
  handler(ctx: Ctx, input: never): unknown
}

/**
 * Declares an operation (SPEC R1). The handler calls the product's service layer (R3) and returns the minimum
 * needed to decide (R7). The id, verb and scope are checked here, so a bad declaration fails at import time.
 */
export function defineOp<Ctx, I extends TObject, O extends TSchema>(def: {
  id: string
  scope: Scope
  summary: string
  input: I
  output: O
  verbException?: string
  handler: (ctx: Ctx, input: Static<I>) => Static<O> | Promise<Static<O>>
}): Op<Ctx> {
  if (!ID.test(def.id))
    throw new Error(`Invalid op id "${def.id}": expected product.resource.verb`)
  const [product, , verb] = def.id.split('.') as [string, string, string]
  if (!/^[a-z]+:(read|write|admin)$/.test(def.scope))
    throw new Error(`${def.id}: invalid scope "${def.scope}"`)
  if (def.scope.split(':')[0] !== product)
    throw new Error(
      `${def.id}: scope "${def.scope}" belongs to another product`,
    )
  const isBase = (BASE_VERBS as readonly string[]).includes(verb)
  if (!isBase && !def.verbException)
    throw new Error(
      `${def.id}: verb "${verb}" is not in the base set; declare verbException`,
    )
  if (isBase && def.verbException)
    throw new Error(`${def.id}: verbException on base verb "${verb}"`)
  if (EFFECT_VERBS.has(verb) && def.scope.endsWith(':read'))
    throw new Error(
      `${def.id}: "${verb}" has effects, its scope must be write or admin`,
    )
  return def as unknown as Op<Ctx>
}

export type HostHooks = {
  /** Called once per operation the code invokes (audit). */
  onCall?(id: string): void
  /** Called with a non-domain error; the code only sees a generic HOST_ERROR (SPEC R12). */
  onError?(err: unknown, id: string): void
}

export type Registry<Ctx = unknown> = {
  product: string
  /** semver of the product API (SPEC R8). */
  version: string
  ops: readonly Op<Ctx>[]
  /** Named schemas (with `$id`) the generator emits once and references by name. */
  types: readonly TSchema[]
  get(id: string): Op<Ctx> | undefined
  /** The operations a token with `scopes` can see. The rest do not exist for it. */
  visible(scopes: readonly string[]): Op<Ctx>[]
  /** Validates `args` against the op schema and runs the handler. */
  call(
    scopes: readonly string[],
    ctx: Ctx,
    id: string,
    args: unknown,
  ): Promise<unknown>
  /** The `codemode.<product>.<resource>.<verb>` namespace for one run, already scoped and authenticated. */
  host(scopes: readonly string[], ctx: Ctx, hooks?: HostHooks): HostApi
}

export function createRegistry<Ctx>(def: {
  product: string
  version: string
  types?: readonly TSchema[]
  ops: readonly Op<Ctx>[]
}): Registry<Ctx> {
  if (!PRODUCT.test(def.product))
    throw new Error(`Invalid product "${def.product}"`)
  if (!SEMVER.test(def.version))
    throw new Error(`Invalid version "${def.version}": expected semver`)
  const byId = new Map<string, Op<Ctx>>()
  for (const op of def.ops) {
    if (!op.id.startsWith(`${def.product}.`))
      throw new Error(`${op.id}: does not belong to product "${def.product}"`)
    if (byId.has(op.id)) throw new Error(`Duplicate op id "${op.id}"`)
    byId.set(op.id, op)
  }

  const visible = (scopes: readonly string[]) =>
    def.ops.filter((op) => allows(scopes, op.scope))

  const call: Registry<Ctx>['call'] = async (scopes, ctx, id, args) => {
    const op = byId.get(id)
    if (!op || !allows(scopes, op.scope))
      throw new OpError('FORBIDDEN', `Operation ${id} is not available`)
    const input = args ?? {}
    if (!Value.Check(op.input, input)) {
      const first = Value.Errors(op.input, input).First()
      throw new OpError(
        'VALIDATION',
        `${id}: ${first ? `${first.path || 'input'} ${first.message}` : 'invalid input'}`,
      )
    }
    return await op.handler(ctx, input as never)
  }

  return {
    product: def.product,
    version: def.version,
    ops: def.ops,
    types: def.types ?? [],
    get: (id) => byId.get(id),
    visible,
    call,
    host(scopes, ctx, hooks = {}) {
      const api: HostApi = {}
      for (const op of visible(scopes)) {
        const path = op.id.split('.')
        let bucket = api
        for (const part of path.slice(0, -1))
          bucket = (bucket[part] ??= {}) as HostApi
        bucket[path.at(-1)!] = async (...args: unknown[]) => {
          hooks.onCall?.(op.id)
          try {
            return await call(scopes, ctx, op.id, args[0])
          } catch (err) {
            if (codeOf(err)) throw err
            hooks.onError?.(err, op.id)
            throw new OpError('HOST_ERROR', 'Internal error')
          }
        }
      }
      return api
    },
  }
}
