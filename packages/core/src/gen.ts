import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Registry } from './registry.ts'
import { buildSpec, renderDts } from './spec.ts'

export const OUT_SPEC = 'spec.json'
export const OUT_DTS = 'client.d.ts'

/** The generated files as text (SPEC R11). */
export function generate(registry: Registry<never>): Record<string, string> {
  return {
    [OUT_SPEC]: `${JSON.stringify(buildSpec(registry), null, 2)}\n`,
    [OUT_DTS]: renderDts(registry),
  }
}

export function writeGenerated(
  registry: Registry<never>,
  dir: string,
): string[] {
  mkdirSync(dir, { recursive: true })
  const files = generate(registry)
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name), text)
  return Object.keys(files)
}

const read = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  } catch {
    return null
  }
}

/** Names of the generated files that are missing or differ from the registry. Empty means up to date. */
export function staleGenerated(
  registry: Registry<never>,
  dir: string,
): string[] {
  return Object.entries(generate(registry))
    .filter(([name, text]) => read(join(dir, name)) !== text)
    .map(([name]) => name)
}
