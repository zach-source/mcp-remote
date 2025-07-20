#!/bin/bash

echo "=== Testing multi-server with existing tokens ==="
echo ""

# Test servers
SERVER1="https://bindings.mcp.cloudflare.com/sse"
SERVER2="https://builds.mcp.cloudflare.com/sse"

echo "1. First run - should authenticate both servers"
echo "Running: npx tsx src/multi-proxy.ts $SERVER1 $SERVER2 --debug"
echo ""
echo "Press Ctrl+C after both servers authenticate successfully"
echo ""
npx tsx src/multi-proxy.ts "$SERVER1" "$SERVER2" --debug

echo ""
echo "2. Second run - should use existing tokens (no authentication needed)"
echo "Running: npx tsx src/multi-proxy.ts $SERVER1 $SERVER2 --debug"
echo ""
echo "This should NOT open browser windows"
echo "Press Ctrl+C after servers connect"
echo ""
npx tsx src/multi-proxy.ts "$SERVER1" "$SERVER2" --debug

echo ""
echo "3. Third run - force fresh authentication for first server only"
echo "Running: npx tsx src/multi-proxy.ts --server $SERVER1 --force-auth --server $SERVER2 --debug"
echo ""
echo "This should only authenticate the first server"
echo "Press Ctrl+C after authentication"
echo ""
npx tsx src/multi-proxy.ts --server "$SERVER1" --force-auth --server "$SERVER2" --debug

echo ""
echo "Test complete!"