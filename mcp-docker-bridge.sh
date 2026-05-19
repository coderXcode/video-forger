#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Video Forger — Claude MCP Bridge
#
#  This script is the entry-point registered in Claude Desktop's MCP config.
#  Claude spawns it and communicates via stdin/stdout (JSON-RPC 2.0).
#  It tunnels that communication into the running Docker container where the
#  MCP server (mcp-server.js) runs alongside the Express server.
#
#  Requirements: Docker must be running with the video-forger container up.
#  (Start with: ./start.sh)
# ─────────────────────────────────────────────────────────────────────────────

CONTAINER="${VIDEO_FORGER_CONTAINER:-video-forger}"

if ! docker inspect "$CONTAINER" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
  # Container is not running — send a JSON-RPC error and exit
  printf '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Video Forger is not running. Start it with: cd %s && ./start.sh"}}\n' "$(dirname "$0")"
  exit 1
fi

exec docker exec -i "$CONTAINER" node /app/mcp-server.js
