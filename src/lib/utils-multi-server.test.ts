import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseMultiServerCommandLineArgs } from './utils'
import * as fs from 'fs/promises'
import * as mcpAuthConfig from './mcp-auth-config'
import * as net from 'net'
import * as utils from './utils'

// Mock the necessary modules
vi.mock('fs/promises')
vi.mock('./mcp-auth-config')

// Create a proper mock for net module
vi.mock('net', () => {
  const mockServer = {
    on: vi.fn((event, handler) => {
      if (event === 'listening') {
        // Simulate immediate listening
        setTimeout(() => handler(), 0)
      }
      return mockServer
    }),
    listen: vi.fn(() => mockServer),
    close: vi.fn((callback) => {
      if (callback) callback()
      return mockServer
    }),
    address: vi.fn(() => ({ port: 3333 })),
  }

  return {
    default: {
      createServer: vi.fn(() => mockServer),
    },
    createServer: vi.fn(() => mockServer),
  }
})

// Partially mock utils to override specific functions
vi.mock('./utils', async () => {
  const actual = await vi.importActual('./utils')
  return {
    ...actual,
    findAvailablePort: vi.fn().mockResolvedValue(3333),
  }
})

describe('parseMultiServerCommandLineArgs', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks()

    // Mock file system operations
    vi.mocked(fs.readFile).mockResolvedValue('')
    vi.mocked(fs.rm).mockResolvedValue()
    vi.mocked(fs.mkdir).mockResolvedValue()

    // Mock MCP auth config functions
    vi.mocked(mcpAuthConfig.getConfigFilePath).mockReturnValue('/mock/path')
    vi.mocked(mcpAuthConfig.readJsonFile).mockResolvedValue(null)

    // Reset console.log to avoid test output
    vi.spyOn(console, 'log').mockImplementation(() => {})

    // Set up globals that might be used
    global.currentServerUrlHash = 'test-hash'
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Basic server configurations', () => {
    it('should parse a single server URL', async () => {
      const args = ['https://server1.example.com/sse']
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result).toHaveLength(1)
      expect(result[0].url).toBe('https://server1.example.com/sse')
      expect(result[0].transportStrategy).toBe('http-first')
      expect(result[0].host).toBe('localhost')
      expect(result[0].headers).toEqual({})
    })

    it('should parse multiple server URLs', async () => {
      const args = ['https://server1.example.com/sse', 'https://server2.example.com/sse', 'https://server3.example.com/sse']
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result).toHaveLength(3)
      expect(result[0].url).toBe('https://server1.example.com/sse')
      expect(result[1].url).toBe('https://server2.example.com/sse')
      expect(result[2].url).toBe('https://server3.example.com/sse')
    })

    it('should parse servers with --server flag', async () => {
      const args = ['--server', 'https://server1.example.com/sse', '--server', 'https://server2.example.com/sse']
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result).toHaveLength(2)
      expect(result[0].url).toBe('https://server1.example.com/sse')
      expect(result[1].url).toBe('https://server2.example.com/sse')
    })
  })

  describe('Per-server port configuration', () => {
    it('should apply port to the correct server', async () => {
      const args = [
        '--server',
        'https://server1.example.com/sse',
        '--port',
        '3334',
        '--server',
        'https://server2.example.com/sse',
        '--port',
        '3335',
      ]
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result).toHaveLength(2)
      expect(result[0].callbackPort).toBe(3334)
      expect(result[1].callbackPort).toBe(3335)
    })

    it('should use automatic port assignment when not specified', async () => {
      const args = ['https://server1.example.com/sse', '--server', 'https://server2.example.com/sse', '--port', '3334']
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result).toHaveLength(2)
      expect(result[0].callbackPort).toBeGreaterThan(0) // Auto-assigned
      expect(result[1].callbackPort).toBe(3334)
    })
  })

  describe('Per-server headers', () => {
    it('should parse headers for specific servers', async () => {
      const args = [
        '--server',
        'https://server1.example.com/sse',
        '--header',
        'Authorization:Bearer token1',
        '--header',
        'X-Custom:value1',
        '--server',
        'https://server2.example.com/sse',
        '--header',
        'X-API-Key:key2',
      ]
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result).toHaveLength(2)
      expect(result[0].headers).toEqual({
        Authorization: 'Bearer token1',
        'X-Custom': 'value1',
      })
      expect(result[1].headers).toEqual({
        'X-API-Key': 'key2',
      })
    })

    it('should handle environment variable substitution in headers', async () => {
      process.env.TEST_TOKEN = 'secret-token'
      process.env.TEST_KEY = 'api-key-123'

      const args = [
        '--server',
        'https://server1.example.com/sse',
        '--header',
        'Authorization:Bearer ${TEST_TOKEN}',
        '--server',
        'https://server2.example.com/sse',
        '--header',
        'X-API-Key:${TEST_KEY}',
      ]
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result[0].headers).toEqual({
        Authorization: 'Bearer secret-token',
      })
      expect(result[1].headers).toEqual({
        'X-API-Key': 'api-key-123',
      })

      delete process.env.TEST_TOKEN
      delete process.env.TEST_KEY
    })

    it('should handle missing environment variables', async () => {
      const args = ['https://server1.example.com/sse', '--header', 'Authorization:Bearer ${MISSING_VAR}']
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result[0].headers).toEqual({
        Authorization: 'Bearer ',
      })
    })
  })

  describe('Per-server transport strategy', () => {
    it('should apply transport strategy to specific servers', async () => {
      const args = [
        '--server',
        'https://server1.example.com/sse',
        '--transport',
        'sse-only',
        '--server',
        'https://server2.example.com/sse',
        '--transport',
        'http-only',
        '--server',
        'https://server3.example.com/sse',
      ]
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result).toHaveLength(3)
      expect(result[0].transportStrategy).toBe('sse-only')
      expect(result[1].transportStrategy).toBe('http-only')
      expect(result[2].transportStrategy).toBe('http-first') // Default
    })

    it('should handle invalid transport strategies', async () => {
      const args = ['https://server1.example.com/sse', '--transport', 'invalid-strategy']
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result[0].transportStrategy).toBe('http-first') // Default
    })
  })

  describe('Per-server --force-auth flag', () => {
    it('should apply forceAuth to specific servers', async () => {
      const args = [
        '--server',
        'https://server1.example.com/sse',
        '--force-auth',
        '--server',
        'https://server2.example.com/sse',
        '--server',
        'https://server3.example.com/sse',
        '--force-auth',
      ]
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result).toHaveLength(3)
      expect(result[0].forceAuth).toBe(true)
      expect(result[1].forceAuth).toBeUndefined()
      expect(result[2].forceAuth).toBe(true)
    })
  })

  describe('Per-server host configuration', () => {
    it('should apply host to specific servers', async () => {
      const args = [
        '--server',
        'https://server1.example.com/sse',
        '--host',
        '0.0.0.0',
        '--server',
        'https://server2.example.com/sse',
        '--host',
        '127.0.0.1',
      ]
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result).toHaveLength(2)
      expect(result[0].host).toBe('0.0.0.0')
      expect(result[1].host).toBe('127.0.0.1')
    })
  })

  describe('Per-server resource configuration', () => {
    it('should apply resource to specific servers', async () => {
      const args = [
        '--server',
        'https://server1.example.com/sse',
        '--resource',
        'resource1',
        '--server',
        'https://server2.example.com/sse',
        '--resource',
        'resource2',
      ]
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result).toHaveLength(2)
      expect(result[0].authorizeResource).toBe('resource1')
      expect(result[1].authorizeResource).toBe('resource2')
    })
  })

  describe('Mixed configurations', () => {
    it('should handle complex mixed server configurations', async () => {
      const args = [
        'https://server1.example.com/sse',
        '--header',
        'X-First:value1',
        '--server',
        'https://server2.example.com/sse',
        '--port',
        '3334',
        '--header',
        'Authorization:Bearer token2',
        '--transport',
        'sse-only',
        '--force-auth',
        '--server',
        'https://server3.example.com/sse',
        '--host',
        '0.0.0.0',
        '--resource',
        'special-resource',
      ]
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result).toHaveLength(3)

      // First server
      expect(result[0].url).toBe('https://server1.example.com/sse')
      expect(result[0].headers).toEqual({ 'X-First': 'value1' })
      expect(result[0].transportStrategy).toBe('http-first')
      expect(result[0].forceAuth).toBeUndefined()

      // Second server
      expect(result[1].url).toBe('https://server2.example.com/sse')
      expect(result[1].callbackPort).toBe(3334)
      expect(result[1].headers).toEqual({ Authorization: 'Bearer token2' })
      expect(result[1].transportStrategy).toBe('sse-only')
      expect(result[1].forceAuth).toBe(true)

      // Third server
      expect(result[2].url).toBe('https://server3.example.com/sse')
      expect(result[2].host).toBe('0.0.0.0')
      expect(result[2].authorizeResource).toBe('special-resource')
      expect(result[2].forceAuth).toBeUndefined()
    })

    it('should reset configuration for each new server', async () => {
      const args = [
        '--server',
        'https://server1.example.com/sse',
        '--header',
        'X-Header:value1',
        '--transport',
        'sse-only',
        '--force-auth',
        '--server',
        'https://server2.example.com/sse',
      ]
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result).toHaveLength(2)

      // First server has custom values
      expect(result[0].headers).toEqual({ 'X-Header': 'value1' })
      expect(result[0].transportStrategy).toBe('sse-only')
      expect(result[0].forceAuth).toBe(true)

      // Second server has defaults
      expect(result[1].headers).toEqual({})
      expect(result[1].transportStrategy).toBe('http-first')
      expect(result[1].forceAuth).toBeUndefined()
    })
  })

  describe('Global options', () => {
    it('should handle --debug flag', async () => {
      const args = ['--debug', 'https://server1.example.com/sse']
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result).toHaveLength(1)
      // Debug flag doesn't affect server config directly
    })

    it('should handle --allow-http flag', async () => {
      const args = ['--allow-http', 'http://insecure.example.com/sse']
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result).toHaveLength(1)
      expect(result[0].url).toBe('http://insecure.example.com/sse')
    })

    it('should allow HTTP for localhost without flag', async () => {
      const args = ['http://localhost:3000/sse']
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result).toHaveLength(1)
      expect(result[0].url).toBe('http://localhost:3000/sse')
    })

    it('should reject non-HTTPS URLs without --allow-http', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('Process exit')
      })

      const args = ['http://insecure.example.com/sse']

      await expect(parseMultiServerCommandLineArgs(args)).rejects.toThrow('Process exit')
      expect(mockExit).toHaveBeenCalledWith(1)

      mockExit.mockRestore()
    })
  })

  describe('Error handling', () => {
    it('should exit when no servers provided', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('Process exit')
      })

      const args: string[] = []

      await expect(parseMultiServerCommandLineArgs(args)).rejects.toThrow('Process exit')
      expect(mockExit).toHaveBeenCalledWith(1)

      mockExit.mockRestore()
    })

    it('should exit on unknown arguments', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('Process exit')
      })

      const args = ['https://server1.example.com/sse', '--unknown-flag']

      await expect(parseMultiServerCommandLineArgs(args)).rejects.toThrow('Process exit')
      expect(mockExit).toHaveBeenCalledWith(1)

      mockExit.mockRestore()
    })

    it('should handle malformed headers gracefully', async () => {
      const args = ['https://server1.example.com/sse', '--header', 'InvalidHeader']
      const result = await parseMultiServerCommandLineArgs(args)

      expect(result[0].headers).toEqual({})
    })
  })
})
