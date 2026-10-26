import type { WcmErrorCode } from './constants.ts'

/**
 * Domain error an operation throws (SPEC R12): the sandbox and the transports carry the code, never the stack.
 * Any error with a string `code` crosses the host boundary the same way, so a product's own error class works too.
 */
export class OpError extends Error {
  readonly code: WcmErrorCode
  constructor(code: WcmErrorCode, message: string) {
    super(message)
    this.name = 'OpError'
    this.code = code
  }
}

/** The string `code` of an error, if it has one. */
export function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}
