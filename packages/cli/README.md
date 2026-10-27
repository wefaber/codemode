# @wefaber/codemode-cli

stdio MCP bridge for WeFaber Code Mode. It forwards `search` and `execute` to a product's (or the gateway's)
`POST /codemode/*`, so local agents that cannot reach a remote MCP server (Claude Code, for instance) can use it.

Requires [Bun](https://bun.sh).

## Usage

```bash
claude mcp add --scope user my-product -- bunx @wefaber/codemode-cli --url https://host.example --token "$WCM_TOKEN"
```

| Option    |                                                                  |
| --------- | ---------------------------------------------------------------- |
| `--url`   | Base URL of the product or gateway                               |
| `--token` | Bearer token. Falls back to the `WCM_TOKEN` environment variable |

Any MCP client can run the same command as a stdio server.

## License

[MIT](./LICENSE) © WeFaber. Part of [wefaber/codemode](https://github.com/wefaber/codemode).
