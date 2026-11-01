import { describe, expect, test } from 'bun:test'
import {
  MAX_SKEW_MS,
  signIdentity,
  verifyIdentity,
  type Identity,
} from './identity.ts'

const SECRET = 's'.repeat(40)
const NOW = 1_800_000_000_000
const identity: Identity = {
  tokenHash: 'a'.repeat(64),
  scopes: ['todo:read', 'note:write'],
  label: 'hermes',
  runId: 'run-1',
  timestamp: NOW,
}

const headersOf = async (i: Identity = identity, secret = SECRET) =>
  new Headers(await signIdentity(secret, i))

describe('forwarded identity', () => {
  test('a signed identity verifies and round-trips', async () => {
    const got = await verifyIdentity(SECRET, await headersOf(), { now: NOW })
    expect(got).toEqual(identity)
  })

  test('an identity without label or scopes verifies', async () => {
    const bare = { ...identity, scopes: [], label: null }
    const got = await verifyIdentity(SECRET, await headersOf(bare), {
      now: NOW,
    })
    expect(got).toEqual(bare)
  })

  test('tampering with any signed header is rejected', async () => {
    for (const [name, value] of [
      ['x-wcm-scopes', 'todo:admin'],
      ['x-wcm-token-hash', 'b'.repeat(64)],
      ['x-wcm-run-id', 'run-2'],
      ['x-wcm-agent', 'someone-else'],
    ] as const) {
      const h = await headersOf()
      h.set(name, value)
      expect(await verifyIdentity(SECRET, h, { now: NOW })).toBeNull()
    }
  })

  test('another secret is rejected', async () => {
    const h = await headersOf(identity, 'x'.repeat(40))
    expect(await verifyIdentity(SECRET, h, { now: NOW })).toBeNull()
  })

  test('an old or future timestamp is rejected', async () => {
    const h = await headersOf()
    expect(
      await verifyIdentity(SECRET, h, { now: NOW + MAX_SKEW_MS + 1 }),
    ).toBeNull()
    expect(
      await verifyIdentity(SECRET, h, { now: NOW - MAX_SKEW_MS - 1 }),
    ).toBeNull()
    expect(
      await verifyIdentity(SECRET, h, { now: NOW + MAX_SKEW_MS }),
    ).not.toBeNull()
  })

  test('missing headers, a wrong via or a malformed signature are rejected', async () => {
    expect(await verifyIdentity(SECRET, new Headers())).toBeNull()
    for (const [name, value] of [
      ['x-wcm-via', 'direct'],
      ['x-wcm-signature', 'zz'],
      ['x-wcm-signature', 'abc'],
    ] as const) {
      const h = await headersOf()
      h.set(name, value)
      expect(await verifyIdentity(SECRET, h, { now: NOW })).toBeNull()
    }
    const h = await headersOf()
    h.delete('x-wcm-timestamp')
    expect(await verifyIdentity(SECRET, h, { now: NOW })).toBeNull()
  })
})
