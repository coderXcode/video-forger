@echo off
:: ─────────────────────────────────────────────────────────────────────────────
::  Video Forger — Claude MCP Bridge (Windows)
::
::  Claude Desktop spawns this .bat file and communicates via stdin/stdout.
::  It tunnels JSON-RPC 2.0 messages to mcp-server.js inside the Docker container.
::
::  Requirements: Docker Desktop must be running with the video-forger container up.
::  Start with: start.ps1  (or: docker compose up -d)
:: ─────────────────────────────────────────────────────────────────────────────
setlocal

set CONTAINER=video-forger
if defined VIDEO_FORGER_CONTAINER set CONTAINER=%VIDEO_FORGER_CONTAINER%

:: Check container is running
docker inspect %CONTAINER% --format "{{.State.Running}}" 2>nul | findstr /i "true" >nul
if errorlevel 1 (
    echo {"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Video Forger is not running. Start it with start.ps1"}}
    exit /b 1
)

docker exec -i %CONTAINER% node /app/mcp-server.js
