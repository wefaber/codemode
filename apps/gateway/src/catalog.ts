import type { Database } from 'bun:sqlite'
import { allows, type Scope, type Spec, type SpecOp } from '@wefaber/codemode'

const PRODUCT = /^[a-z]+$/
const OP_ID = /^[a-z]+\.[a-z]+\.[a-z][a-zA-Z]*$/
const SCOPE = /^[a-z]+:(read|write|admin)$/
const SEMVER = /^(\d+)\.\d+\.\d+$/

export type ProductEntry = {
  product: string
  /** Major the gateway knows (SPEC R8). A product on another major is refused until the catalog accepts it. */
  major: number
  version: string
  /** Base URL of the product; `/codemode/execute` hangs off it. Never shown to agents. */
  url: string
  spec: Spec
}

/** What `search` receives: every visible operation in one flat list, plus per-product version and named types. */
export type CatalogSpec = {
  products: Record<string, { version: string; types: Spec['types'] }>
  ops: SpecOp[]
}

type Row = {
  product: string
  major: number
  version: string
  url: string
  spec: string
}

export const majorOf = (version: string): number | null => {
  const m = SEMVER.exec(version)
  return m ? Number(m[1]) : null
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Checks a published `spec.json`: the gateway builds code and routes from it, so a bad one must not get in. */
export function parseSpec(raw: unknown): Spec {
  if (!isObject(raw)) throw new Error('spec must be an object')
  const { product, version, ops, types } = raw
  if (typeof product !== 'string' || !PRODUCT.test(product))
    throw new Error('spec.product must be lowercase letters only')
  if (typeof version !== 'string' || majorOf(version) === null)
    throw new Error('spec.version must be semver (x.y.z)')
  if (!Array.isArray(ops) || ops.length === 0)
    throw new Error('spec.ops must be a non-empty array')
  const seen = new Set<string>()
  for (const op of ops) {
    if (!isObject(op)) throw new Error('every op must be an object')
    const { id, scope, summary } = op
    if (typeof id !== 'string' || !OP_ID.test(id))
      throw new Error(`invalid op id ${JSON.stringify(id)}`)
    if (!id.startsWith(`${product}.`))
      throw new Error(`${id} does not belong to product "${product}"`)
    if (seen.has(id)) throw new Error(`duplicate op ${id}`)
    seen.add(id)
    if (
      typeof scope !== 'string' ||
      !SCOPE.test(scope) ||
      scope.split(':')[0] !== product
    )
      throw new Error(`${id}: invalid scope ${JSON.stringify(scope)}`)
    if (typeof summary !== 'string') throw new Error(`${id}: missing summary`)
    if (!isObject(op.input) || !isObject(op.output))
      throw new Error(`${id}: input and output must be schemas`)
  }
  if (!isObject(types)) throw new Error('spec.types must be an object')
  return raw as unknown as Spec
}

export function createCatalog(db: Database, now: () => number = Date.now) {
  const upsert = db.prepare(
    `INSERT INTO products (product, major, version, url, spec, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(product) DO UPDATE SET major = excluded.major, version = excluded.version, url = excluded.url,
       spec = excluded.spec, updated_at = excluded.updated_at`,
  )
  const one = db.prepare<Row, [string]>(
    'SELECT product, major, version, url, spec FROM products WHERE product = ?',
  )
  const all = db.prepare<Row, []>(
    'SELECT product, major, version, url, spec FROM products ORDER BY product',
  )
  const entry = (row: Row): ProductEntry => ({
    product: row.product,
    major: row.major,
    version: row.version,
    url: row.url,
    spec: JSON.parse(row.spec) as Spec,
  })

  const list = () => all.all().map(entry)

  /** The operations a token with `scopes` can see, each with the product that serves it. */
  const visible = (scopes: readonly string[]) =>
    list().flatMap((product) =>
      product.spec.ops
        .filter((op) => allows(scopes, op.scope as Scope))
        .map((op) => ({ product, op })),
    )

  return {
    /**
     * Publishes (or updates) a product. A different major than the one on record is refused unless `acceptMajor`:
     * agents code against the old shape (SPEC R8, §10).
     */
    publish(
      raw: unknown,
      url: string,
      opts: { acceptMajor?: boolean } = {},
    ): ProductEntry {
      const spec = parseSpec(raw)
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new Error(`invalid url "${url}"`)
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
        throw new Error('url must be http(s)')
      const major = majorOf(spec.version)!
      const known = one.get(spec.product)
      if (known && known.major !== major && !opts.acceptMajor)
        throw new Error(
          `SPEC_MISMATCH: ${spec.product} is on major ${known.major}, this spec is ${spec.version}; pass --accept-major`,
        )
      upsert.run(
        spec.product,
        major,
        spec.version,
        url.replace(/\/+$/, ''),
        JSON.stringify(spec),
        now(),
      )
      return entry(one.get(spec.product)!)
    },
    get: (product: string) => {
      const row = one.get(product)
      return row ? entry(row) : undefined
    },
    list,
    visible,
    visibleSpec(scopes: readonly string[]): CatalogSpec {
      const spec: CatalogSpec = { products: {}, ops: [] }
      for (const { product, op } of visible(scopes)) {
        spec.products[product.product] ??= {
          version: product.version,
          types: product.spec.types,
        }
        spec.ops.push(op)
      }
      return spec
    },
  }
}

export type Catalog = ReturnType<typeof createCatalog>
