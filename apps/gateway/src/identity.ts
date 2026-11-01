/**
 * The identity the gateway forwards to a product (SPEC §7): who is calling, with which scopes, in which run, signed
 * with HMAC-SHA256 over `WCM_GATEWAY_SECRET`. A product trusts these headers only after `verifyIdentity` accepts
 * them; it never trusts the body.
 */
export type Identity = {
  /** sha256 of the agent's token. The token itself never leaves the gateway. */
  tokenHash: string
  scopes: string[]
  label: string | null
  /** Gateway run id: every call of one `execute` carries the same one, so products can tie their audit rows to it. */
  runId: string
  /** Unix ms when it was signed. */
  timestamp: number
}

/** A product rejects an identity older (or newer) than this. */
export const MAX_SKEW_MS = 60_000

const enc = new TextEncoder()

/** What is signed: fixed order, one field per line. */
function payload(i: Identity): string {
  return [
    'gateway',
    i.tokenHash,
    i.scopes.join(','),
    i.label ?? '',
    i.runId,
    String(i.timestamp),
  ].join('\n')
}

const hmacKey = (secret: string, usage: 'sign' | 'verify') =>
  crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  )

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex))
    return null
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16))
}

/** The headers the gateway sends with every call to a product. */
export async function signIdentity(
  secret: string,
  identity: Identity,
): Promise<Record<string, string>> {
  const key = await hmacKey(secret, 'sign')
  const signature = toHex(
    await crypto.subtle.sign('HMAC', key, enc.encode(payload(identity))),
  )
  return {
    'x-wcm-via': 'gateway',
    'x-wcm-token-hash': identity.tokenHash,
    'x-wcm-scopes': identity.scopes.join(','),
    'x-wcm-agent': identity.label ?? '',
    'x-wcm-run-id': identity.runId,
    'x-wcm-timestamp': String(identity.timestamp),
    'x-wcm-signature': signature,
  }
}

/** The identity in `headers` if the signature is valid and fresh, otherwise `null`. For products behind the gateway. */
export async function verifyIdentity(
  secret: string,
  headers: Headers,
  opts: { now?: number; maxSkewMs?: number } = {},
): Promise<Identity | null> {
  if (headers.get('x-wcm-via') !== 'gateway') return null
  const tokenHash = headers.get('x-wcm-token-hash')
  const scopes = headers.get('x-wcm-scopes')
  const runId = headers.get('x-wcm-run-id')
  const stamp = headers.get('x-wcm-timestamp')
  const signature = fromHex(headers.get('x-wcm-signature') ?? '')
  if (!tokenHash || scopes === null || !runId || !stamp || !signature)
    return null
  const timestamp = Number(stamp)
  if (!Number.isFinite(timestamp)) return null
  const now = opts.now ?? Date.now()
  if (Math.abs(now - timestamp) > (opts.maxSkewMs ?? MAX_SKEW_MS)) return null
  const identity: Identity = {
    tokenHash,
    scopes: scopes === '' ? [] : scopes.split(','),
    label: headers.get('x-wcm-agent') || null,
    runId,
    timestamp,
  }
  const key = await hmacKey(secret, 'verify')
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    enc.encode(payload(identity)),
  )
  return valid ? identity : null
}
