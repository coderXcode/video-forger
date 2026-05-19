# ─────────────────────────────────────────────────────────────────────────────
#  Video Forger — start.ps1 (Windows)
#
#  PowerShell launcher for Windows users.
#  Usage:  Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
#          .\start.ps1
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Host ""
Write-Host "  __   ___     _             _____" -ForegroundColor Cyan
Write-Host "  \ \ / (_)   | |           |  ___|__  _ __ __ _  ___ _ __" -ForegroundColor Cyan
Write-Host "   \ V /| | __| | ___  ___  | |_ / _ \| '__/ _\` |/ _ \ '__|" -ForegroundColor Cyan
Write-Host "    | | | |/ _\` |/ _ \/ _ \ |  _| (_) | | | (_| |  __/ |" -ForegroundColor Cyan
Write-Host "    |_| |_|\__,_|\___/\___/ |_|  \___/|_|  \__, |\___|_|" -ForegroundColor Cyan
Write-Host "                                             __/ |" -ForegroundColor Cyan
Write-Host "                                            |___/" -ForegroundColor Cyan
Write-Host ""
Write-Host "Video Forger - AI Video Generation Platform" -ForegroundColor Green
Write-Host ""

# ── Check Docker ──────────────────────────────────────────────────────────────
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Docker not found. Install Docker Desktop: https://www.docker.com/products/docker-desktop" -ForegroundColor Red
    exit 1
}

try { docker info | Out-Null } catch {
    Write-Host "ERROR: Docker daemon is not running. Start Docker Desktop and try again." -ForegroundColor Red
    exit 1
}
Write-Host "Docker daemon is running" -ForegroundColor Green

# ── Auto-detect available port ────────────────────────────────────────────────
$StudioPort = $env:STUDIO_PORT
if (-not $StudioPort) {
    $StudioPort = 3000
    while ($true) {
        $conn = Test-NetConnection -ComputerName 127.0.0.1 -Port $StudioPort -WarningAction SilentlyContinue
        if (-not $conn.TcpTestSucceeded) { break }
        $StudioPort++
        if ($StudioPort -gt 3019) {
            Write-Host "ERROR: No free port in range 3000-3019. Set STUDIO_PORT manually." -ForegroundColor Red
            exit 1
        }
    }
    if ($StudioPort -ne 3000) {
        Write-Host "WARNING: Port 3000 is busy, using port $StudioPort" -ForegroundColor Yellow
    }
}
$env:STUDIO_PORT = $StudioPort

# ── Stop old container if named remotion-studio ───────────────────────────────
$oldContainer = docker ps -a --filter "name=remotion-studio" --format "{{.Names}}" 2>$null
if ($oldContainer -eq "remotion-studio") {
    Write-Host "Stopping old 'remotion-studio' container..." -ForegroundColor Yellow
    docker stop remotion-studio 2>$null | Out-Null
    docker rm remotion-studio 2>$null | Out-Null
}

# ── Create directories ────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path "$ScriptDir\project_mnts\uploaded_tsx" | Out-Null
New-Item -ItemType Directory -Force -Path "$ScriptDir\project_mnts\generated_videos" | Out-Null

# ── Build & Start ─────────────────────────────────────────────────────────────
Set-Location $ScriptDir

$dc = if (docker compose version 2>$null) { "docker compose" } else { "docker-compose" }

Write-Host "Building Docker image (first run ~3 min)..." -ForegroundColor Yellow
Invoke-Expression "$dc build"

Write-Host "Starting services..." -ForegroundColor Yellow
Invoke-Expression "$dc up -d"

# ── Wait for health check ─────────────────────────────────────────────────────
Write-Host "Waiting for dashboard..." -ForegroundColor Yellow
$timeout = 90; $elapsed = 0; $ready = $false
while ($elapsed -lt $timeout) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$StudioPort/api/health" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep 2; $elapsed += 2; Write-Host "." -NoNewline
}
Write-Host ""

if (-not $ready) {
    Write-Host "ERROR: Dashboard did not start in time." -ForegroundColor Red
    exit 1
}

# ── Copy mcp-server.js into container ────────────────────────────────────────
docker cp "$ScriptDir\mcp-server.js" "video-forger:/app/mcp-server.js" 2>$null | Out-Null

# ── Claude Desktop MCP Registration ──────────────────────────────────────────
Write-Host ""
Write-Host "Configuring Claude Desktop MCP plugin..." -ForegroundColor Yellow

$batBridge = "$ScriptDir\mcp-docker-bridge.bat"
$claudeCfgDir = "$env:APPDATA\Claude"
$claudeCfgPath = "$claudeCfgDir\claude_desktop_config.json"

if (Test-Path $claudeCfgDir) {
    if (-not (Test-Path $claudeCfgDir)) { New-Item -ItemType Directory -Path $claudeCfgDir | Out-Null }
    $config = @{}
    if (Test-Path $claudeCfgPath) {
        try { $config = Get-Content $claudeCfgPath | ConvertFrom-Json -AsHashtable } catch {}
    }
    if (-not $config.mcpServers) { $config.mcpServers = @{} }
    $config.mcpServers["video-forger"] = @{
        command = "cmd"
        args = @("/c", $batBridge)
        env = @{}
    }
    $config | ConvertTo-Json -Depth 10 | Set-Content $claudeCfgPath
    Write-Host "Registered as Claude Desktop MCP plugin: $claudeCfgPath" -ForegroundColor Green
    Write-Host "Quit and reopen Claude Desktop to activate." -ForegroundColor Yellow
} else {
    Write-Host "Claude Desktop not detected - skipping auto-registration." -ForegroundColor Blue
    Write-Host "Install at: https://claude.ai/download" -ForegroundColor Blue
}

# ── Done ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Video Forger is ready!" -ForegroundColor Green
Write-Host "  Dashboard  -> http://localhost:$StudioPort" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Stop:    $dc down"
Write-Host "Logs:    $dc logs -f video-forger"
Write-Host ""

Start-Process "http://localhost:$StudioPort"
