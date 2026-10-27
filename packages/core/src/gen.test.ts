import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { todoRegistry } from '../../../tests/fixtures/todo.ts'
import {
  buildSpec,
  generate,
  OUT_DTS,
  OUT_SPEC,
  renderDts,
  staleGenerated,
  writeGenerated,
} from './index.ts'

const dirs: string[] = []
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'wcm-gen-'))
  dirs.push(dir)
  return dir
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('spec', () => {
  test('lists every op with scope and publishes verbException', () => {
    const spec = buildSpec(todoRegistry)
    expect(spec).toMatchObject({ version: '1.0.0', product: 'todo' })
    expect(spec.ops.map((o) => o.id)).toContain('todo.items.setDone')
    expect(
      spec.ops.find((o) => o.id === 'todo.items.setDone')?.verbException,
    ).toContain('Toggles')
    expect(spec.ops.find((o) => o.id === 'todo.items.list')).not.toHaveProperty(
      'verbException',
    )
  })

  test('named types are emitted once and referenced', () => {
    const spec = buildSpec(todoRegistry)
    expect(Object.keys(spec.types)).toEqual(['Item'])
    expect(spec.types.Item).not.toHaveProperty('$id')
    expect(spec.ops.find((o) => o.id === 'todo.items.get')?.output).toEqual({
      $ref: 'Item',
    })
  })

  test('scopes limit what search sees', () => {
    const ids = (scopes: string[]) =>
      buildSpec(todoRegistry, { scopes }).ops.map((o) => o.id)
    expect(ids(['todo:read'])).not.toContain('todo.items.create')
    expect(ids(['todo:write'])).toContain('todo.items.create')
    expect(ids([])).toEqual([])
  })

  test('the d.ts declares the codemode namespace and the named types', () => {
    const dts = renderDts(todoRegistry)
    expect(dts).toContain('interface Item {')
    expect(dts).toContain('declare const codemode: {')
    expect(dts).toContain('create(input: {')
    expect(dts).toContain('Promise<Item[]>')
    expect(dts).toContain('setDone(input: {')
  })
})

describe('gen / check', () => {
  test('a missing directory is stale, writing makes it current, an edit makes it stale again', () => {
    const dir = join(tmp(), 'out')
    expect(staleGenerated(todoRegistry, dir)).toEqual([OUT_SPEC, OUT_DTS])
    writeGenerated(todoRegistry, dir)
    expect(staleGenerated(todoRegistry, dir)).toEqual([])
    writeFileSync(join(dir, OUT_SPEC), '{}\n')
    expect(staleGenerated(todoRegistry, dir)).toEqual([OUT_SPEC])
  })

  test('CRLF checkouts do not count as stale', () => {
    const dir = tmp()
    for (const [name, text] of Object.entries(generate(todoRegistry)))
      writeFileSync(join(dir, name), text.replace(/\n/g, '\r\n'))
    expect(staleGenerated(todoRegistry, dir)).toEqual([])
  })
})
