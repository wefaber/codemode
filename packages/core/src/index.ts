/**
 * WeFaber Code Mode — core package.
 *
 * Today this only pins the constants of the standard, so CI has something real
 * to build and test. The registry (`defineOp`), the spec/d.ts generator and the
 * sandbox interfaces land in PLAN.md phase 1 (tasks 1.2 to 1.4).
 *
 * Standard: docs/SPEC.md.
 */

/** Version of the WCM standard this package implements. Bump on breaking rule changes. */
export const WCM_SPEC_VERSION = '0.1.0'

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
  'PRODUCT_UNAVAILABLE',
  'SPEC_MISMATCH',
] as const

export type WcmErrorCode = (typeof WCM_ERROR_CODES)[number]
