#!/usr/bin/env node
/**
 * Video Forger — MCP Server  (stdio transport, MCP protocol 2024-11-05)
 *
 * Exposes Video Forger as a Model Context Protocol tool server for Claude.
 * Claude Desktop spawns this process and communicates via JSON-RPC 2.0 over
 * stdin / stdout.  All tool calls are proxied to the running Express server
 * (default: http://localhost:3000).
 *
 * Tools:
 *   get_video_capabilities   – what can be built + TSX format guide
 *   list_compositions        – list uploaded TSX compositions
 *   create_composition       – create/replace a composition (name + TSX code)
 *   update_composition       – alias for create_composition
 *   render_video             – trigger a render, returns jobId
 *   get_render_status        – poll job progress + output URL
 *   list_rendered_videos     – list finished .mp4 files
 *   delete_composition       – remove a composition
 *
 * Usage:  node mcp-server.js
 * Env:    VIDEO_FORGER_URL  (default: http://localhost:3000)
 */

'use strict';

const http  = require('http');
const https = require('https');
const rl    = require('readline');

const BASE = (process.env.VIDEO_FORGER_URL || 'http://localhost:3000').replace(/\/$/, '');

// ── HTTP helper ───────────────────────────────────────────────────────────────
function apiRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const fullUrl = BASE + urlPath;
    const url     = new URL(fullUrl);
    const lib     = url.protocol === 'https:' ? https : http;
    const payload = body != null ? JSON.stringify(body) : null;

    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        if (res.statusCode >= 400) {
          const msg = (parsed && parsed.error) ? parsed.error : `HTTP ${res.statusCode}`;
          reject(new Error(msg));
        } else {
          resolve(parsed);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function get_video_capabilities() {
  try {
    const data = await apiRequest('GET', '/api/mcp/capabilities');
    return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  } catch {
    // Server not reachable — return local fallback with BASE substituted in
    return STATIC_CAPABILITIES.replace(/\$\{VIDEO_FORGER_URL\}/g, BASE);
  }
}

async function list_compositions() {
  const list = await apiRequest('GET', '/api/compositions');
  if (!Array.isArray(list) || !list.length) return 'No compositions uploaded yet.';
  return list.map(c =>
    `• ${c.name}  (${c.meta.durationInFrames}f @ ${c.meta.fps}fps = ` +
    `${(c.meta.durationInFrames / c.meta.fps).toFixed(1)}s, ${c.meta.width}×${c.meta.height})`
  ).join('\n');
}

async function create_composition({ name, content }) {
  if (!name || typeof name !== 'string') throw new Error('"name" is required');
  if (!content || typeof content !== 'string') throw new Error('"content" is required');
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const result = await apiRequest('PUT', `/api/compositions/${encodeURIComponent(safeName)}`, { content });
  return `✅ Composition "${safeName}" saved.\nMeta: ${JSON.stringify(result.meta)}`;
}

async function render_video({ name }) {
  if (!name) throw new Error('"name" is required');
  const result = await apiRequest('POST', `/api/render/${encodeURIComponent(name)}`);
  return [
    `🎬 Render started!`,
    `Job ID: ${result.jobId}`,
    `Call get_render_status with jobId="${result.jobId}" to track progress.`,
    `Typical render time for a 30s video: 2–5 minutes.`,
  ].join('\n');
}

async function get_render_status({ jobId }) {
  if (!jobId) throw new Error('"jobId" is required');
  const job = await apiRequest('GET', `/api/jobs/${encodeURIComponent(jobId)}`);
  const dur = job.endTime
    ? `${((job.endTime - job.startTime) / 1000).toFixed(1)}s`
    : 'in progress';
  const lines = [
    `Status:    ${job.status}`,
    `Progress:  ${job.progress}%`,
    `Duration:  ${dur}`,
  ];
  if (job.outputFilename)
    lines.push(`Video URL: ${BASE}/api/videos/stream/${encodeURIComponent(job.outputFilename)}`);
  if (job.error)
    lines.push(`Error:     ${job.error}`);
  if (job.status === 'complete')
    lines.push(`\nThe video is ready! Share the Video URL above with the user so they can watch or download it.`);
  return lines.join('\n');
}

async function list_rendered_videos() {
  const list = await apiRequest('GET', '/api/videos');
  if (!Array.isArray(list) || !list.length) return 'No rendered videos yet.';
  return list.map(v =>
    `• ${v.filename}  (${(v.size / 1024 / 1024).toFixed(1)} MB)\n` +
    `  Play/Download: ${BASE}${v.url}`
  ).join('\n\n');
}

async function delete_composition({ name }) {
  if (!name) throw new Error('"name" is required');
  await apiRequest('DELETE', `/api/compositions/${encodeURIComponent(name)}`);
  return `🗑️  Composition "${name}" deleted.`;
}

async function generate_narration({ text, filename, voiceName, speakingRate, pitch }) {
  if (!text || typeof text !== 'string' || !text.trim())
    throw new Error('"text" is required');
  const body = { text };
  if (filename)     body.filename     = filename;
  if (voiceName)    body.voiceName    = voiceName;
  if (speakingRate) body.speakingRate = speakingRate;
  if (pitch !== undefined) body.pitch = pitch;
  const result = await apiRequest('POST', '/api/tts/google', body);
  return [
    `✅ Narration audio generated!`,
    `Filename : ${result.filename}`,
    `Public URL: ${result.publicUrl}`,
    `Audio src : ${BASE}${result.publicUrl}`,
    ``,
    `Use this in your TSX composition:`,
    `<Audio src="${BASE}${result.publicUrl}" volume={0.9} />`,
    ``,
    `Note: The URL above uses localhost:3000 which is correct — it resolves`,
    `inside the Docker container at render time.`,
  ].join('\n');
}

const TOOL_HANDLERS = {
  get_video_capabilities: get_video_capabilities,
  list_compositions:      list_compositions,
  create_composition:     create_composition,
  update_composition:     create_composition,   // same logic
  render_video:           render_video,
  get_render_status:      get_render_status,
  list_rendered_videos:   list_rendered_videos,
  delete_composition:     delete_composition,
  generate_narration:     generate_narration,
};

// ── Tool definitions (sent to Claude in tools/list) ───────────────────────────
const TOOL_DEFS = [
  {
    name: 'get_video_capabilities',
    description:
      'Returns the full guide: video types Video Forger can produce, TSX composition ' +
      'format requirements, available Remotion APIs, duration guide, and a minimal starter ' +
      'template. Call this FIRST before writing any TSX code so you understand the format.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_compositions',
    description:
      'List all uploaded TSX compositions currently available for rendering, with duration, fps, and resolution.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_composition',
    description:
      'Create (or replace) a video composition by providing its name and full TSX source code. ' +
      'The first line must be the @remotion metadata comment. The file must export a default React component. ' +
      'Returns saved composition metadata. After saving, call render_video to produce the MP4.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Composition name — alphanumeric + underscores only, no spaces (e.g. "ProductDemo2024")',
        },
        content: {
          type: 'string',
          description:
            'Complete TSX source code. Must begin with:\n' +
            '// @remotion durationInFrames=900 fps=30 width=1920 height=1080\n' +
            'Then import statements, then export default function MyComp() { ... }',
        },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'update_composition',
    description: 'Update the TSX code of an existing composition. Identical signature to create_composition.',
    inputSchema: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Composition name to update' },
        content: { type: 'string', description: 'New full TSX source code' },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'render_video',
    description:
      'Trigger rendering of a named composition into an MP4 file. Returns a jobId. ' +
      'Poll get_render_status with that jobId to track completion (typically 2–5 min for 30s video).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Composition name to render (must exist in list_compositions)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_render_status',
    description:
      'Get the current status (pending/running/complete/error), progress %, render duration, ' +
      'and the direct video stream URL once complete.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job ID returned by render_video' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'list_rendered_videos',
    description: 'List all previously rendered .mp4 video files with their direct streaming/download URLs.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'delete_composition',
    description: 'Permanently delete a TSX composition by name. Rendered videos are not affected.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Composition name to delete' },
      },
      required: ['name'],
    },
  },
  {
    name: 'generate_narration',
    description:
      'Generate a voice-over audio file from text using Google AI Studio TTS. ' +
      'Returns the public URL of the generated audio file. ' +
      'Use the returned "Audio src" value in your TSX composition with <Audio src="..."> — ' +
      'it resolves correctly inside the Docker container at render time. ' +
      'Requires GOOGLE_AI_STUDIO_API_KEY to be set in the server environment.',
    inputSchema: {
      type: 'object',
      properties: {
        text:         { type: 'string',  description: 'The narration text to synthesize into speech' },
        filename:     { type: 'string',  description: 'Output filename (no extension). Defaults to a timestamp-based name.' },
        voiceName:    { type: 'string',  description: 'TTS voice name (e.g. "Kore", "Puck", "Aoede"). Defaults to server setting.' },
        speakingRate: { type: 'number',  description: 'Speaking rate multiplier 0.25–4.0. Default 1.0.' },
        pitch:        { type: 'number',  description: 'Pitch adjustment -20.0 to 20.0. Default 0.0.' },
      },
      required: ['text'],
    },
  },
];

// ── Static capabilities fallback (used if server is not yet reachable) ─────────
const STATIC_CAPABILITIES = `
# Video Forger — Video Capabilities

## What is Video Forger?
Remotion renders React/TypeScript compositions into MP4 video files using headless Chromium.
Each video frame is a React component snapshot — giving you programmatic, pixel-perfect video.

## Required TSX Format
Every composition file MUST:
1. Start with a @remotion metadata comment on line 1:
   // @remotion durationInFrames=900 fps=30 width=1920 height=1080
2. Import React + needed Remotion APIs
3. Export a DEFAULT React function component

## Core Remotion APIs
- useCurrentFrame()                  → current frame number (0 to durationInFrames-1)
- useVideoConfig()                   → { width, height, fps, durationInFrames }
- interpolate(frame, [in], [out])    → smoothly animate a value over frames
- spring({ frame, fps, config })     → physics spring animation (0 → 1)
- <AbsoluteFill>                     → full-size positioned container
- <Sequence from={n} durationInFrames={n}>  → time-shifted child content
- <Audio src="url" volume={0.5} />   → audio track (use ABSOLUTE URL for runtime audio)
- <Video src="url" />                → embedded video
- <Img src="url" />                  → frame-safe image

## Video Types You Can Create

### 1. Product / Feature Demo
Animated slides showcasing product features with text overlays, icons, smooth transitions.
Duration: 30s (900 frames @ 30fps). Resolution: 1920×1080.

### 2. Explainer / Narrated
Visuals synchronized to narration. TTS voice via Google AI Studio.
Use <Audio src="\${VIDEO_FORGER_URL}/api/audio/mcpforger-narration" /> (replace \${VIDEO_FORGER_URL} with the value of the VIDEO_FORGER_URL env var, default http://localhost:3000) for pre-generated voice,
or POST /api/tts/google { text, filename } to generate custom audio.

### 3. Data Visualization
Animate bar charts, counters, line graphs using interpolate() for smooth number transitions.

### 4. Animated Title Card / Logo Reveal
Spring-animated text entries, fade-ins, scale effects — great for intros and outros.

### 5. Code Walkthrough
Syntax-highlighted code blocks revealed line by line using <Sequence> components.

### 6. Social Media Short (9:16 vertical)
Set width=1080 height=1920 in the metadata comment — for Reels / TikTok / Shorts.

### 7. Presentation / Slides
Multi-scene video with chapter transitions, bullet points revealed with spring animations.

### 8. Countdown Timer / Event Promo
Animated countdown with glow/particle background effects.

## Duration Guide
- 15s  = 450 frames   (social short)
- 30s  = 900 frames   (standard)
- 60s  = 1800 frames  (long form)
- 90s  = 2700 frames  (max recommended)

## Minimal Working Template
\`\`\`tsx
// @remotion durationInFrames=300 fps=30 width=1920 height=1080
import React from 'react';
import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';

export default function MyVideo() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: 'clamp' });
  const scale   = spring({ frame, fps, config: { stiffness: 80 } });

  return (
    <AbsoluteFill style={{ background: '#0f0f0f', justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ opacity, transform: \`scale(\${scale})\`, color: '#fff', fontSize: 64, fontFamily: 'sans-serif' }}>
        Hello, Remotion!
      </div>
    </AbsoluteFill>
  );
}
\`\`\`

## Workflow
1. Call get_video_capabilities (already done — you are reading it)
2. Write TSX code following the format above
3. Call create_composition with the name and code
4. Call render_video with the composition name
5. Poll get_render_status until status === "complete"
6. Share the Video URL with the user
`.trim();

// ── MCP JSON-RPC 2.0 protocol ─────────────────────────────────────────────────
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function dispatchToolCall(id, toolName, args) {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) {
    respondError(id, -32601, `Unknown tool: ${toolName}`);
    return;
  }
  try {
    const text = await handler(args || {});
    respond(id, {
      content: [{ type: 'text', text: String(text) }],
      isError: false,
    });
  } catch (e) {
    respond(id, {
      content: [{ type: 'text', text: `Error: ${e.message}` }],
      isError: true,
    });
  }
}

// ── Main stdin loop ───────────────────────────────────────────────────────────
const iface = rl.createInterface({ input: process.stdin, terminal: false });

iface.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }

  const { id, method, params } = msg;

  // Notifications have no id — no response expected
  if (id == null) return;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'video-forger', version: '1.0.0' },
      });
      break;

    case 'tools/list':
      respond(id, { tools: TOOL_DEFS });
      break;

    case 'tools/call':
      await dispatchToolCall(id, params && params.name, params && params.arguments);
      break;

    case 'ping':
      respond(id, {});
      break;

    case 'resources/list':
      respond(id, { resources: [] });
      break;

    case 'prompts/list':
      respond(id, { prompts: [] });
      break;

    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
});

iface.on('close', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
