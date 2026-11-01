import { afterEach, describe, expect, test } from 'bun:test'
import { Type } from '@sinclair/typebox'
import {
  buildSpec,
  createRegistry,
  defineOp,
  DEFAULT_LIMITS,
  type Registry,
} from '@wefaber/codemode'
import {
  createLimiter,
  createWcmHandler,
  DEFAULT_LIMITER,
  verifyIdentity,
  type Identity,
} from '@wefaber/codemode-mcp'
import { createQuickJsSandbox } from '@wefaber/codemode-sandbox-quickjs'
import { todoRegistry, type TodoCtx } from '../../../tests/fixtures/todo.ts'
import { parseSpec } from './catalog.ts'
import type { GatewayConfig } from './config.ts'
import { openDb } from './db.ts'
import { createGateway } from './gateway.ts'

const SECRET = 'g'.repeat(40)

type NoteCtx = { notes: string[] }
const Note = Type.Object(
  { id: Type.String(), text: Type.String() },
  { $id: 'Note' },
)
const noteRegistry = createRegistry<NoteCtx>({
  product: 'note',
  version: '1.4.0',
  types: [Note],
  ops: [
    defineOp({
      id: 'note.notes.list',
      scope: 'note:read',
      summary: 'Lists every note.',
      input: Type.Object({}, { additionalProperties: false }),
      output: Type.Array(Note),
      handler: (ctx: NoteCtx) =>
        ctx.notes.map((text, i) => ({ id: `n${i + 1}`, text })),
    }),
    defineOp({
      id: 'note.notes.create',
      scope: 'note:write',
      summary: 'Creates a note.',
      input: Type.Object(
        { text: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      output: Note,
      handler: (ctx: NoteCtx, input) => {
        ctx.notes.push(input.text)
        return { id: `n${ctx.notes.length}`, text: input.text }
      },
    }),
  ],
})

/** A product behind the real handler and the real sandbox, trusting only identities signed by the gateway. */
function startProduct<Ctx>(
  registry: Registry<Ctx>,
  ctx: Ctx,
  opts: { announce?: string } = {},
) {
  const seen: Identity[] = []
  const handle = createWcmHandler<Ctx>({
    registry,
    sandbox: createQuickJsSandbox(),
    limiter: createLimiter({ ...DEFAULT_LIMITER, perMinute: 10_000 }),
    limits: { ...DEFAULT_LIMITS, timeoutMs: 2_000 },
    auth: async (request) => {
      const id = await verifyIdentity(SECRET, request.headers)
      if (!id) return null
      seen.push(id)
      return {
        tokenId: id.tokenHash,
        scopes: id.scopes,
        ctx,
        label: id.label ?? undefined,
      }
    },
  })
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const res = await handle(req)
      if (!opts.announce) return res
      const headers = new Headers(res.headers)
      headers.set('x-wcm-spec-version', opts.announce)
      return new Response(res.body, { status: res.status, headers })
    },
  })
  return {
    seen,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  }
}

const baseConfig: GatewayConfig = {
  port: 0,
  dbPath: ':memory:',
  secret: SECRET,
  runTimeoutMs: 8_000,
  productTimeoutMs: 3_000,
  perMinute: 1_000,
  callsPerMinute: 100_000,
  maxBytesPerDay: 1_000_000,
}

type Body = {
  ok: boolean
  result?: unknown
  truncated?: boolean
  calls?: number
  error?: { code: string; message: string }
}

/** Domain errors cross the sandbox as an Error whose message carries the code; uncaught, the run is CODE_ERROR. */
const failedWith = (body: Body, code: string) => {
  expect(body.ok).toBe(false)
  expect(body.error?.code).toBe('CODE_ERROR')
  expect(body.error?.message).toContain(code)
}

const closers: (() => void)[] = []
afterEach(() => {
  while (closers.length) closers.pop()!()
})

/** Gateway + two live products (`todo` 1.0.0, `note` 1.4.0) + a read-write and a read-only token. */
function world(
  opts: { config?: Partial<GatewayConfig>; noteAnnounce?: string } = {},
) {
  const todoStore: TodoCtx['store'] = new Map()
  const notes: string[] = []
  const todo = startProduct(todoRegistry, { store: todoStore })
  const note = startProduct(
    noteRegistry,
    { notes },
    { announce: opts.noteAnnounce },
  )
  closers.push(todo.stop, note.stop)
  const db = openDb(':memory:')
  const errors: unknown[] = []
  const gw = createGateway({
    db,
    config: { ...baseConfig, ...opts.config },
    sandbox: createQuickJsSandbox(),
    onError: (err) => void errors.push(err),
  })
  closers.push(() => db.close())
  gw.catalog.publish(buildSpec(todoRegistry as Registry<never>), todo.url)
  gw.catalog.publish(buildSpec(noteRegistry as Registry<never>), note.url)
  const rw = gw.tokens.create({
    label: 'hermes',
    scopes: ['todo:write', 'note:write'],
  }).token
  const ro = gw.tokens.create({
    label: 'reader',
    scopes: ['todo:read', 'note:read'],
  }).token

  const send = (
    path: string,
    token: string | null,
    init: { method?: string; body?: unknown } = {},
  ) =>
    gw.handler(
      new Request(`https://gw.test${path}`, {
        method: init.method ?? 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    )
  const run = async (
    token: string | null,
    code: string,
    kind: 'execute' | 'search' = 'execute',
  ) => {
    const res = await send(`/codemode/${kind}`, token, { body: { code } })
    return { res, status: res.status, body: (await res.json()) as Body }
  }
  return { gw, db, errors, todo, note, todoStore, notes, rw, ro, send, run }
}

describe('gateway: transport and auth', () => {
  test('/health and /ready answer without a token', async () => {
    const w = world()
    const health = await w.send('/health', null, { method: 'GET' })
    expect(await health.json()).toEqual({ ok: true })
    const ready = await w.send('/ready', null, { method: 'GET' })
    expect(await ready.json()).toEqual({ ok: true, products: 2 })
  })

  test('a missing, unknown, revoked or expired token is UNAUTHENTICATED (401)', async () => {
    const w = world()
    for (const token of [null, 'wcm_gateway_nope']) {
      const { status, body } = await w.run(token, 'return 1')
      expect(status).toBe(401)
      expect(body.error?.code).toBe('UNAUTHENTICATED')
    }
    const revoked = w.gw.tokens.create({ label: 'old', scopes: ['todo:read'] })
    w.gw.tokens.revoke(revoked.hash.slice(0, 8))
    expect((await w.run(revoked.token, 'return 1')).status).toBe(401)
    const expired = w.gw.tokens.create({
      label: 'gone',
      scopes: ['todo:read'],
      expiresAt: Date.now() - 1,
    })
    expect((await w.run(expired.token, 'return 1')).status).toBe(401)
  })

  test('unknown paths are 404 and wrong methods 405', async () => {
    const w = world()
    expect((await w.send('/nope', w.rw, { method: 'GET' })).status).toBe(404)
    const get = await w.send('/codemode/execute', w.rw, { method: 'GET' })
    expect(get.status).toBe(405)
    const mcp = await w.send('/mcp', w.rw, { method: 'GET' })
    expect(mcp.status).toBe(405)
  })

  test('a body without code is VALIDATION (400) and an oversized one LIMIT_REACHED (413)', async () => {
    const w = world()
    const missing = await w.send('/codemode/execute', w.rw, { body: {} })
    expect(missing.status).toBe(400)
    const big = await w.send('/codemode/execute', w.rw, {
      body: { code: 'x'.repeat(70 * 1024) },
    })
    expect(big.status).toBe(413)
  })

  test('/catalog lists what the token can use, never the product URLs', async () => {
    const w = world()
    const res = await w.send('/catalog', w.ro, { method: 'GET' })
    const body = (await res.json()) as {
      products: { product: string; ops: number }[]
    }
    expect(body.products.map((p) => p.product)).toEqual(['note', 'todo'])
    expect(JSON.stringify(body)).not.toContain('127.0.0.1')
    const anon = await w.send('/catalog', null, { method: 'GET' })
    expect(anon.status).toBe(401)
  })
})

describe('gateway: search', () => {
  test('returns only the operations the code asks for, in under 2 KB', async () => {
    const w = world()
    const { body } = await w.run(
      w.rw,
      `return spec.ops.filter((o) => o.id.startsWith('note.')).map((o) => ({ id: o.id, summary: o.summary }))`,
      'search',
    )
    expect(body.ok).toBe(true)
    const ops = body.result as { id: string }[]
    expect(ops.map((o) => o.id).sort()).toEqual([
      'note.notes.create',
      'note.notes.list',
    ])
    expect(JSON.stringify(body).length).toBeLessThan(2048)
  })

  test('sees every product, with versions, for a token that covers them', async () => {
    const w = world()
    const { body } = await w.run(
      w.rw,
      `return Object.fromEntries(Object.entries(spec.products).map(([p, v]) => [p, v.version]))`,
      'search',
    )
    expect(body.result).toEqual({ note: '1.4.0', todo: '1.0.0' })
  })

  test('a read-only token does not see write operations (SPEC R5)', async () => {
    const w = world()
    const { body } = await w.run(
      w.ro,
      `return spec.ops.map((o) => o.scope)`,
      'search',
    )
    const scopes = body.result as string[]
    expect(scopes.length).toBeGreaterThan(0)
    expect(scopes.every((s) => s.endsWith(':read'))).toBe(true)
  })
})

describe('gateway: execute', () => {
  test('one run across two products returns the combined result and each product sees the run id', async () => {
    const w = world()
    const { res, body } = await w.run(
      w.rw,
      `
      const item = await codemode.todo.items.create({ title: 'ship the gateway' })
      const note = await codemode.note.notes.create({ text: 'phase 5' })
      const items = await codemode.todo.items.list({})
      const notes = await codemode.note.notes.list({})
      return { item: item.id, note: note.id, todos: items.length, notes: notes.length }
      `,
    )
    expect(body.ok).toBe(true)
    expect(body.result).toEqual({ item: 'i1', note: 'n1', todos: 1, notes: 1 })
    expect(body.calls).toBe(4)

    const runId = res.headers.get('x-wcm-run-id')!
    expect(runId).toBeTruthy()
    expect(w.todo.seen.length).toBe(2)
    expect(w.note.seen.length).toBe(2)
    for (const id of [...w.todo.seen, ...w.note.seen]) {
      expect(id.runId).toBe(runId)
      expect(id.label).toBe('hermes')
      expect(id.scopes).toEqual(['todo:write', 'note:write'])
    }

    const rows = w.db.query('SELECT * FROM runs').all() as Record<
      string,
      unknown
    >[]
    expect(rows.length).toBe(1)
    const row = rows[0]!
    expect(row.run_id).toBe(runId)
    expect(String(row.products).split(',').sort()).toEqual(['note', 'todo'])
    expect(JSON.parse(String(row.ops))).toEqual([
      'todo.items.create',
      'note.notes.create',
      'todo.items.list',
      'note.notes.list',
    ])
    expect(row.via).toBe('gateway')
    expect(row.error_code).toBeNull()
    expect(String(row.spec_versions)).toContain('note@1.4.0')
  })

  test('the product token never reaches the product: only the hash does', async () => {
    const w = world()
    await w.run(w.rw, `return await codemode.todo.items.list({})`)
    const seen = w.todo.seen[0]!
    expect(seen.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(seen.tokenHash).not.toBe(w.rw)
    expect(JSON.stringify(seen)).not.toContain(w.rw)
  })

  test('a write operation is not callable with a read-only token (CODE_ERROR, nothing reaches the product)', async () => {
    const w = world()
    const { body } = await w.run(
      w.ro,
      `return await codemode.note.notes.create({ text: 'nope' })`,
    )
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe('CODE_ERROR')
    expect(w.note.seen.length).toBe(0)
    expect(w.notes).toEqual([])
  })

  test('errors of the product keep their code', async () => {
    const w = world()
    const notFound = await w.run(
      w.rw,
      `return await codemode.todo.items.get({ id: 'zzz' })`,
    )
    failedWith(notFound.body, 'NOT_FOUND')
    const invalid = await w.run(
      w.rw,
      `return await codemode.todo.items.create({})`,
    )
    failedWith(invalid.body, 'VALIDATION')
    const rows = w.db
      .query('SELECT error_code FROM runs ORDER BY created_at')
      .all() as { error_code: string }[]
    expect(rows.map((r) => r.error_code)).toEqual(['CODE_ERROR', 'CODE_ERROR'])
  })

  test('a product that is down is PRODUCT_UNAVAILABLE and the others keep working', async () => {
    const w = world()
    w.note.stop()
    const down = await w.run(w.rw, `return await codemode.note.notes.list({})`)
    failedWith(down.body, 'PRODUCT_UNAVAILABLE')
    expect(down.body.error?.message).not.toContain('127.0.0.1')
    const alive = await w.run(w.rw, `return await codemode.todo.items.list({})`)
    expect(alive.body).toMatchObject({ ok: true, result: [] })
  })

  test('code can handle a down product and still return what the others gave', async () => {
    const w = world()
    w.note.stop()
    const { body } = await w.run(
      w.rw,
      `
      let notes = 'unavailable'
      try { notes = await codemode.note.notes.list({}) } catch (e) { notes = e.message.split(':')[0] }
      const items = await codemode.todo.items.list({})
      return { notes, todos: items.length }
      `,
    )
    expect(body.ok).toBe(true)
    expect(body.result).toEqual({ notes: 'PRODUCT_UNAVAILABLE', todos: 0 })
  })

  test('a product on a major the catalog does not know is SPEC_MISMATCH (SPEC R8)', async () => {
    const w = world({ noteAnnounce: '2.0.0' })
    const { body } = await w.run(
      w.rw,
      `return await codemode.note.notes.list({})`,
    )
    failedWith(body, 'SPEC_MISMATCH')
    const todo = await w.run(w.rw, `return await codemode.todo.items.list({})`)
    expect(todo.body.ok).toBe(true)
  })

  test('a product that rejects the gateway identity is HOST_ERROR and is logged, not leaked', async () => {
    const w = world()
    // Same product, other secret on the gateway side: the product refuses the signature.
    const other = createGateway({
      db: w.db,
      config: { ...baseConfig, secret: 'z'.repeat(40) },
      sandbox: createQuickJsSandbox(),
      onError: (err) => void w.errors.push(err),
    })
    const res = await other.handler(
      new Request('https://gw.test/codemode/execute', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${w.rw}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          code: `return await codemode.todo.items.list({})`,
        }),
      }),
    )
    const body = (await res.json()) as Body
    failedWith(body, 'HOST_ERROR')
    expect(body.error?.message).toContain('rejected the gateway')
    expect(w.errors.length).toBe(1)
  })

  test('the daily result budget is enforced per token (RATE_LIMITED, 429)', async () => {
    const w = world({ config: { maxBytesPerDay: 20 } })
    const first = await w.run(w.rw, `return 'x'.repeat(50)`)
    expect(first.body.ok).toBe(true)
    const second = await w.run(w.rw, `return 1`)
    expect(second.status).toBe(429)
    expect(second.body.error?.code).toBe('RATE_LIMITED')
    // another token has its own budget
    const third = await w.run(w.ro, `return 1`)
    expect(third.body.ok).toBe(true)
  })

  test('runs per minute are limited per token', async () => {
    const w = world({ config: { perMinute: 2 } })
    expect((await w.run(w.rw, 'return 1')).body.ok).toBe(true)
    expect((await w.run(w.rw, 'return 1')).body.ok).toBe(true)
    const third = await w.run(w.rw, 'return 1')
    expect(third.status).toBe(429)
    expect(third.body.error?.code).toBe('RATE_LIMITED')
  })
})

describe('gateway: MCP', () => {
  test('publishes exactly search and execute (SPEC R2) and runs a tool', async () => {
    const w = world()
    const rpc = async (body: unknown) =>
      (await (await w.send('/mcp', w.rw, { body })).json()) as {
        result?: {
          tools?: { name: string }[]
          content?: { text: string }[]
          isError?: boolean
        }
      }
    const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(list.result?.tools?.map((t) => t.name)).toEqual([
      'search',
      'execute',
    ])
    const call = await rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'execute',
        arguments: { code: `return await codemode.todo.items.list({})` },
      },
    })
    expect(call.result?.isError).toBe(false)
    expect(JSON.parse(call.result!.content![0]!.text)).toMatchObject({
      ok: true,
      result: [],
    })
  })

  test('without a token /mcp is 401', async () => {
    const w = world()
    const res = await w.send('/mcp', null, {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(res.status).toBe(401)
  })
})

describe('gateway: catalog', () => {
  test('refuses a spec that would make the gateway build bad code', () => {
    const good = buildSpec(todoRegistry as Registry<never>)
    expect(() => parseSpec(good)).not.toThrow()
    const withOp = (op: Record<string, unknown>) => ({
      ...good,
      ops: [{ ...good.ops[0], ...op }],
    })
    expect(() => parseSpec(withOp({ id: 'todo.items.list(); evil' }))).toThrow(
      /invalid op id/,
    )
    expect(() => parseSpec(withOp({ id: 'other.items.list' }))).toThrow(
      /does not belong/,
    )
    expect(() => parseSpec(withOp({ scope: 'other:read' }))).toThrow(
      /invalid scope/,
    )
    expect(() => parseSpec({ ...good, version: '1' })).toThrow(/semver/)
    expect(() => parseSpec({ ...good, product: 'To-Do' })).toThrow(/product/)
  })

  test('a different major needs --accept-major; a minor does not (SPEC R8, §10)', () => {
    const w = world()
    const spec = buildSpec(noteRegistry as Registry<never>)
    const url = w.note.url
    expect(
      w.gw.catalog.publish({ ...spec, version: '1.5.0' }, url).version,
    ).toBe('1.5.0')
    expect(() =>
      w.gw.catalog.publish({ ...spec, version: '2.0.0' }, url),
    ).toThrow(/SPEC_MISMATCH/)
    const accepted = w.gw.catalog.publish({ ...spec, version: '2.0.0' }, url, {
      acceptMajor: true,
    })
    expect(accepted.major).toBe(2)
  })

  test('rejects a product URL that is not http(s)', () => {
    const w = world()
    const spec = buildSpec(noteRegistry as Registry<never>)
    expect(() => w.gw.catalog.publish(spec, 'file:///etc/passwd')).toThrow(
      /http\(s\)/,
    )
    expect(() => w.gw.catalog.publish(spec, 'not a url')).toThrow(/invalid url/)
  })
})

describe('gateway: tokens', () => {
  test('are stored hashed and an imported product token keeps working', async () => {
    const w = world()
    const { token } = w.gw.tokens.create({ label: 'x', scopes: ['todo:read'] })
    const stored = w.db.query('SELECT token_hash FROM tokens').all() as {
      token_hash: string
    }[]
    expect(stored.some((r) => r.token_hash.includes(token))).toBe(false)
    expect(JSON.stringify(stored)).not.toContain(token.slice(-12))

    w.gw.tokens.importToken({
      token: 'mck_legacy_token_value',
      label: 'mychecklist agent',
      scopes: ['todo:read'],
    })
    const { body } = await w.run('mck_legacy_token_value', `return 1`)
    expect(body.ok).toBe(true)
  })

  test('validates scopes and labels, and revoke needs an unambiguous prefix', () => {
    const w = world()
    expect(() => w.gw.tokens.create({ label: 'x', scopes: [] })).toThrow(
      /at least one scope/,
    )
    expect(() =>
      w.gw.tokens.create({ label: 'x', scopes: ['todo:root'] }),
    ).toThrow(/Invalid scope/)
    expect(() =>
      w.gw.tokens.create({ label: ' ', scopes: ['todo:read'] }),
    ).toThrow(/label/)
    expect(() => w.gw.tokens.revoke('a')).toThrow(/exactly one/)
  })
})
