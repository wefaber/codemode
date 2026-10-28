// Publishes every workspace package whose current version is not yet on the public registry (scope @wefaber).
//
// CI (.github/workflows/publish.yml) publishes with npm Trusted Publishing: OIDC, no token. Bun packs the tarball
// (it resolves `workspace:*`), npm publishes it, because `bun publish` has no OIDC support.
// First release of a new package: Trusted Publishing needs the package to exist, so run `bun run release` once from a
// logged-in shell (`npm login`); npm asks for the 2FA code on the terminal. In CI, where the only credential is the
// OIDC token, such a package is reported and skipped instead of failing the run: the token exchange answers 404
// "package not found" and npm turns that into a bare ENEEDAUTH, which no retry or code change can fix.
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const dirs = readdirSync(join(root, 'packages'))
  .map((d) => join(root, 'packages', d))
  .filter((d) => existsSync(join(d, 'package.json')))
const interactive = !process.env.CI
// A real publish token can only come from the environment here; without one, CI has just the OIDC token, which
// only works for packages that already exist on the registry.
const hasPublishToken = Boolean(
  process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN,
)

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
const needsBootstrap: string[] = []
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
  // `name@version` answers 404 both for a package never published and for a new version of an existing one, so a
  // 404 only means "unpublished" once the bare name also answers 404. Mistaking the second case for the first
  // skipped every release after the first.
  if (info.code !== 0 && !/E404|404 Not Found/i.test(info.text)) {
    console.error(`cannot check ${spec}: ${info.text}`)
    failed = true
    continue
  }
  let unpublished = false
  if (info.code !== 0) {
    const exists = await run(['npm', 'view', name, 'name'], dir)
    if (exists.code !== 0 && !/E404|404 Not Found/i.test(exists.text)) {
      console.error(`cannot check ${name}: ${exists.text}`)
      failed = true
      continue
    }
    unpublished = exists.code !== 0
  }
  // Without a token the only credential is the OIDC one, and the exchange is keyed by an existing package, so a
  // never-published package is a first release that must happen by hand. Skip it, loudly, and keep the run honest.
  if (unpublished && !interactive && !hasPublishToken) {
    needsBootstrap.push(spec)
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
    const text = error instanceof Error ? error.message : String(error)
    console.error(`FAILED ${spec}\n${text}`)
    // The exchange answers 404 "package not found" when npmjs.com holds no trusted publisher for this package that
    // matches this repository and this workflow file, or when its "Allow npm publish" permission is off. The OIDC
    // token can never be exchanged then, and npm reports the whole thing as a bare ENEEDAUTH.
    if (/OIDC token exchange error.*package not found/i.test(text))
      console.error(
        `HINT ${spec}: trusted publisher missing or incomplete on npmjs.com. It needs repository ` +
          `wefaber/codemode, workflow publish.yml and "Allow npm publish" enabled: ` +
          `https://www.npmjs.com/package/${name}/access`,
      )
    failed = true
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}
if (needsBootstrap.length > 0) {
  for (const spec of needsBootstrap)
    console.log(
      `::warning title=Not on npm yet::${spec} has never been published and Trusted Publishing cannot create a new package. Bootstrap it once from a logged-in shell: npm login && bun run release`,
    )
  const summary = [
    '### Release skipped: a first publish needs a manual bootstrap',
    '',
    'Trusted Publishing (OIDC) cannot create a package that is not on the registry yet, so these were skipped:',
    '',
    ...needsBootstrap.map((spec) => `- \`${spec}\``),
    '',
    'Run `npm login && bun run release` once from a clean checkout. Later versions publish from this workflow.',
    '',
  ]
  const summaryFile = process.env.GITHUB_STEP_SUMMARY
  if (summaryFile) appendFileSync(summaryFile, summary.join('\n'))
}
process.exit(failed ? 1 : 0)
