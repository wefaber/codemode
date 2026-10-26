import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bin = join(import.meta.dir, 'bin.ts')
const registry = join(import.meta.dir, '../../../tests/fixtures/todo.ts')
const out = mkdtempSync(join(tmpdir(), 'wcm-bin-'))
afterAll(() => rmSync(out, { recursive: true, force: true }))

const wcm = (command: string, dir = out) =>
  Bun.spawnSync(['bun', bin, command, '--registry', registry, '--out', dir])

describe('wcm', () => {
  test('check fails before gen, passes after, fails again when the spec is edited by hand', () => {
    expect(wcm('check').exitCode).toBe(1)
    expect(wcm('gen').exitCode).toBe(0)
    expect(wcm('check').exitCode).toBe(0)
    writeFileSync(join(out, 'spec.json'), '{}\n')
    const stale = wcm('check')
    expect(stale.exitCode).toBe(1)
    expect(stale.stderr.toString()).toContain('spec.json')
  })

  test('bad usage exits 2', () => {
    expect(Bun.spawnSync(['bun', bin, 'nope']).exitCode).toBe(2)
  })
})
