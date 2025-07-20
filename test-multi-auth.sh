#!/bin/bash

echo "Testing multi-server sequential authentication..."
echo "This will clear existing auth tokens and force fresh authentication for each server."
echo ""

# Clear any existing auth tokens
echo "Clearing existing auth tokens..."
rm -rf ~/.mcp-auth/*

echo ""
echo "Starting multi-proxy with two servers..."
echo "You should see two separate OAuth flows, one for each server."
echo ""

# Run the multi-proxy with debug mode
npx tsx src/multi-proxy.ts \
  https://bindings.mcp.cloudflare.com/sse \
  https://builds.mcp.cloudflare.com/sse \
  --debug