#!/usr/bin/env node

/**
 * Multi-Server MCP Proxy with OAuth support
 * A bidirectional proxy between a local STDIO MCP server and multiple remote SSE servers with OAuth authentication.
 *
 * Run with: npx tsx multi-proxy.ts https://server1.example/sse https://server2.example/sse
 */

import { EventEmitter } from 'events'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  connectToRemoteServer,
  log,
  parseMultiServerCommandLineArgs,
  setupSignalHandlers,
  getServerUrlHash,
  TransportStrategy,
  debugLog,
} from './lib/utils'
import { getConfigFilePath, readJsonFile } from './lib/mcp-auth-config'
import { rm } from 'fs/promises'
import { StaticOAuthClientInformationFull, StaticOAuthClientMetadata } from './lib/types'
import { OAuthTokens, OAuthTokensSchema } from '@modelcontextprotocol/sdk/shared/auth.js'
import { NodeOAuthClientProvider } from './lib/node-oauth-client-provider'
import { createLazyAuthCoordinator } from './lib/coordination'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  CompleteRequestSchema,
  SetLevelRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

interface ServerConfig {
  url: string
  callbackPort: number
  headers: Record<string, string>
  transportStrategy: TransportStrategy
  host: string
  staticOAuthClientMetadata: StaticOAuthClientMetadata
  staticOAuthClientInfo: StaticOAuthClientInformationFull
  authorizeResource: string
  forceAuth?: boolean
}

interface ConnectedServer {
  config: ServerConfig
  transport: Transport
  serverInfo: any
  tools: Map<string, any>
  resources: Map<string, any>
  prompts: Map<string, any>
}

class MultiServerProxy {
  private servers: Map<string, ConnectedServer> = new Map()
  private localTransport: StdioServerTransport
  private cleanupFunctions: Array<() => Promise<void>> = []
  private authCompletionPromises: Map<string, Promise<void>> = new Map()

  constructor() {
    this.localTransport = new StdioServerTransport()
  }

  async addServer(config: ServerConfig, maxRetries: number = 3): Promise<void> {
    const serverUrlHash = getServerUrlHash(config.url)

    // Set global hash for debug logging
    global.currentServerUrlHash = serverUrlHash

    log(`Adding server: ${config.url}`)

    // Check if we should use existing tokens or force fresh authentication
    let shouldSkipAuth = false

    if (!config.forceAuth) {
      // Check if valid tokens already exist
      const existingTokens = await readJsonFile<OAuthTokens>(serverUrlHash, 'tokens.json', OAuthTokensSchema)

      if (existingTokens) {
        // Check if tokens are still valid (not expired)
        const timeLeft = existingTokens.expires_in || 0
        const isExpired = timeLeft <= 0

        if (!isExpired && existingTokens.access_token) {
          log(`Found valid existing tokens for ${config.url} (expires in ${timeLeft} seconds)`)
          shouldSkipAuth = true
        } else {
          log(`Existing tokens for ${config.url} are expired or invalid`)
        }
      }
    }

    // Clear tokens if forcing fresh auth or if no valid tokens exist
    if (config.forceAuth || !shouldSkipAuth) {
      try {
        const tokensPath = getConfigFilePath(serverUrlHash, 'tokens.json')
        const clientInfoPath = getConfigFilePath(serverUrlHash, 'client_info.json')

        // Remove existing auth files to force fresh authentication
        await rm(tokensPath).catch(() => {})
        await rm(clientInfoPath).catch(() => {})

        log(`Cleared existing auth tokens for ${config.url}`)
      } catch (error) {
        // Ignore errors if files don't exist
      }
    }

    // Set up event emitter for auth flow
    let events = new EventEmitter()

    // Create a lazy auth coordinator
    let authCoordinator = createLazyAuthCoordinator(serverUrlHash, config.callbackPort, events)

    // Set up a promise that resolves when auth is actually completed
    // Only set up auth completion tracking if we're not skipping auth
    if (!shouldSkipAuth) {
      const authCompletionPromise = new Promise<void>((resolve) => {
        let resolved = false

        // Listen for auth code received event
        events.once('auth-code-received', () => {
          if (!resolved) {
            resolved = true
            log(`OAuth callback received for ${config.url}`)
            // Wait a bit for token exchange to complete
            setTimeout(() => resolve(), 2000)
          }
        })

        // Also listen for successful connection as a fallback
        events.once('auth-success', () => {
          if (!resolved) {
            resolved = true
            resolve()
          }
        })
      })

      // Store the completion promise
      this.authCompletionPromises.set(config.url, authCompletionPromise)
    }

    // Create the OAuth client provider
    const authProvider = new NodeOAuthClientProvider({
      serverUrl: config.url,
      callbackPort: config.callbackPort,
      host: config.host,
      clientName: 'MCP Multi-Server Proxy',
      staticOAuthClientMetadata: config.staticOAuthClientMetadata,
      staticOAuthClientInfo: config.staticOAuthClientInfo,
      authorizeResource: config.authorizeResource,
    })

    // Keep track of the server instance for cleanup
    let server: any = null

    // Define an auth initializer function
    let authInitializer = async () => {
      const authState = await authCoordinator.initializeAuth()

      // Store server in outer scope for cleanup
      server = authState.server

      return {
        waitForAuthCode: authState.waitForAuthCode,
        skipBrowserAuth: authState.skipBrowserAuth,
      }
    }

    // Retry loop for authentication
    let lastError: any
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Connect to remote server with lazy authentication
        const remoteTransport = await connectToRemoteServer(
          null,
          config.url,
          authProvider,
          config.headers,
          authInitializer,
          config.transportStrategy,
        )

        // Store the connected server
        this.servers.set(config.url, {
          config,
          transport: remoteTransport,
          serverInfo: null,
          tools: new Map(),
          resources: new Map(),
          prompts: new Map(),
        })

        // Add cleanup function
        this.cleanupFunctions.push(async () => {
          await remoteTransport.close()
          if (server) {
            server.close()
          }
        })

        log(`Successfully connected to ${config.url}`)

        // Wait for auth completion if there's a pending auth flow
        const authPromise = this.authCompletionPromises.get(config.url)
        if (authPromise) {
          log(`Waiting for OAuth authentication to complete for ${config.url}...`)
          await authPromise
          log(`OAuth authentication completed for ${config.url}`)
          this.authCompletionPromises.delete(config.url)
        }

        // Success - exit retry loop
        return
      } catch (error) {
        lastError = error
        log(`Failed to connect to ${config.url} (attempt ${attempt}/${maxRetries}):`, error)

        if (server) {
          server.close()
          server = null
        }

        // Check if this is an auth-related error
        const errorMessage = (error as any)?.message || String(error)
        const isAuthError =
          errorMessage.includes('auth') ||
          errorMessage.includes('OAuth') ||
          errorMessage.includes('token') ||
          errorMessage.includes('401') ||
          errorMessage.includes('403')

        if (attempt < maxRetries && isAuthError) {
          log(`Retrying authentication for ${config.url} in 5 seconds...`)

          // Clear any stale auth data before retry
          if (!shouldSkipAuth) {
            try {
              const tokensPath = getConfigFilePath(serverUrlHash, 'tokens.json')
              const clientInfoPath = getConfigFilePath(serverUrlHash, 'client_info.json')
              await rm(tokensPath).catch(() => {})
              await rm(clientInfoPath).catch(() => {})
              log(`Cleared auth data for retry`)
            } catch (e) {
              // Ignore cleanup errors
            }
          }

          // Wait before retry
          await new Promise((resolve) => setTimeout(resolve, 5000))

          // Reset auth completion promise for retry
          this.authCompletionPromises.delete(config.url)

          // Recreate auth coordinator for retry
          events = new EventEmitter()
          authCoordinator = createLazyAuthCoordinator(serverUrlHash, config.callbackPort, events)

          // Set up new auth completion tracking
          if (!shouldSkipAuth) {
            const authCompletionPromise = new Promise<void>((resolve) => {
              let resolved = false

              events.once('auth-code-received', () => {
                if (!resolved) {
                  resolved = true
                  log(`OAuth callback received for ${config.url} (retry ${attempt})`)
                  setTimeout(() => resolve(), 2000)
                }
              })

              events.once('auth-success', () => {
                if (!resolved) {
                  resolved = true
                  resolve()
                }
              })
            })

            this.authCompletionPromises.set(config.url, authCompletionPromise)
          }

          // Redefine auth initializer for retry
          authInitializer = async () => {
            const authState = await authCoordinator.initializeAuth()
            server = authState.server
            return {
              waitForAuthCode: authState.waitForAuthCode,
              skipBrowserAuth: authState.skipBrowserAuth,
            }
          }
        } else {
          // Not an auth error or max retries reached
          break
        }
      }
    }

    // All retries failed
    log(`Failed to connect to ${config.url} after ${maxRetries} attempts`)
    throw lastError
  }

  async start(): Promise<void> {
    // Set up the local transport message handlers
    this.setupLocalTransportHandlers()

    // Start the local STDIO server
    await this.localTransport.start()
    log('Multi-server proxy started')
    log(`Connected to ${this.servers.size} servers`)
    log('Press Ctrl+C to exit')
  }

  private setupLocalTransportHandlers(): void {
    this.localTransport.onmessage = async (_message) => {
      const message = _message as any
      log('[Local→Proxy]', message.method || message.id)

      try {
        // Handle different message types
        if (message.method === 'initialize') {
          await this.handleInitialize(message)
        } else if (message.method === 'tools/list') {
          await this.handleListTools(message)
        } else if (message.method === 'tools/call') {
          await this.handleCallTool(message)
        } else if (message.method === 'resources/list') {
          await this.handleListResources(message)
        } else if (message.method === 'resources/read') {
          await this.handleReadResource(message)
        } else if (message.method === 'prompts/list') {
          await this.handleListPrompts(message)
        } else if (message.method === 'prompts/get') {
          await this.handleGetPrompt(message)
        } else if (message.method === 'completion/complete') {
          await this.handleComplete(message)
        } else if (message.method === 'logging/setLevel') {
          await this.handleSetLevel(message)
        } else {
          // Unknown method, send error response
          await this.sendError(message.id, -32601, `Method not found: ${message.method}`)
        }
      } catch (error) {
        log('Error handling message:', error)
        await this.sendError(message.id, -32603, `Internal error: ${error}`)
      }
    }

    this.localTransport.onclose = () => {
      log('Local transport closed')
      this.cleanup()
    }

    this.localTransport.onerror = (error) => {
      log('Local transport error:', error)
    }
  }

  private async handleInitialize(message: any): Promise<void> {
    // Initialize all servers in parallel
    const initPromises = Array.from(this.servers.entries()).map(async ([url, server]) => {
      const initMessage = {
        jsonrpc: '2.0',
        id: `init-${url}`,
        method: 'initialize',
        params: {
          ...message.params,
          clientInfo: {
            ...message.params.clientInfo,
            name: `${message.params.clientInfo.name} (via mcp-remote multi-proxy)`,
          },
        },
      }

      const response = await this.sendToServer(server, initMessage)
      if (response.result) {
        server.serverInfo = response.result.serverInfo

        // Store tools, resources, and prompts with server prefix
        const prefix = this.getServerPrefix(url)

        if (response.result.tools) {
          response.result.tools.forEach((tool: any) => {
            server.tools.set(tool.name, tool)
          })
        }

        if (response.result.resources) {
          response.result.resources.forEach((resource: any) => {
            server.resources.set(resource.name, resource)
          })
        }

        if (response.result.prompts) {
          response.result.prompts.forEach((prompt: any) => {
            server.prompts.set(prompt.name, prompt)
          })
        }
      }

      return response
    })

    const responses = await Promise.all(initPromises)

    // Aggregate all capabilities and server info
    const aggregatedResponse = {
      jsonrpc: '2.0' as const,
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: this.getAllTools().length > 0 ? {} : undefined,
          resources: this.getAllResources().length > 0 ? {} : undefined,
          prompts: this.getAllPrompts().length > 0 ? {} : undefined,
          logging: {},
        },
        serverInfo: {
          name: 'MCP Multi-Server Proxy',
          version: '1.0.0',
        },
      },
    }

    await this.localTransport.send(aggregatedResponse)
  }

  private async handleListTools(message: any): Promise<void> {
    const tools = this.getAllTools()

    const response = {
      jsonrpc: '2.0' as const,
      id: message.id,
      result: {
        tools,
      },
    }

    await this.localTransport.send(response)
  }

  private async handleCallTool(message: any): Promise<void> {
    const { name, ...otherParams } = message.params
    const { server, originalName } = this.parseServerPrefixedName(name)

    if (!server) {
      await this.sendError(message.id, -32602, `Tool not found: ${name}`)
      return
    }

    // Forward to the appropriate server
    const callMessage = {
      jsonrpc: '2.0' as const,
      id: message.id,
      method: 'tools/call',
      params: {
        ...otherParams,
        name: originalName,
      },
    }

    const response = await this.sendToServer(server, callMessage)
    await this.localTransport.send(response)
  }

  private async handleListResources(message: any): Promise<void> {
    const resources = this.getAllResources()

    const response = {
      jsonrpc: '2.0' as const,
      id: message.id,
      result: {
        resources,
      },
    }

    await this.localTransport.send(response)
  }

  private async handleReadResource(message: any): Promise<void> {
    const { uri } = message.params
    const { server, originalName } = this.parseServerPrefixedName(uri)

    if (!server) {
      await this.sendError(message.id, -32602, `Resource not found: ${uri}`)
      return
    }

    // Forward to the appropriate server
    const readMessage = {
      jsonrpc: '2.0' as const,
      id: message.id,
      method: 'resources/read',
      params: {
        uri: originalName,
      },
    }

    const response = await this.sendToServer(server, readMessage)
    await this.localTransport.send(response)
  }

  private async handleListPrompts(message: any): Promise<void> {
    const prompts = this.getAllPrompts()

    const response = {
      jsonrpc: '2.0' as const,
      id: message.id,
      result: {
        prompts,
      },
    }

    await this.localTransport.send(response)
  }

  private async handleGetPrompt(message: any): Promise<void> {
    const { name, ...otherParams } = message.params
    const { server, originalName } = this.parseServerPrefixedName(name)

    if (!server) {
      await this.sendError(message.id, -32602, `Prompt not found: ${name}`)
      return
    }

    // Forward to the appropriate server
    const getPromptMessage = {
      jsonrpc: '2.0' as const,
      id: message.id,
      method: 'prompts/get',
      params: {
        ...otherParams,
        name: originalName,
      },
    }

    const response = await this.sendToServer(server, getPromptMessage)
    await this.localTransport.send(response)
  }

  private async handleComplete(message: any): Promise<void> {
    // For completion, we'll forward to the first server that has completion capability
    // In a more sophisticated implementation, you might want to route based on the reference
    const server = Array.from(this.servers.values())[0]

    if (!server) {
      await this.sendError(message.id, -32602, 'No servers available for completion')
      return
    }

    const response = await this.sendToServer(server, message)
    await this.localTransport.send(response)
  }

  private async handleSetLevel(message: any): Promise<void> {
    // Set logging level on all servers
    const setLevelPromises = Array.from(this.servers.values()).map((server) => this.sendToServer(server, message))

    await Promise.all(setLevelPromises)

    // Send success response
    const response = {
      jsonrpc: '2.0' as const,
      id: message.id,
      result: {},
    }

    await this.localTransport.send(response)
  }

  private async sendToServer(server: ConnectedServer, message: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const originalHandler = server.transport.onmessage

      // Set up one-time response handler
      server.transport.onmessage = (response: any) => {
        if (response.id === message.id) {
          // Restore original handler
          server.transport.onmessage = originalHandler
          resolve(response)
        } else if (originalHandler) {
          // Pass through other messages
          originalHandler(response)
        }
      }

      // Send the message
      server.transport.send(message).catch(reject)
    })
  }

  private async sendError(id: string | number, code: number, message: string): Promise<void> {
    const errorResponse = {
      jsonrpc: '2.0' as const,
      id,
      error: {
        code,
        message,
      },
    }

    await this.localTransport.send(errorResponse)
  }

  private getServerPrefix(url: string): string {
    // Create a simple prefix from the server URL
    const parsed = new URL(url)
    return parsed.hostname.replace(/\./g, '_')
  }

  private getAllTools(): any[] {
    const allTools: any[] = []

    for (const [url, server] of this.servers) {
      const prefix = this.getServerPrefix(url)

      for (const [name, tool] of server.tools) {
        allTools.push({
          ...tool,
          name: `${prefix}:${name}`,
          description: `[${prefix}] ${tool.description || ''}`,
        })
      }
    }

    return allTools
  }

  private getAllResources(): any[] {
    const allResources: any[] = []

    for (const [url, server] of this.servers) {
      const prefix = this.getServerPrefix(url)

      for (const [uri, resource] of server.resources) {
        allResources.push({
          ...resource,
          uri: `${prefix}:${uri}`,
          name: resource.name ? `${prefix}:${resource.name}` : undefined,
          description: `[${prefix}] ${resource.description || ''}`,
        })
      }
    }

    return allResources
  }

  private getAllPrompts(): any[] {
    const allPrompts: any[] = []

    for (const [url, server] of this.servers) {
      const prefix = this.getServerPrefix(url)

      for (const [name, prompt] of server.prompts) {
        allPrompts.push({
          ...prompt,
          name: `${prefix}:${name}`,
          description: `[${prefix}] ${prompt.description || ''}`,
        })
      }
    }

    return allPrompts
  }

  private parseServerPrefixedName(prefixedName: string): { server: ConnectedServer | null; originalName: string } {
    const colonIndex = prefixedName.indexOf(':')

    if (colonIndex === -1) {
      return { server: null, originalName: prefixedName }
    }

    const prefix = prefixedName.substring(0, colonIndex)
    const originalName = prefixedName.substring(colonIndex + 1)

    // Find server by prefix
    for (const [url, server] of this.servers) {
      if (this.getServerPrefix(url) === prefix) {
        return { server, originalName }
      }
    }

    return { server: null, originalName: prefixedName }
  }

  async cleanup(): Promise<void> {
    log('Cleaning up multi-server proxy...')

    await this.localTransport.close()

    for (const cleanup of this.cleanupFunctions) {
      try {
        await cleanup()
      } catch (error) {
        log('Cleanup error:', error)
      }
    }
  }
}

/**
 * Main function to run the multi-server proxy
 */
async function runMultiProxy(configs: ServerConfig[], maxRetries?: number): Promise<void> {
  const proxy = new MultiServerProxy()

  // Connect to all servers sequentially
  for (const config of configs) {
    try {
      await proxy.addServer(config, maxRetries)
    } catch (error) {
      log(`Failed to add server ${config.url}:`, error)
      // Continue with other servers
    }
  }

  // Check if any servers were connected
  if ((proxy as any).servers.size === 0) {
    log('No servers connected successfully')
    process.exit(1)
  }

  // Start the proxy
  await proxy.start()

  // Setup cleanup handler
  setupSignalHandlers(() => proxy.cleanup())
}

// Parse command-line arguments and run the proxy
parseMultiServerCommandLineArgs(process.argv.slice(2))
  .then((result) => runMultiProxy(result.servers, result.maxRetries))
  .catch((error) => {
    log('Fatal error:', error)
    process.exit(1)
  })
