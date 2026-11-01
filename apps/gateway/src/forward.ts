import {
  OpError,
  WCM_ERROR_CODES,
  type HostApi,
  type WcmErrorCode,
} from '@wefaber/codemode'
import { majorOf, type ProductEntry } from './catalog.ts'
import { signIdentity, type Identity } from '@wefaber/codemode-mcp'

export type ForwardDeps = {
  secret: string
  timeoutMs: number
  fetch: typeof fetch
  now: () => number
  /** Anything that is not a domain error: logged on the server, the code only sees a generic code. */
  onError: (err: unknown, where: string) => void
}

type Caller = Pick<Identity, 'tokenHash' | 'scopes' | 'label' | 'runId'>

const isCode = (code: unknown): code is WcmErrorCode =>
  (WCM_ERROR_CODES as readonly unknown[]).includes(code)

const unavailable = (product: string) =>
  new OpError('PRODUCT_UNAVAILABLE', `${product} is not available right now`)

/**
 * One operation of one product, as the product understands it: `POST <url>/codemode/execute` with code that calls
 * the operation, and the caller's identity signed. The product validates the input and applies the scope again; the
 * gateway never trusts itself to be the only gate.
 */
async function callProduct(
  deps: ForwardDeps,
  caller: Caller,
  entry: ProductEntry,
  id: string,
  input: unknown,
): Promise<unknown> {
  const code = `return await codemode.${id}(${JSON.stringify(input ?? {})})`
  let res: Response
  try {
    res = await deps.fetch(`${entry.url}/codemode/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(await signIdentity(deps.secret, {
          ...caller,
          timestamp: deps.now(),
        })),
      },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(deps.timeoutMs),
    })
  } catch (err) {
    deps.onError(err, `${entry.product}: fetch`)
    throw unavailable(entry.product)
  }
  if (res.status >= 500) {
    deps.onError(new Error(`HTTP ${res.status}`), `${entry.product}: ${id}`)
    throw unavailable(entry.product)
  }

  // SPEC R8: a product that moved to a major the catalog does not know is refused, not guessed.
  const announced = res.headers.get('x-wcm-spec-version')
  if (announced && majorOf(announced) !== entry.major)
    throw new OpError(
      'SPEC_MISMATCH',
      `${entry.product} is on ${announced}, the catalog knows major ${entry.major}`,
    )

  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    deps.onError(err, `${entry.product}: non-JSON`)
    throw unavailable(entry.product)
  }
  const out = (body ?? {}) as {
    ok?: unknown
    result?: unknown
    truncated?: unknown
    error?: { code?: unknown; message?: unknown }
  }
  if (out.ok === true) {
    if (out.truncated === true)
      throw new OpError(
        'LIMIT_REACHED',
        `${id} returned more than the product allows; ask for less`,
      )
    return out.result ?? null
  }
  const code_ = out.error?.code
  const message =
    typeof out.error?.message === 'string' ? out.error.message : id
  if (res.status === 401 || code_ === 'UNAUTHENTICATED') {
    // The product refused the signed identity: a deployment problem, not something the agent can fix.
    deps.onError(new Error('identity rejected'), `${entry.product}: ${id}`)
    throw new OpError('HOST_ERROR', `${entry.product} rejected the gateway`)
  }
  throw new OpError(isCode(code_) ? code_ : 'HOST_ERROR', message)
}

/**
 * The `codemode.<product>.<resource>.<verb>` namespace of one run: only the operations the token's scopes allow
 * exist in it (SPEC R5), each one forwarded to the product that serves it.
 */
export function buildHost(
  deps: ForwardDeps,
  caller: Caller,
  visible: readonly { product: ProductEntry; op: { id: string } }[],
  /** `onCall` runs before each call and may throw (an `OpError`) to refuse it: the product is not contacted. */
  hooks: { onCall: (id: string, product: string) => void },
): HostApi {
  const api: HostApi = {}
  for (const { product, op } of visible) {
    const path = op.id.split('.')
    let bucket = api
    for (const part of path.slice(0, -1))
      bucket = (bucket[part] ??= {}) as HostApi
    bucket[path.at(-1)!] = async (...args: unknown[]) => {
      hooks.onCall(op.id, product.product)
      return callProduct(deps, caller, product, op.id, args[0])
    }
  }
  return api
}
