// Publishes every workspace package whose current version is not yet on the public registry (scope @wefaber).
//
// CI (.github/workflows/publish.yml) publishes with npm Trusted Publishing: OIDC, no token. Bun packs the tarball
// (it resolves `workspace:*`), npm publishes it, because `bun publish` has no OIDC support.
// First release of a new package: Trusted Publishing needs the package to exist, so run `bun run release` once from a
// logged-in shell (`npm login`); npm asks for the 2FA code on the terminal.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const dirs = readdirSync(join(root, 'packages'))
  .map((d) => join(root, 'packages', d))
  .filter((d) => existsSync(join(d, 'package.json')))
const interactive = !process.env.CI

const run = async (cmd: string[], cwd: string, inherit = false) => {
  if (inherit) {
    const p = Bun.spawn(cmd, {
      cwd,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      env: process.env,
    })
    return { code: await p.exited, text: '' }
  }
  const p = Bun.spawn(cmd, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  return { code: await p.exited, text: (out + err).trim() }
}

let failed = false
// Dependency order: core first, then what depends on it.
const order = ['core', 'sandbox-quickjs', 'mcp', 'cli']
dirs.sort(
  (a, b) =>
    order.indexOf(a.split(/[\\/]/).at(-1)!) -
    order.indexOf(b.split(/[\\/]/).at(-1)!),
)
for (const dir of dirs) {
  const {
    name,
    version,
    private: isPrivate,
  } = await Bun.file(join(dir, 'package.json')).json()
  if (isPrivate) continue
  const spec = `${name}@${version}`
  // `npm view` prints warnings on stderr and `run` concatenates stderr after stdout, so the version has to be
  // searched for, not read as the last line.
  const info = await run(['npm', 'view', spec, 'version'], dir)
  if (
    info.code === 0 &&
    info.text
      .split('\n')
      .map((line) => line.trim())
      .includes(version)
  ) {
    console.log(`skip ${spec} (already published)`)
    continue
  }
  // A package that was never published answers 404: that is the case this script exists for.
  if (info.code !== 0 && !/E404|404 Not Found/i.test(info.text)) {
    console.error(`cannot check ${spec}: ${info.text}`)
    failed = true
    continue
  }
  const out = mkdtempSync(join(tmpdir(), 'wefaber-pack-'))
  try {
    const pack = await run(['bun', 'pm', 'pack', '--destination', out], dir)
    const tarball = readdirSync(out).find((file) => file.endsWith('.tgz'))
    if (pack.code !== 0 || !tarball)
      throw new Error(`pack failed\n${pack.text}`)
    const pub = await run(
      ['npm', 'publish', join(out, tarball), '--access', 'public'],
      dir,
      interactive,
    )
    if (pub.code !== 0)
      throw new Error(pub.text || `npm publish exited ${pub.code}`)
    console.log(`published ${spec}`)
  } catch (error) {
    console.error(
      `FAILED ${spec}\n${error instanceof Error ? error.message : error}`,
    )
    failed = true
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}
process.exit(failed ? 1 : 0)
