/**
 * Admin of the gateway's catalog and tokens. Runs on the host that holds the database.
 *
 *   bun src/cli.ts catalog publish <spec.json> --url <https://product> [--accept-major]
 *   bun src/cli.ts catalog list
 *   bun src/cli.ts token create --label <name> --scopes a:read,b:write [--days 90]
 *   bun src/cli.ts token import --label <name> --scopes a:read   (token on stdin)
 *   bun src/cli.ts token list
 *   bun src/cli.ts token revoke <hash-prefix>
 */
import { defaultDbPath } from './config.ts'
import { createCatalog } from './catalog.ts'
import { openDb } from './db.ts'
import { createTokenStore } from './tokens.ts'

function parse(argv: string[]) {
  const pos: string[] = []
  const opts = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!
    if (!tok.startsWith('--')) {
      pos.push(tok)
      continue
    }
    const name = tok.slice(2)
    if (name === 'accept-major') {
      opts.set(name, 'true')
      continue
    }
    const value = argv[++i]
    if (value === undefined) throw new Error(`--${name} needs a value`)
    opts.set(name, value)
  }
  return { pos, opts }
}

const need = (opts: Map<string, string>, name: string) => {
  const v = opts.get(name)
  if (!v) throw new Error(`--${name} is required`)
  return v
}

const scopesOf = (opts: Map<string, string>) =>
  need(opts, 'scopes')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const expiry = (opts: Map<string, string>) => {
  const days = opts.get('days')
  return days ? Date.now() + Number(days) * 86_400_000 : null
}

async function main(argv: string[]): Promise<void> {
  const [group, action, ...rest] = argv
  const { pos, opts } = parse(rest)
  const db = openDb(defaultDbPath())
  const catalog = createCatalog(db)
  const tokens = createTokenStore(db)

  if (group === 'catalog' && action === 'publish') {
    const file = pos[0]
    if (!file) throw new Error('catalog publish needs <spec.json>')
    const entry = catalog.publish(
      JSON.parse(await Bun.file(file).text()),
      need(opts, 'url'),
      { acceptMajor: opts.has('accept-major') },
    )
    console.log(
      `published ${entry.product}@${entry.version} (major ${entry.major}, ${entry.spec.ops.length} ops) -> ${entry.url}`,
    )
  } else if (group === 'catalog' && action === 'list') {
    for (const p of catalog.list())
      console.log(
        `${p.product.padEnd(14)} ${p.version.padEnd(10)} ${String(p.spec.ops.length).padStart(3)} ops  ${p.url}`,
      )
  } else if (group === 'token' && action === 'create') {
    const { token, hash } = tokens.create({
      label: need(opts, 'label'),
      scopes: scopesOf(opts),
      expiresAt: expiry(opts),
    })
    console.log(`hash:  ${hash.slice(0, 12)}`)
    console.log(`token: ${token}`)
    console.error(
      'Shown once. Store it in the agent now; only its hash is kept.',
    )
  } else if (group === 'token' && action === 'import') {
    const token = (await Bun.stdin.text()).trim()
    if (!token) throw new Error('token import reads the token from stdin')
    const hash = tokens.importToken({
      token,
      label: need(opts, 'label'),
      scopes: scopesOf(opts),
      expiresAt: expiry(opts),
    })
    console.log(`imported ${hash.slice(0, 12)}`)
  } else if (group === 'token' && action === 'list') {
    for (const t of tokens.list())
      console.log(
        `${t.hash.slice(0, 12)}  ${t.label.padEnd(20)} ${t.scopes.join(',')}${t.revoked ? '  [revoked]' : ''}${t.expiresAt && t.expiresAt <= Date.now() ? '  [expired]' : ''}`,
      )
  } else if (group === 'token' && action === 'revoke') {
    const prefix = pos[0]
    if (!prefix) throw new Error('token revoke needs <hash-prefix>')
    const t = tokens.revoke(prefix)
    console.log(`revoked ${t.hash.slice(0, 12)} (${t.label})`)
  } else {
    throw new Error(
      'usage: catalog publish|list, token create|import|list|revoke (see the header of src/cli.ts)',
    )
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`gateway: ${(err as Error).message}`)
  process.exit(1)
})
