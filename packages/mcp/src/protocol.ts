import { WCM_MCP_TOOLS, type WcmTool } from '@wefaber/codemode'

/**
 * MCP over stateless Streamable HTTP, no SSE: every `POST` carries one JSON-RPC message and is answered with JSON.
 * Only what a tools client needs: `initialize`, `ping`, `tools/list` and `tools/call`, with exactly two tools,
 * `search` and `execute` (SPEC R2).
 */

export const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

type Id = string | number | null

export type RpcRequest = {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

export type RpcResponse =
  | { jsonrpc: '2.0'; id: Id; result: unknown }
  | { jsonrpc: '2.0'; id: Id; error: { code: number; message: string } }

export type ToolInfo = {
  /** Product name, `serverInfo.name` and the namespace in the default texts. */
  product: string
  /** Replaces the default `initialize` instructions. */
  instructions?: string
  /** Replaces the default tool descriptions. */
  descriptions?: Partial<Record<WcmTool, string>>
}

const CODE_INPUT = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      description:
        'Body of an async function. Return the result with `return`.',
    },
  },
  required: ['code'],
  additionalProperties: false,
}

export function instructionsFor(info: ToolInfo): string {
  return (
    info.instructions ??
    `${info.product} through Code Mode: two tools. \`search\` runs JavaScript over \`spec\` (the API described as data) ` +
      `and returns only what the code returns: use it to find operations. \`execute\` runs JavaScript with ` +
      `\`codemode.${info.product}.<resource>.<verb>(input)\` (async); chain every call you need in a single run and ` +
      `\`return\` only what matters. No network or files.`
  )
}

export function toolsFor(info: ToolInfo) {
  const text: Record<WcmTool, string> = {
    search:
      'Runs JavaScript over `spec` ({ version, product, ops: [{ id, scope, summary, input, output }], types }) and returns what the code returns. Filter `spec.ops` by id or summary to fetch only what you need.',
    execute: `Runs JavaScript with \`codemode.${info.product}.*\`. Several calls per run; returns what the code returns. Find the operations first with \`search\`.`,
    ...info.descriptions,
  }
  return WCM_MCP_TOOLS.map((name) => ({
    name,
    description: text[name],
    inputSchema: CODE_INPUT,
  }))
}

const ok = (id: Id, result: unknown): RpcResponse => ({
  jsonrpc: '2.0',
  id,
  result,
})
const err = (id: Id, code: number, message: string): RpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
})

/**
 * Handles one message. `null` means "no reply" (notifications). `runTool` runs the code and returns the body shown to
 * the model; the protocol knows nothing about tokens or sandboxes.
 */
export async function handleRpc(
  msg: RpcRequest,
  info: ToolInfo,
  runTool: (
    kind: WcmTool,
    code: string,
  ) => Promise<{ body: unknown; isError: boolean }>,
): Promise<RpcResponse | null> {
  if (
    msg === null ||
    typeof msg !== 'object' ||
    Array.isArray(msg) ||
    msg.jsonrpc !== '2.0' ||
    typeof msg.method !== 'string'
  )
    return err(null, -32600, 'Invalid JSON-RPC message')
  const hasId = typeof msg.id === 'string' || typeof msg.id === 'number'
  if (!hasId) return null // notification (`notifications/initialized`, ...)
  const id = msg.id as Id
  const params = (msg.params ?? {}) as Record<string, unknown>

  switch (msg.method) {
    case 'initialize': {
      const asked = String(params.protocolVersion ?? '')
      return ok(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked)
          ? asked
          : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: info.product, version: '1' },
        instructions: instructionsFor(info),
      })
    }
    case 'ping':
      return ok(id, {})
    case 'tools/list':
      return ok(id, { tools: toolsFor(info) })
    case 'tools/call': {
      const name = params.name
      const args = (params.arguments ?? {}) as Record<string, unknown>
      if (!(WCM_MCP_TOOLS as readonly unknown[]).includes(name))
        return err(id, -32602, `Unknown tool: ${String(name)}`)
      if (typeof args.code !== 'string')
        return err(id, -32602, 'Missing `code` (string)')
      const { body, isError } = await runTool(name as WcmTool, args.code)
      return ok(id, {
        content: [{ type: 'text', text: JSON.stringify(body) }],
        isError,
      })
    }
    default:
      return err(id, -32601, `Unsupported method: ${msg.method}`)
  }
}
