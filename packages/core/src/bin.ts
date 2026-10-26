#!/usr/bin/env bun
/**
 * `wcm gen --registry <module> --out <dir>` writes `spec.json` and `client.d.ts` from the registry.
 * `wcm check ...` fails when they are stale (CI, SPEC R11). The module exports `registry` (or `default`).
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { staleGenerated, writeGenerated } from './gen.ts'
import type { Registry } from './registry.ts'

const [command, ...rest] = process.argv.slice(2)
const flag = (name: string) => {
  const at = rest.indexOf(`--${name}`)
  return at >= 0 ? rest[at + 1] : undefined
}
const modulePath = flag('registry')
const outDir = flag('out')

if ((command !== 'gen' && command !== 'check') || !modulePath || !outDir) {
  console.error('usage: wcm <gen|check> --registry <module> --out <dir>')
  process.exit(2)
}

const mod = (await import(pathToFileURL(resolve(modulePath)).href)) as {
  registry?: Registry<never>
  default?: Registry<never>
}
const registry = mod.registry ?? mod.default
if (!registry) {
  console.error(`${modulePath} must export "registry"`)
  process.exit(2)
}

if (command === 'gen') {
  for (const name of writeGenerated(registry, resolve(outDir)))
    console.log(`wrote ${outDir}/${name}`)
} else {
  const stale = staleGenerated(registry, resolve(outDir))
  if (stale.length > 0) {
    console.error(
      `stale generated files: ${stale.join(', ')}. Run: wcm gen --registry ${modulePath} --out ${outDir}`,
    )
    process.exit(1)
  }
  console.log('generated files are up to date')
}
