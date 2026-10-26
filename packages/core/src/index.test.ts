import { describe, expect, test } from 'bun:test'
import { WCM_ERROR_CODES, WCM_MCP_TOOLS, WCM_SPEC_VERSION } from './index.ts'

describe('wcm core constants', () => {
  test('spec version is semver', () => {
    expect(WCM_SPEC_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('mcp surface is exactly search and execute', () => {
    expect(WCM_MCP_TOOLS).toEqual(['search', 'execute'])
  })

  test('error codes are unique and uppercase', () => {
    const set = new Set(WCM_ERROR_CODES)
    expect(set.size).toBe(WCM_ERROR_CODES.length)
    for (const code of WCM_ERROR_CODES) {
      expect(String(code).toUpperCase()).toBe(String(code))
    }
  })
})
