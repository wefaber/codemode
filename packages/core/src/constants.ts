/**
 * Constants of the standard (docs/SPEC.md). CI pins them so a rule change is a visible diff.
 */

/** Version of the WCM standard this package implements. Bump on breaking rule changes. */
export const WCM_SPEC_VERSION = '0.2.0'

/**
 * The MCP surface, and the only legal one (SPEC rule R2). Anything that adds a
 * third tool is a regression: see docs/SPEC.md §11.
 */
export const WCM_MCP_TOOLS = ['search', 'execute'] as const

export type WcmTool = (typeof WCM_MCP_TOOLS)[number]

/** Error codes an execute run may return (SPEC rule R12). */
export const WCM_ERROR_CODES = [
  'TIMEOUT',
  'TOO_MANY_CALLS',
  'CODE_ERROR',
  'HOST_ERROR',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION',
  'RATE_LIMITED',
  'LIMIT_REACHED',
  'UNAUTHENTICATED',
  'PRODUCT_UNAVAILABLE',
  'SPEC_MISMATCH',
] as const

export type WcmErrorCode = (typeof WCM_ERROR_CODES)[number]
