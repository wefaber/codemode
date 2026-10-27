#!/usr/bin/env bun
/**
 * stdio MCP server that forwards `search` and `execute` to a product's (or the gateway's) `POST /codemode/*`.
 * For local agents (Claude Code) that cannot reach a remote MCP: `bunx @wefaber/codemode-cli --url https://host`.
 * The token comes from `--token` or `WCM_TOKEN`.
 */
import { handleRpc, type RpcRequest } from '@wefaber/codemode-mcp'

export type StdioOptions = {
  url: string
  token?: string
  /** Name reported as `serverInfo.name` and used in the default texts. */
  product?: string
  input: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>
  write: (line: string) => void
  fetch?: typeof fetch
}

/** Reads newline-delimited JSON-RPC from `input` and answers on `write`. Resolves when `input` ends. */
export async function runStdio(opts: StdioOptions): Promise<void> {
  const doFetch = opts.fetch ?? fetch
  const base = opts.url.replace(/\/+$/, '')
  const info = { product: opts.product ?? 'wefaber' }

  const forward = async (kind: 'search' | 'execute', code: string) => {
    try {
      const res = await doFetch(`${base}/codemode/${kind}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
        body: JSON.stringify({ code }),
      })
      const body: unknown = await res.json()
      return { body, isError: !(body as { ok?: boolean }).ok }
    } catch (err) {
      return {
        body: {
          ok: false,
          error: {
            code: 'PRODUCT_UNAVAILABLE',
            message: err instanceof Error ? err.message : String(err),
          },
        },
        isError: true,
      }
    }
  }

  const decoder = new TextDecoder()
  let buffer = ''
  const handleLine = async (line: string) => {
    if (line.trim() === '') return
    let message: RpcRequest
    try {
      message = JSON.parse(line) as RpcRequest
    } catch {
      opts.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Invalid JSON' },
        }),
      )
      return
    }
    const reply = await handleRpc(message, info, forward)
    if (reply) opts.write(JSON.stringify(reply))
  }

  for await (const chunk of opts.input) {
    buffer +=
      typeof chunk === 'string'
        ? chunk
        : decoder.decode(chunk, { stream: true })
    let at = buffer.indexOf('\n')
    while (at >= 0) {
      await handleLine(buffer.slice(0, at))
      buffer = buffer.slice(at + 1)
      at = buffer.indexOf('\n')
    }
  }
  await handleLine(buffer)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (name: string) => {
    const at = args.indexOf(`--${name}`)
    return at >= 0 ? args[at + 1] : undefined
  }
  const url = flag('url')
  if (!url) {
    console.error(
      'usage: codemode-cli --url <base> [--token <token>] [--product <name>]',
    )
    process.exit(2)
  }
  await runStdio({
    url,
    token: flag('token') ?? process.env.WCM_TOKEN,
    product: flag('product'),
    input: process.stdin as unknown as AsyncIterable<Uint8Array>,
    write: (line) => process.stdout.write(`${line}\n`),
  })
}
