# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

```bash
# Install dependencies
pnpm install

# Build the project
pnpm build

# Watch mode for development
pnpm build:watch

# Run type checking and format checking
pnpm check

# Fix formatting issues
pnpm lint-fix

# Run unit tests
pnpm test:unit

# Watch mode for tests
pnpm test:unit:watch
```

## Architecture Overview

This is a TypeScript project that serves as a proxy bridge between local MCP (Model Context Protocol) clients and remote MCP servers with OAuth support.

### Key Components

1. **proxy.ts** - Main entry point for the proxy server that bridges stdio MCP clients to remote SSE servers

   - Handles OAuth authentication flow
   - Creates bidirectional communication between local stdio and remote SSE
   - Manages auth coordination and token persistence

2. **multi-proxy.ts** - Multi-server proxy that connects to multiple MCP servers simultaneously

   - Supports sequential OAuth authentication for each server
   - Aggregates tools, resources, and prompts from all servers
   - Prefixes tool names to avoid conflicts between servers
   - Routes requests to the appropriate server based on tool prefixes

3. **client.ts** - Standalone client for testing remote MCP server connections

   - Used for debugging and validating server connections
   - Lists available tools and resources from remote servers

4. **Core Libraries in lib/**:
   - `coordination.ts` - Manages OAuth authentication coordination and token persistence
   - `mcp-auth-config.ts` - Handles configuration and token storage in ~/.mcp-auth
   - `node-oauth-client-provider.ts` - Implements OAuth client provider for Node.js
   - `utils.ts` - Shared utilities including connection logic, transport strategies, and CLI parsing

### Transport Strategies

The proxy supports multiple transport strategies for connecting to MCP servers:

- `http-first` (default) - Tries HTTP first, falls back to SSE
- `sse-first` - Tries SSE first, falls back to HTTP
- `http-only` - Only HTTP transport
- `sse-only` - Only SSE transport

### OAuth Flow

1. When connecting to a server requiring auth, the proxy opens a local HTTP server
2. It opens a browser for the user to complete OAuth authentication
3. Tokens are stored in `~/.mcp-auth/{server_hash}_auth.json`
4. Tokens are automatically refreshed when needed

## Build Configuration

- Uses tsup for building with ESM output format
- Entry points: `src/proxy.ts`, `src/multi-proxy.ts`, and `src/client.ts`
- Outputs to `dist/` directory
- TypeScript strict mode enabled
- Target: ES2022
