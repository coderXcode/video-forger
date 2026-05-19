#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Video Forger — start.sh
#  Builds the Docker image (if needed) and starts the dashboard.
#  Usage:  chmod +x start.sh && ./start.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[0;34m'; NC='\033[0m'

echo -e "${B}"
cat << 'EOF'
  __   ___     _             _____
  \ \ / (_)   | |           |  ___|__  _ __ __ _  ___ _ __
   \ V /| | __| | ___  ___  | |_ / _ \| '__/ _` |/ _ \ '__|
    | | | |/ _` |/ _ \/ _ \ |  _| (_) | | | (_| |  __/ |
    |_| |_|\__,_|\___/\___/ |_|  \___/|_|  \__, |\___|_|
                                             __/ |
                                            |___/
EOF
echo -e "${NC}"
echo -e "${G}🎬  Video Forger — AI Video Generation Platform${NC}"
echo ""

# ── Config (override via env vars before running) ────────────────────────────
STUDIO_CONTAINER="${STUDIO_CONTAINER:-video-forger}"

# ── Auto-detect available host port ─────────────────────────────────────────
if [ -z "${STUDIO_PORT:-}" ]; then
  STUDIO_PORT="3000"
  while nc -z 127.0.0.1 "$STUDIO_PORT" 2>/dev/null; do
    STUDIO_PORT=$((STUDIO_PORT + 1))
    if [ "$STUDIO_PORT" -gt 3019 ]; then
      echo -e "${R}❌  No free port found in range 3000–3019. Set STUDIO_PORT manually.${NC}"; exit 1
    fi
  done
  [ "$STUDIO_PORT" != "3000" ] && echo -e "${Y}⚠️   Port 3000 is busy — using port ${STUDIO_PORT}${NC}"
fi
export STUDIO_PORT

# ── Check dependencies ────────────────────────────────────────────────────────
need() {
  if ! command -v "$1" &>/dev/null; then
    echo -e "${R}❌  $1 not found. $2${NC}"; exit 1
  fi
}

need docker "Install Docker Desktop → https://www.docker.com/products/docker-desktop"

if ! docker info &>/dev/null 2>&1; then
  echo -e "${R}❌  Docker daemon is not running. Start Docker Desktop and try again.${NC}"
  exit 1
fi
echo -e "${G}✅  Docker daemon is running${NC}"

# Prefer "docker compose" (v2) over "docker-compose" (v1)
if docker compose version &>/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose &>/dev/null; then
  DC="docker-compose"
else
  echo -e "${R}❌  Docker Compose not found. Update Docker Desktop.${NC}"; exit 1
fi
echo -e "${G}✅  Docker Compose available${NC}"

# ── Create host directories (persisted via volume mount) ──────────────────────
echo ""
echo -e "${Y}📁  Preparing project directories...${NC}"
mkdir -p project_mnts/uploaded_tsx
mkdir -p project_mnts/generated_videos
echo -e "${G}   ✅  project_mnts/uploaded_tsx${NC}"
echo -e "${G}   ✅  project_mnts/generated_videos${NC}"

# ── Build ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${Y}🐳  Building Docker image (first run takes ~3 min — Chromium is large)...${NC}"
$DC build

# ── Start ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${Y}🚀  Starting services...${NC}"

# Stop old container if it was previously named remotion-studio (migration)
if docker inspect remotion-studio &>/dev/null 2>&1; then
  echo -e "${Y}🔄  Stopping old 'remotion-studio' container (renamed to video-forger)...${NC}"
  docker stop remotion-studio &>/dev/null && docker rm remotion-studio &>/dev/null || true
fi

$DC up -d

# ── Wait for health check ─────────────────────────────────────────────────────
echo -e "${Y}⏳  Waiting for dashboard to be ready...${NC}"
TIMEOUT=90; ELAPSED=0; READY=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  if curl -sf "http://localhost:${STUDIO_PORT}/api/health" > /dev/null 2>&1; then
    READY=1; break
  fi
  sleep 2; ELAPSED=$((ELAPSED+2)); printf '.'
done
echo ""

if [ $READY -ne 1 ]; then
  echo -e "${R}❌  Dashboard did not start in time.${NC}"
  echo -e "    Check logs: ${Y}$DC logs ${STUDIO_CONTAINER}${NC}"; exit 1
fi

# ── Claude MCP Plugin Registration ───────────────────────────────────────────
echo ""
echo -e "${Y}🤖  Configuring Claude MCP plugin...${NC}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_BRIDGE="${SCRIPT_DIR}/mcp-docker-bridge.sh"
CLAUDE_MCP_STATUS="skipped"

# Ensure bridge script is executable
chmod +x "$MCP_BRIDGE"

# macOS: remove the quarantine extended attribute that blocks script execution.
# This is the most common cause of "Operation not permitted" errors when Claude
# tries to spawn the bridge script.
if [[ "$(uname -s)" == "Darwin" ]]; then
  xattr -d com.apple.quarantine "$MCP_BRIDGE" 2>/dev/null || true
  xattr -d com.apple.quarantine "${SCRIPT_DIR}/start.sh" 2>/dev/null || true
fi

# Push the latest mcp-server.js into the running container so the bridge works
if docker inspect "${STUDIO_CONTAINER}" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
  docker cp "${SCRIPT_DIR}/mcp-server.js" "${STUDIO_CONTAINER}:/app/mcp-server.js" 2>/dev/null || true
fi

if command -v python3 &>/dev/null; then
  RESULT=$(python3 -c "
import json, sys, pathlib, shutil

container = sys.argv[1]

if sys.platform == 'darwin':
    cfg_dir = pathlib.Path.home() / 'Library' / 'Application Support' / 'Claude'
elif sys.platform.startswith('linux'):
    cfg_dir = pathlib.Path.home() / '.config' / 'Claude'
elif sys.platform == 'win32':
    cfg_dir = pathlib.Path.home() / 'AppData' / 'Roaming' / 'Claude'
else:
    print('SKIP_OS')
    sys.exit(0)

cfg_path = cfg_dir / 'claude_desktop_config.json'
claude_exists = cfg_dir.exists() or bool(shutil.which('claude'))

if not claude_exists:
    print('SKIP_NOT_INSTALLED')
    sys.exit(0)

cfg_dir.mkdir(parents=True, exist_ok=True)

try:
    with open(cfg_path) as f:
        config = json.load(f)
except Exception:
    config = {}

config.setdefault('mcpServers', {})

# Use 'docker exec' directly as the command — no bridge script, no sandbox issues.
# Docker is a trusted binary at /usr/local/bin/docker so Claude Desktop allows it.
if sys.platform == 'win32':
    config['mcpServers']['video-forger'] = {
        'command': 'docker',
        'args': ['exec', '-i', container, 'node', '/app/mcp-server.js']
    }
else:
    config['mcpServers']['video-forger'] = {
        'command': 'docker',
        'args': ['exec', '-i', container, 'node', '/app/mcp-server.js']
    }

with open(cfg_path, 'w') as f:
    json.dump(config, f, indent=2)

print('OK:' + str(cfg_path))
" "$STUDIO_CONTAINER" 2>&1)

  case "$RESULT" in
    OK:*)
      CFG_PATH="${RESULT#OK:}"
      CLAUDE_MCP_STATUS="registered"
      echo -e "${G}  ✅  Registered as Claude Desktop MCP plugin${NC}"
      echo -e "      Config: ${Y}${CFG_PATH}${NC}"
      if pgrep -ix "Claude" > /dev/null 2>&1; then
        echo -e "${Y}  ⚠️   Claude is running — quit and reopen Claude Desktop to activate the plugin${NC}"
      else
        echo -e "${G}  💡  Open Claude Desktop — Video Forger will appear as an MCP tool${NC}"
      fi
      ;;
    SKIP_NOT_INSTALLED)
      echo -e "${B}  ℹ️   Claude Desktop not detected — skipping auto-registration${NC}"
      echo -e "      Install it at: ${Y}https://claude.ai/download${NC}"
      echo -e "      Then re-run ./start.sh to register automatically."
      ;;
    SKIP_OS)
      echo -e "${B}  ℹ️   MCP auto-registration not supported on this OS${NC}"
      echo -e "      Add the entry below to Claude Desktop's config manually."
      ;;
    *)
      echo -e "${Y}  ⚠️   MCP registration issue: ${RESULT}${NC}"
      ;;
  esac
else
  echo -e "${Y}  ⚠️   python3 not found — skipping MCP auto-registration${NC}"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${G}══════════════════════════════════════════════════════════════${NC}"
echo -e "${G}  ✅  Video Forger is ready!${NC}"
echo -e "${G}  🌐  Dashboard  → http://localhost:${STUDIO_PORT}${NC}"
if [ "$CLAUDE_MCP_STATUS" = "registered" ]; then
echo -e "${G}  🤖  Claude MCP → Open Claude Desktop and ask it to make a video!${NC}"
fi
echo -e "${G}══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Stop:      ${Y}$DC down${NC}"
echo -e "  Logs:      ${Y}$DC logs -f ${STUDIO_CONTAINER}${NC}"
echo -e "  Rebuild:   ${Y}$DC up --build -d${NC}"
echo ""
if [ "$CLAUDE_MCP_STATUS" = "registered" ]; then
echo -e "${B}🤖  Claude MCP tools available:${NC}"
echo -e "    get_video_capabilities  — ask Claude what kinds of videos it can make"
echo -e "    create_composition      — Claude writes TSX code and uploads it"
echo -e "    render_video            — Claude triggers rendering"
echo -e "    get_render_status       — Claude polls until video is ready"
echo -e "    list_rendered_videos    — Claude lists finished videos with links"
echo ""
echo -e "  Try saying to Claude Desktop:"
echo -e "    ${Y}\"Make me a 30 second product demo video for my SaaS app\"${NC}"
echo ""
fi
echo -e "${B}ℹ️   Remotion is used for rendering. License: free for teams ≤ 3. See https://remotion.dev/license${NC}"
echo ""

# ── Open browser ─────────────────────────────────────────────────────────────
if command -v open &>/dev/null; then          # macOS
  open "http://localhost:${STUDIO_PORT}"
elif command -v xdg-open &>/dev/null; then    # Linux with display
  xdg-open "http://localhost:${STUDIO_PORT}" &>/dev/null &
fi
