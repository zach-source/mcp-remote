#!/bin/bash

echo "=== Testing authentication retry mechanism ==="
echo ""
echo "This test will demonstrate the retry mechanism when authentication fails"
echo ""

# Test with a server that might fail authentication
echo "1. Testing with default retry (3 attempts)"
echo "Running: npx tsx src/multi-proxy.ts https://test-server.example.com/sse --debug"
echo ""
echo "If authentication fails, you should see retry attempts..."
echo ""
npx tsx src/multi-proxy.ts https://test-server.example.com/sse --debug

echo ""
echo "2. Testing with custom retry count (5 attempts)"
echo "Running: npx tsx src/multi-proxy.ts https://test-server.example.com/sse --max-retries 5 --debug"
echo ""
npx tsx src/multi-proxy.ts https://test-server.example.com/sse --max-retries 5 --debug

echo ""
echo "3. Testing multi-server with retry"
echo "Running: npx tsx src/multi-proxy.ts https://bindings.mcp.cloudflare.com/sse https://test-server.example.com/sse --max-retries 2 --debug"
echo ""
echo "Even if one server fails, others should still connect"
echo ""
npx tsx src/multi-proxy.ts https://bindings.mcp.cloudflare.com/sse https://test-server.example.com/sse --max-retries 2 --debug

echo ""
echo "Test complete!"