import type { Database } from 'bun:sqlite'
import type { Principal } from '@wefaber/codemode-mcp'

/** Gateway handlers carry no tenancy: the products resolve it from the forwarded identity. */
export type GatewayPrincipal = Principal<null>

export type TokenInfo = {
  hash: string
  label: string
  scopes: string[]
  expiresAt: number | null
  revoked: boolean
  createdAt: number
}

type Row = {
  token_hash: string
  label: string
  scopes: string
  expires_at: number | null
  revoked: number
  created_at: number
}

const SCOPE = /^[a-z]+:(read|write|admin)$/

export const sha256Hex = (text: string): string =>
  new Bun.CryptoHasher('sha256').update(text).digest('hex')

function checkScopes(scopes: readonly string[]): void {
  if (scopes.length === 0) throw new Error('A token needs at least one scope')
  for (const scope of scopes)
    if (!SCOPE.test(scope))
      throw new Error(
        `Invalid scope "${scope}": expected product:read|write|admin`,
      )
}

/**
 * Tokens are stored as sha256 (SPEC R9): the plain token is shown once, at creation. Tokens a product already issued
 * (`mck_…`) are imported by hash and keep working (SPEC §7).
 */
export function createTokenStore(db: Database, now: () => number = Date.now) {
  const insert = db.prepare(
    'INSERT INTO tokens (token_hash, label, scopes, expires_at, revoked, created_at) VALUES (?, ?, ?, ?, 0, ?)',
  )
  const find = db.prepare<Row, [string]>(
    'SELECT * FROM tokens WHERE token_hash = ?',
  )
  const list = db.prepare<Row, []>(
    'SELECT * FROM tokens ORDER BY created_at DESC',
  )
  const revoke = db.prepare(
    'UPDATE tokens SET revoked = 1 WHERE token_hash = ?',
  )

  const info = (row: Row): TokenInfo => ({
    hash: row.token_hash,
    label: row.label,
    scopes: row.scopes.split(','),
    expiresAt: row.expires_at,
    revoked: row.revoked === 1,
    createdAt: row.created_at,
  })

  const add = (
    token: string,
    label: string,
    scopes: readonly string[],
    expiresAt: number | null,
  ) => {
    checkScopes(scopes)
    if (label.trim() === '') throw new Error('A token needs a label')
    const hash = sha256Hex(token)
    insert.run(hash, label, scopes.join(','), expiresAt, now())
    return hash
  }

  return {
    /** A new `wcm_gateway_<32 hex>` token. The plain value is returned once and never stored. */
    create(opts: {
      label: string
      scopes: readonly string[]
      expiresAt?: number | null
    }) {
      const bytes = crypto.getRandomValues(new Uint8Array(16))
      const token = `wcm_gateway_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
      const hash = add(token, opts.label, opts.scopes, opts.expiresAt ?? null)
      return { token, hash }
    },
    /** Registers a token that already exists elsewhere (a product's `mck_…`). Only its hash is kept. */
    importToken(opts: {
      token: string
      label: string
      scopes: readonly string[]
      expiresAt?: number | null
    }) {
      return add(opts.token, opts.label, opts.scopes, opts.expiresAt ?? null)
    },
    /** The caller behind `Authorization: Bearer <token>`, or `null` when it is missing, unknown, revoked or expired. */
    authenticate(request: Request): GatewayPrincipal | null {
      const token = /^Bearer\s+(\S+)$/i.exec(
        request.headers.get('authorization') ?? '',
      )?.[1]
      if (!token) return null
      const row = find.get(sha256Hex(token))
      if (!row || row.revoked === 1) return null
      if (row.expires_at !== null && row.expires_at <= now()) return null
      return {
        tokenId: row.token_hash,
        scopes: row.scopes.split(','),
        ctx: null,
        label: row.label,
      }
    },
    list: () => list.all().map(info),
    /** Revokes by hash prefix; the prefix must match exactly one token. */
    revoke(prefix: string): TokenInfo {
      const matches = list.all().filter((r) => r.token_hash.startsWith(prefix))
      if (prefix.length < 6 || matches.length !== 1)
        throw new Error(
          `"${prefix}" must match exactly one token hash (6+ characters)`,
        )
      const row = matches[0]!
      revoke.run(row.token_hash)
      return { ...info(row), revoked: true }
    },
  }
}

export type TokenStore = ReturnType<typeof createTokenStore>
