/** Hard ceilings of a run (SPEC R6). Configurable, never absent. */
export type Limits = {
  /** Wall-clock deadline for the whole run, including awaited host calls. */
  timeoutMs: number
  memoryBytes: number
  stackBytes: number
  /** Max host calls per run. */
  maxCalls: number
  /** Max characters of the JSON result. */
  maxResultChars: number
  maxConsoleLines: number
}

export const DEFAULT_LIMITS: Limits = {
  timeoutMs: 5_000,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 512 * 1024,
  maxCalls: 50,
  maxResultChars: 64 * 1024,
  maxConsoleLines: 200,
}

/** Agent code: up to 32 KB. */
export const MAX_CODE_CHARS = 32 * 1024
/** Request body: up to 64 KB. */
export const MAX_BODY_BYTES = 64 * 1024
