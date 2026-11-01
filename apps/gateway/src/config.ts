/** Runtime settings of the gateway. Secrets come from the environment, never from the repo. */
export type GatewayConfig = {
  port: number
  dbPath: string
  /** HMAC key of the identity the gateway forwards to products (`WCM_GATEWAY_SECRET`). */
  secret: string
  /** Wall-clock deadline of one run; it must leave room for the product calls inside it. */
  runTimeoutMs: number
  /** Deadline of one call to a product. */
  productTimeoutMs: number
  /** Runs per minute per token. */
  perMinute: number
  /** Result bytes per day per token (SPEC §8: global budget at the gateway). */
  maxBytesPerDay: number
}

type Env = Record<string, string | undefined>

export function defaultDbPath(env: Env = process.env): string {
  return env.WCM_GATEWAY_DB ?? './gateway.sqlite'
}

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${name} must be a positive integer`)
  return n
}

export function loadConfig(env: Env = process.env): GatewayConfig {
  const secret = env.WCM_GATEWAY_SECRET ?? ''
  if (secret.length < 32)
    throw new Error('WCM_GATEWAY_SECRET must be at least 32 characters')
  return {
    port: int(env, 'PORT', 4171),
    dbPath: defaultDbPath(env),
    secret,
    runTimeoutMs: int(env, 'WCM_RUN_TIMEOUT_MS', 15_000),
    productTimeoutMs: int(env, 'WCM_PRODUCT_TIMEOUT_MS', 10_000),
    perMinute: int(env, 'WCM_RUNS_PER_MINUTE', 60),
    maxBytesPerDay: int(env, 'WCM_MAX_BYTES_PER_DAY', 10 * 1024 * 1024),
  }
}
