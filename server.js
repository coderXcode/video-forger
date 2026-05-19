/**
 * Video Forger — Dashboard Server
 * Serves the dashboard UI and exposes a REST API for:
 *  - Managing TSX composition files
 *  - Triggering Remotion renders
 *  - Listing generated videos
 */

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const { spawn } = require('child_process');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Directory paths ───────────────────────────────────────────────────────────
const APP_DIR  = __dirname;
const MNTS     = path.join(APP_DIR, 'project_mnts');
const UPLOADS  = path.join(MNTS, 'uploaded_tsx');
const VIDEOS   = path.join(MNTS, 'generated_videos');
const SRC_DIR  = path.join(APP_DIR, 'src');
const ROOT_TSX = path.join(SRC_DIR, 'Root.tsx');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const AUDIO_DIR  = path.join(PUBLIC_DIR, 'audio');

// Guarantee directories exist at startup
[UPLOADS, VIDEOS, SRC_DIR, PUBLIC_DIR, AUDIO_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

function loadDotEnv() {
  const envPath = path.join(APP_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['\"]|['\"]$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadDotEnv();

function getAiStudioApiKey() {
  return process.env.GOOGLE_AI_STUDIO_API_KEY || process.env.GEMINI_API_KEY || '';
}

function requireEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function extFromMime(mimeType) {
  if (!mimeType) return 'wav';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
  if (mimeType.toLowerCase().includes('l16')) return 'wav';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'wav';
}

function parseSampleRateFromMime(mimeType) {
  if (!mimeType) return 24000;
  const match = mimeType.match(/rate=(\d+)/i);
  return match ? Number(match[1]) : 24000;
}

function pcm16ToWavBuffer(pcmBuffer, sampleRate, channels = 1) {
  const bytesPerSample = 2;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

function isValidWavFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    return buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WAVE';
  } catch (_) {
    return false;
  }
}

async function synthesizeWithAiStudio({ text, voiceName, model }) {
  const apiKey = getAiStudioApiKey();
  if (!apiKey) {
    throw new Error('AI Studio API key missing. Set GOOGLE_AI_STUDIO_API_KEY in .env');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  };

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`Gemini API ${resp.status}: ${raw.slice(0, 500)}`);
  }

  const json = JSON.parse(raw);
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const audioPart = parts.find((part) => part?.inlineData?.data);
  if (!audioPart?.inlineData?.data) {
    throw new Error(`No inline audio returned by Gemini. Response: ${raw.slice(0, 500)}`);
  }

  return {
    mimeType: audioPart.inlineData.mimeType || 'audio/wav',
    data: audioPart.inlineData.data,
  };
}

async function synthesizeGoogleTtsToFile({
  text,
  filename,
  voiceName,
  speakingRate,
  pitch,
}) {
  const model = requireEnv('GOOGLE_AI_STUDIO_TTS_MODEL');
  const fullText = [
    'Read this as a polished product demo voiceover.',
    'Tone: warm, confident, professional, and precise.',
    'Avoid sounding robotic, rushed, or exaggerated.',
    `Speaking rate ${speakingRate}. Pitch ${pitch}.`,
    '',
    text,
  ].join('\n');
  const gemini = await synthesizeWithAiStudio({
    text: fullText,
    voiceName,
    model,
  });

  const ext = extFromMime(gemini.mimeType);
  const cleaned = filename.replace(/\.(wav|mp3|ogg)$/i, '');
  const finalName = `${cleaned}.${ext}`;
  const outPath = path.join(AUDIO_DIR, finalName);
  let audioBuffer = Buffer.from(gemini.data, 'base64');

  // AI Studio TTS commonly returns raw 16-bit PCM (`audio/L16`). Wrap it into WAV.
  if (gemini.mimeType && gemini.mimeType.toLowerCase().includes('l16')) {
    const sampleRate = parseSampleRateFromMime(gemini.mimeType);
    audioBuffer = pcm16ToWavBuffer(audioBuffer, sampleRate, 1);
  }

  fs.writeFileSync(outPath, audioBuffer);
  return {
    filePath: outPath,
    publicUrl: `/audio/${finalName}`,
    mimeType: gemini.mimeType,
  };
}

async function ensureMcpForgerNarrationAudio() {
  const narrationBase = 'mcp-forger-narration-pro';
  const existing = fs.readdirSync(AUDIO_DIR).find((f) => new RegExp(`^${narrationBase}\\.(wav|mp3|ogg)$`, 'i').test(f));
  if (existing) {
    const outPath = path.join(AUDIO_DIR, existing);
    if (existing.toLowerCase().endsWith('.wav') && !isValidWavFile(outPath)) {
      try { fs.unlinkSync(outPath); } catch (_) {}
    } else {
      return { filePath: outPath, publicUrl: `/audio/${existing}`, created: false };
    }
  }

  const script = [
    'Introducing MCP Forger.',
    'It turns your app, API, repository, or uploaded code into a production-ready MCP server.',
    'Instead of writing boilerplate and mapping endpoints by hand, MCP Forger automatically forges each route into a tool your AI can use.',
    'That means Claude Desktop, Claude Code, Codex, and other MCP clients can start working with your software immediately.',
    'You also get automatic updates when your API changes, AI-generated tests, version history, a management dashboard, and Docker-ready deployment.',
    'Install it in seconds, forge your app, and put your software to work as an AI teammate.',
    'MCP Forger. Your software, ready for AI.',
  ].join(' ');

  const result = await synthesizeGoogleTtsToFile({
    text: script,
    filename: narrationBase,
    voiceName: requireEnv('GOOGLE_AI_STUDIO_TTS_VOICE'),
    speakingRate: Number(requireEnv('GOOGLE_AI_STUDIO_TTS_SPEAKING_RATE')),
    pitch: Number(requireEnv('GOOGLE_AI_STUDIO_TTS_PITCH')),
  });

  return { ...result, created: true };
}

async function resolveMcpForgerNarrationAudio() {
  return ensureMcpForgerNarrationAudio();
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(APP_DIR, 'public')));
app.use(express.static(APP_DIR));

// Serve dashboard shell from project root.
app.get('/', (_, res) => {
  res.sendFile(path.join(APP_DIR, 'index.html'));
});

// ── Multer (file uploads) ────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (req, file, cb) => {
      // Sanitise filename, ensure .tsx extension
      let name = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!name.endsWith('.tsx') && !name.endsWith('.ts')) name += '.tsx';
      cb(null, name);
    },
  }),
  fileFilter: (req, file, cb) => {
    if (!file.originalname.match(/\.(tsx|ts)$/i))
      return cb(new Error('Only .tsx / .ts files are accepted'));
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
});

// ── In-memory render job store ────────────────────────────────────────────────
// { jobId → { id, compositionName, status, progress, logs, outputFilename,
//             startTime, endTime, error } }
const jobs = new Map();

// ── Root.tsx generator ────────────────────────────────────────────────────────
/**
 * Read the first @remotion metadata comment from a TSX file.
 * Falls back to sensible defaults if not found.
 */
function readMeta(filepath) {
  const defaults = { durationInFrames: 900, fps: 30, width: 1920, height: 1080 };
  try {
    const head = fs.readFileSync(filepath, 'utf8').split('\n').slice(0, 5).join('\n');
    const m = head.match(
      /@remotion\s+durationInFrames=(\d+)\s+fps=(\d+)\s+width=(\d+)\s+height=(\d+)/
    );
    if (m) return {
      durationInFrames: +m[1], fps: +m[2], width: +m[3], height: +m[4],
    };
  } catch (_) {}
  return defaults;
}

/**
 * Regenerate src/Root.tsx from the current contents of project_mnts/uploaded_tsx/.
 * Called after every upload, save, or delete.
 */
function generateRootTsx() {
  const files = fs.readdirSync(UPLOADS).filter(f => /\.(tsx|ts)$/.test(f));

  if (files.length === 0) {
    fs.writeFileSync(ROOT_TSX,
`import React from 'react';
import {Composition} from 'remotion';

// Auto-generated by Video Forger. Upload a composition via the dashboard.
export const RemotionRoot: React.FC = () => <></>;
`);
    console.log('Root.tsx: empty (no compositions)');
    return;
  }

  const names   = files.map(f => path.basename(f, path.extname(f)));
  const imports = names
    .map(n => `import ${n} from '../project_mnts/uploaded_tsx/${n}';`)
    .join('\n');

  const comps = files.map(f => {
    const n = path.basename(f, path.extname(f));
    const m = readMeta(path.join(UPLOADS, f));
    return (
      `      <Composition\n` +
      `        id="${n}"\n` +
      `        component={${n}}\n` +
      `        durationInFrames={${m.durationInFrames}}\n` +
      `        fps={${m.fps}}\n` +
      `        width={${m.width}}\n` +
      `        height={${m.height}}\n` +
      `      />`
    );
  }).join('\n');

  fs.writeFileSync(ROOT_TSX,
`import React from 'react';
import {Composition} from 'remotion';

// ⚠️  Auto-generated by Video Forger — do not edit manually.
${imports}

export const RemotionRoot: React.FC = () => (
  <>
${comps}
  </>
);
`);
  console.log(`Root.tsx: regenerated (${files.length} composition${files.length > 1 ? 's' : ''})`);
}

// ── API: Health ───────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) =>
  res.json({ status: 'ok', uptime: Math.round(process.uptime()), version: '1.0.0' })
);

// ── Composition path helper (prevents path traversal) ───────────────────────
function safeCompositionPath(name) {
  const resolved = path.resolve(UPLOADS, `${name}.tsx`);
  if (!resolved.startsWith(path.resolve(UPLOADS) + path.sep))
    throw Object.assign(new Error('Invalid composition name'), { status: 400 });
  return resolved;
}

// ── API: Compositions ─────────────────────────────────────────────────────────
app.get('/api/compositions', (_, res) => {
  try {
    const list = fs.readdirSync(UPLOADS).filter(f => /\.(tsx|ts)$/.test(f)).map(f => {
      const fp   = path.join(UPLOADS, f);
      const stat = fs.statSync(fp);
      return {
        name:     path.basename(f, path.extname(f)),
        filename: f,
        size:     stat.size,
        modified: stat.mtime,
        created:  stat.birthtime || stat.ctime,
        meta:     readMeta(fp),
      };
    });
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/compositions/:name', (req, res) => {
  try {
    const fp = safeCompositionPath(req.params.name);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
    res.json({ name: req.params.name, content: fs.readFileSync(fp, 'utf8'), meta: readMeta(fp) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/compositions', upload.single('file'), (req, res) => {
  try {
    const name = path.basename(req.file.filename, path.extname(req.file.filename));
    generateRootTsx();
    res.json({ success: true, name, filename: req.file.filename, meta: readMeta(path.join(UPLOADS, req.file.filename)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/compositions/:name', (req, res) => {
  try {
    const fp = safeCompositionPath(req.params.name);
    if (!req.body || typeof req.body.content !== 'string')
      return res.status(400).json({ error: 'content is required' });
    fs.writeFileSync(fp, req.body.content, 'utf8');
    generateRootTsx();
    res.json({ success: true, meta: readMeta(fp) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/compositions/:name', (req, res) => {
  try {
    const fp = safeCompositionPath(req.params.name);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
    fs.unlinkSync(fp); generateRootTsx(); res.json({ success: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── API: Text-to-Speech ──────────────────────────────────────────────────────
app.post('/api/tts/google', async (req, res) => {
  try {
    const {
      text,
      filename,
      voiceName,
      speakingRate,
      pitch,
    } = req.body || {};

    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }

    const safeName = typeof filename === 'string' && filename.trim()
      ? path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_')
      : `tts-${Date.now()}`;

    const result = await synthesizeGoogleTtsToFile({
      text,
      filename: safeName,
      voiceName,
      speakingRate,
      pitch,
    });

    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tts/mcpforger-narration', async (_, res) => {
  try {
    const result = await ensureMcpForgerNarrationAudio();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/audio/mcpforger-narration', async (_, res) => {
  try {
    const result = await resolveMcpForgerNarrationAudio();
    const ext = path.extname(result.filePath).toLowerCase();
    const mimeType = ext === '.mp3'
      ? 'audio/mpeg'
      : ext === '.ogg'
        ? 'audio/ogg'
        : 'audio/wav';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(result.filePath).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Render engine ─────────────────────────────────────────────────────────────
app.post('/api/render/:name', (req, res) => {
  const { name } = req.params;
  if (!fs.existsSync(path.join(UPLOADS, `${name}.tsx`)))
    return res.status(404).json({ error: `Composition "${name}" not found` });

  const jobId    = crypto.randomUUID();
  const ts       = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile  = path.join(VIDEOS, `${name}-${ts}.mp4`);

  jobs.set(jobId, {
    id: jobId, compositionName: name,
    status: 'pending', progress: 0,
    logs: [], outputFilename: null,
    startTime: Date.now(), endTime: null, error: null,
  });

  res.json({ jobId });
  setImmediate(() => runRender(jobId, name, outFile));
});

async function runRender(jobId, name, outFile) {
  const job = jobs.get(jobId);
  job.status = 'running';

  const narrationComps = (process.env.NARRATION_COMPOSITIONS || 'MCPForgerVideoNarrated,MCPForgerVideoStudioNarrated')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (narrationComps.includes(name)) {
    try {
      const tts = await ensureMcpForgerNarrationAudio();
      job.logs.push(`[tts] narration ${tts.created ? 'generated' : 'cached'} at ${tts.publicUrl}`);
    } catch (e) {
      job.logs.push(`[tts] skipped Google TTS pregen: ${e.message}`);
    }
  }

  // Build render command arguments
  const args = [
    'remotion', 'render',
    'src/index.ts',
    name,
    outFile,
    '--overwrite',
    '--log=verbose',
    '--gl=swangle',            // software WebGL — required in Docker
  ];

  // Use system Chromium if env var is set
  const chromePath = process.env.CHROMIUM_PATH || '';
  if (chromePath && fs.existsSync(chromePath))
    args.push(`--browser-executable=${chromePath}`);

  console.log(`[render] start  job=${jobId}  composition=${name}`);

  const proc = spawn('npx', args, {
    cwd: APP_DIR,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const onLine = line => {
    if (!line.trim()) return;
    const normalized = line.length > 1000 ? `${line.slice(0, 1000)} ...[truncated]` : line;
    job.logs.push(normalized);
    if (job.logs.length > 600) job.logs.shift();

    // Strict parse: only from explicit render progress lines.
    const renderedMatch = normalized.match(/Rendered\s+(\d+)\s*\/\s*(\d+)/i);
    if (renderedMatch) {
      const current = Number(renderedMatch[1]);
      const total = Number(renderedMatch[2]);
      if (Number.isFinite(current) && Number.isFinite(total) && total > 0 && current >= 0 && current <= total) {
        const pct = Math.round((current / total) * 99);
        if (pct > job.progress) job.progress = pct;
      }
      return;
    }

    const renderingFrameMatch = normalized.match(/Rendering frame\s+(\d+)\s*\/\s*(\d+)\s*\((\d+(?:\.\d+)?)%\)/i);
    if (renderingFrameMatch) {
      const pct = Number(renderingFrameMatch[3]);
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
        job.progress = Math.max(job.progress, Math.min(pct, 99));
      }
    }
  };

  proc.stdout.on('data', d => d.toString().split('\n').forEach(onLine));
  proc.stderr.on('data', d => d.toString().split('\n').forEach(onLine));

  proc.on('close', code => {
    job.endTime = Date.now();
    if (code === 0) {
      job.status = 'complete';
      job.progress = 100;
      job.outputFilename = path.basename(outFile);
      console.log(`[render] done   job=${jobId}  output=${outFile}`);
    } else {
      job.status = 'error';
      job.error  = `Process exited with code ${code}`;
      console.error(`[render] failed job=${jobId}  code=${code}`);
    }
  });

  proc.on('error', err => {
    job.status = 'error';
    job.error  = err.message;
    job.endTime = Date.now();
  });
}

// ── API: Jobs ─────────────────────────────────────────────────────────────────
app.get('/api/jobs', (_, res) =>
  res.json([...jobs.values()].sort((a, b) => b.startTime - a.startTime))
);

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── API: Videos ───────────────────────────────────────────────────────────────
app.get('/api/videos', (_, res) => {
  try {
    const list = fs.readdirSync(VIDEOS)
      .filter(f => /\.(mp4|webm|mov)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(VIDEOS, f));
        // Strip trailing timestamp: "Name-2024-01-02T03-04-05-678Z.mp4" → "Name"
        const comp = f.replace(/-\d{4}-\d{2}-\d{2}T[\d-]+Z\.(mp4|webm)$/i, '');
        return {
          filename: f, composition: comp,
          size: stat.size,
          created: stat.birthtime || stat.ctime,
          modified: stat.mtime,
          url: `/api/videos/stream/${encodeURIComponent(f)}`,
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stream video with range support (for HTML5 video seek)
app.get('/api/videos/stream/:filename', (req, res) => {
  const fp = path.join(VIDEOS, decodeURIComponent(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).send('Not found');

  const stat  = fs.statSync(fp);
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end   = endStr ? parseInt(endStr, 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'video/mp4',
    });
    fs.createReadStream(fp, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' });
    fs.createReadStream(fp).pipe(res);
  }
});

app.delete('/api/videos/:filename', (req, res) => {
  const fp = path.join(VIDEOS, decodeURIComponent(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(fp); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Stats ────────────────────────────────────────────────────────────────
app.get('/api/stats', (_, res) => {
  try {
    const compFiles  = fs.readdirSync(UPLOADS).filter(f => /\.(tsx|ts)$/.test(f));
    const videoFiles = fs.readdirSync(VIDEOS).filter(f => /\.(mp4|webm)$/i.test(f));
    const totalBytes = videoFiles.reduce(
      (acc, f) => acc + fs.statSync(path.join(VIDEOS, f)).size, 0
    );
    const jList = [...jobs.values()];
    res.json({
      compositions:     compFiles.length,
      totalVideos:      videoFiles.length,
      totalVideoSizeMB: (totalBytes / 1024 / 1024).toFixed(1),
      jobsRunning:      jList.filter(j => j.status === 'running').length,
      jobsCompleted:    jList.filter(j => j.status === 'complete').length,
      jobsFailed:       jList.filter(j => j.status === 'error').length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── AI Chat helpers ────────────────────────────────────────────────────────────

/**
 * Call Gemini generateContent (text-only, non-TTS) for the chat endpoint.
 * Returns the first text part of the response.
 */
async function geminiChat(systemPrompt, turns) {
  const apiKey = getAiStudioApiKey();
  if (!apiKey) throw new Error('GOOGLE_AI_STUDIO_API_KEY not set');

  // Use a stable fast text model
  const model = 'gemini-2.0-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // Build contents array: system instruction + actual turns
  const contents = [];

  // Gemini supports a "system_instruction" field at top level
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: turns.map(t => ({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: t.content }],
    })),
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192,
    },
  };

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const raw = await resp.text();
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${raw.slice(0, 400)}`);

  const json = JSON.parse(raw);
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Empty Gemini response: ${raw.slice(0, 400)}`);
  return text;
}

/**
 * Extract a fenced code block from a Gemini reply.
 * Returns { tsx: string } or null if not found.
 */
function extractTsxBlock(text) {
  // Match ```tsx ... ``` or ```typescript ... ``` or plain ``` ... ```
  const m = text.match(/```(?:tsx|typescript|ts)?\s*\n([\s\S]*?)```/);
  if (m) return { tsx: m[1].trim() };
  return null;
}

/**
 * Derive a safe composition name from the user's message.
 * e.g. "product demo for Acme Corp" → "ProductDemoForAcmeCorp"
 */
function deriveCompName(message) {
  const words = message
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  if (!words.length) return 'MyVideo';
  return words.join('') || 'MyVideo';
}

/**
 * List composition names already on disk.
 */
function listCompositionNames() {
  try {
    return fs.readdirSync(UPLOADS)
      .filter(f => /\.(tsx|ts)$/.test(f))
      .map(f => path.basename(f, path.extname(f)));
  } catch (_) { return []; }
}

// ── API: Chat status ──────────────────────────────────────────────────────────

app.get('/api/chat/status', (_, res) => {
  res.json({ hasKey: !!getAiStudioApiKey() });
});

// ── API: Chat ─────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  if (!getAiStudioApiKey()) {
    return res.status(400).json({ error: 'GOOGLE_AI_STUDIO_API_KEY is not set. Add it to .env and restart.' });
  }

  const existingComps = listCompositionNames();

  // Determine whether the user is asking to create/update a composition
  // or just asking a question / requesting a render
  const lc = message.toLowerCase();
  const isRenderRequest = /^(render|generate|make|create.*render|go|yes|do it|render it|show me|start|run)\b/.test(lc);
  const isIterationRequest = existingComps.length > 0 && /\b(change|update|edit|modify|fix|make the|add|remove|use|adjust|bigger|smaller|darker|lighter|faster|slower)\b/.test(lc);

  // Build the system prompt with full capability context
  const systemPrompt = `You are an expert video creator assistant embedded in Video Forger, an AI-powered video generation platform.
Video Forger renders TypeScript/TSX compositions using Remotion (React-based). Your job:
1. When a user describes a video, write a COMPLETE, WORKING TSX file and output it in a fenced code block (triple backticks tsx).
2. When a user asks for changes/iterations, rewrite the full TSX file incorporating those changes.
3. When a user just wants to render, say so and set autoRender to true — don't generate new code.
4. For general questions about video types/what's possible, answer helpfully.

=== TSX RULES (read carefully) ===
- LINE 1 must be: // @remotion durationInFrames=<N> fps=30 width=1920 height=1080
- Must have: import React from 'react';
- Must have: import { AbsoluteFill, useCurrentFrame, ... } from 'remotion';
- Must have a DEFAULT EXPORT function component.
- Use interpolate() with extrapolateRight:'clamp' to prevent values going out of range.
- For vertical (9:16): width=1080 height=1920
- For 30s video: durationInFrames=900
- For 60s video: durationInFrames=1800
- NO external npm packages. Only: react, remotion.
- For audio: <Audio src="http://localhost:3000/audio/filename.wav" /> (absolute URL only)
- Always produce complete, beautiful, production-ready animations.

=== EXISTING COMPOSITIONS ===
${existingComps.length ? existingComps.map(n => `- ${n}`).join('\n') : 'None yet'}

=== RESPONSE FORMAT ===
Always respond conversationally first (1-3 sentences describing what you made/changed/doing).
Then if you wrote TSX code, output a SINGLE fenced tsx code block.
If the user is asking to render something, don't write new code — just confirm you'll render it.`;

  // Build turn history for the API  
  const turns = [
    ...history.filter(t => t.role === 'user' || t.role === 'assistant').slice(-18),
    { role: 'user', content: message },
  ];

  try {
    const reply = await geminiChat(systemPrompt, turns);
    const codeBlock = extractTsxBlock(reply);

    let compositionName = null;
    let autoRender = false;

    if (codeBlock) {
      // Generate a name — reuse the last mentioned composition name from history
      // or derive from user message
      let name = deriveCompName(message);

      // If this looks like an update to an existing composition, reuse its name
      if (isIterationRequest && existingComps.length > 0) {
        // Check if any existing name was mentioned in message or recent history
        for (const comp of existingComps) {
          const allText = [...history.map(h => h.content), message].join(' ').toLowerCase();
          if (allText.includes(comp.toLowerCase())) { name = comp; break; }
        }
        // Fallback: reuse the most recently modified composition
        if (!existingComps.includes(name)) {
          try {
            const comps = fs.readdirSync(UPLOADS)
              .filter(f => /\.(tsx|ts)$/.test(f))
              .map(f => ({ name: path.basename(f, path.extname(f)), mtime: fs.statSync(path.join(UPLOADS, f)).mtime }))
              .sort((a, b) => b.mtime - a.mtime);
            if (comps.length) name = comps[0].name;
          } catch(_) {}
        }
      }

      // Sanitise name
      name = name.replace(/[^a-zA-Z0-9_]/g, '').replace(/^[^a-zA-Z]/, 'V') || 'MyVideo';

      const filePath = path.join(UPLOADS, `${name}.tsx`);
      fs.writeFileSync(filePath, codeBlock.tsx, 'utf8');
      generateRootTsx();
      compositionName = name;

      // Strip the code block from the reply shown in chat (keep just the text part)
      const textReply = reply.replace(/```[^\n]*\n[\s\S]*?```/g, '').trim();
      return res.json({
        reply: textReply || `I've created the **${name}** composition. Click **Render** to generate the video, or ask me to make changes.`,
        compositionName,
        autoRender: false,
      });
    }

    // No code block — check if user just wants to render
    if (isRenderRequest && existingComps.length > 0) {
      // Find the most likely composition to render
      let targetComp = existingComps[existingComps.length - 1];
      for (const comp of existingComps) {
        const allText = [...history.map(h => h.content), message].join(' ').toLowerCase();
        if (allText.includes(comp.toLowerCase())) { targetComp = comp; break; }
      }
      return res.json({
        reply: reply.trim() || `Starting render for **${targetComp}**…`,
        compositionName: targetComp,
        autoRender: true,
      });
    }

    // Pure Q&A / conversation
    return res.json({ reply: reply.trim() });

  } catch (e) {
    console.error('[chat] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── MCP SSE Transport (legacy 2024-11-05 — required by Claude Desktop url: mode) ─
// Claude Desktop's "url" transport:
//   1. GET /sse  → server sends "event: endpoint\ndata: /messages?sessionId=X\n\n"
//                  then keeps the SSE stream alive with heartbeats.
//   2. POST /messages?sessionId=X  → JSON-RPC request from Claude.
//                                    Server responds 200 + JSON body,
//                                    then also pushes the result to the SSE stream.
// Config: { "mcpServers": { "video-forger": { "url": "http://localhost:PORT/sse" } } }

const mcpSessions = new Map(); // sessionId → { res: SSEResponse, initialized: bool }

const MCP_TOOL_DEFS = [
  {
    name: 'get_video_capabilities',
    description: 'Returns the full guide: video types Video Forger can produce, TSX composition format requirements, available Remotion APIs, duration guide, and a minimal starter template. Call this FIRST before writing any TSX code.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_compositions',
    description: 'List all uploaded TSX compositions currently available for rendering, with duration, fps, and resolution.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_composition',
    description: 'Create (or replace) a video composition by providing its name and full TSX source code. The first line must be the @remotion metadata comment. After saving, call render_video to produce the MP4.',
    inputSchema: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Composition name — alphanumeric + underscores only (e.g. "ProductDemo2024")' },
        content: { type: 'string', description: 'Complete TSX source code starting with: // @remotion durationInFrames=900 fps=30 width=1920 height=1080' },
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
    description: 'Trigger rendering of a named composition into an MP4 file. Returns a jobId. Poll get_render_status to track completion.',
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
    description: 'Get the current status (pending/running/complete/error), progress %, render duration, and the direct video stream URL once complete.',
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
];

// MCP tool handlers — direct internal access (no HTTP self-calls)
async function mcpGetCapabilities() {
  const origin = process.env.VIDEO_FORGER_ORIGIN || `http://localhost:${PORT}`;
  return JSON.stringify({
    serverInfo: { name: 'Video Forger', description: 'AI-powered programmatic video generation with Remotion + React.' },
    format: {
      requiredFirstLine: '// @remotion durationInFrames=<N> fps=30 width=1920 height=1080',
      requiredExport:    'export default function MyComponent() { ... }',
      imports:           "import React from 'react'; import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig, Sequence, Audio } from 'remotion';",
    },
    coreApis: [
      { name: 'useCurrentFrame()',                         desc: 'Current frame index (0 to durationInFrames-1)' },
      { name: 'useVideoConfig()',                          desc: '{ fps, durationInFrames, width, height }' },
      { name: 'interpolate(frame,[in0,in1],[out0,out1])',  desc: 'Linearly interpolate a value. Use extrapolateLeft/Right: "clamp".' },
      { name: 'spring({ frame, fps, config })',            desc: 'Physics spring 0→1. config: { stiffness, damping, mass }' },
      { name: '<AbsoluteFill>',                            desc: 'Full-size positioned container (position:absolute, inset:0)' },
      { name: '<Sequence from={n} durationInFrames={n}>', desc: 'Time-windowed child content; useCurrentFrame() is offset inside.' },
      { name: '<Audio src="url" volume={0.5} />',          desc: `Audio track. Use absolute URL. Pre-generated narration: ${origin}/api/audio/mcpforger-narration` },
    ],
    durationGuide: { '15s': '450 frames', '30s': '900 frames', '60s': '1800 frames', '90s': '2700 frames (max recommended)' },
    minimalTemplate: [
      '// @remotion durationInFrames=300 fps=30 width=1920 height=1080',
      "import React from 'react';",
      "import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';",
      '',
      'export default function MyVideo() {',
      '  const frame = useCurrentFrame();',
      '  const { fps } = useVideoConfig();',
      "  const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: 'clamp' });",
      '  const scale   = spring({ frame, fps, config: { stiffness: 80 } });',
      '  return (',
      "    <AbsoluteFill style={{ background: '#0f0f0f', justifyContent: 'center', alignItems: 'center' }}>",
      "      <div style={{ opacity, transform: `scale(${scale})`, color: '#fff', fontSize: 64, fontFamily: 'sans-serif' }}>",
      '        Hello, Remotion!',
      '      </div>',
      '    </AbsoluteFill>',
      '  );',
      '}',
    ].join('\n'),
    workflow: [
      '1. Call get_video_capabilities (done — you are reading it)',
      '2. Write TSX following the required format',
      '3. Call create_composition with name + TSX code',
      '4. Call render_video with the composition name',
      '5. Poll get_render_status until status === "complete"',
      '6. Share the Video URL with the user',
    ],
  }, null, 2);
}

async function mcpListCompositions() {
  const list = fs.readdirSync(UPLOADS).filter(f => /\.(tsx|ts)$/.test(f));
  if (!list.length) return 'No compositions uploaded yet.';
  return list.map(f => {
    const n = path.basename(f, path.extname(f));
    const m = readMeta(path.join(UPLOADS, f));
    return `• ${n}  (${m.durationInFrames}f @ ${m.fps}fps = ${(m.durationInFrames / m.fps).toFixed(1)}s, ${m.width}×${m.height})`;
  }).join('\n');
}

async function mcpCreateComposition({ name, content }) {
  if (!name || typeof name !== 'string')    throw new Error('"name" is required');
  if (!content || typeof content !== 'string') throw new Error('"content" is required');
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fp = safeCompositionPath(safeName);
  fs.writeFileSync(fp, content, 'utf8');
  generateRootTsx();
  return `✅ Composition "${safeName}" saved.\nMeta: ${JSON.stringify(readMeta(fp))}`;
}

async function mcpRenderVideo({ name }) {
  if (!name) throw new Error('"name" is required');
  if (!fs.existsSync(path.join(UPLOADS, `${name}.tsx`)))
    throw new Error(`Composition "${name}" not found`);
  const jobId   = crypto.randomUUID();
  const ts      = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(VIDEOS, `${name}-${ts}.mp4`);
  jobs.set(jobId, {
    id: jobId, compositionName: name,
    status: 'pending', progress: 0,
    logs: [], outputFilename: null,
    startTime: Date.now(), endTime: null, error: null,
  });
  setImmediate(() => runRender(jobId, name, outFile));
  return `🎬 Render started!\nJob ID: ${jobId}\nCall get_render_status with jobId="${jobId}" to track progress.\nTypical render time for a 30s video: 2–5 minutes.`;
}

async function mcpGetRenderStatus({ jobId }) {
  if (!jobId) throw new Error('"jobId" is required');
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Job "${jobId}" not found`);
  const origin = process.env.VIDEO_FORGER_ORIGIN || `http://localhost:${PORT}`;
  const dur = job.endTime ? `${((job.endTime - job.startTime) / 1000).toFixed(1)}s` : 'in progress';
  const lines = [`Status:   ${job.status}`, `Progress: ${job.progress}%`, `Duration: ${dur}`];
  if (job.outputFilename)
    lines.push(`Video URL: ${origin}/api/videos/stream/${encodeURIComponent(job.outputFilename)}`);
  if (job.error)
    lines.push(`Error: ${job.error}`);
  if (job.status === 'complete')
    lines.push(`\nThe video is ready! Share the Video URL above with the user.`);
  return lines.join('\n');
}

async function mcpListRenderedVideos() {
  const files = fs.readdirSync(VIDEOS).filter(f => f.endsWith('.mp4'));
  if (!files.length) return 'No rendered videos yet.';
  const origin = process.env.VIDEO_FORGER_ORIGIN || `http://localhost:${PORT}`;
  return files.map(f => {
    const s = fs.statSync(path.join(VIDEOS, f));
    return `• ${f}  (${(s.size / 1024 / 1024).toFixed(1)} MB)\n  Play/Download: ${origin}/api/videos/stream/${encodeURIComponent(f)}`;
  }).join('\n\n');
}

async function mcpDeleteComposition({ name }) {
  if (!name) throw new Error('"name" is required');
  const fp = safeCompositionPath(name);
  if (!fs.existsSync(fp)) throw new Error(`Composition "${name}" not found`);
  fs.unlinkSync(fp);
  generateRootTsx();
  return `🗑️  Composition "${name}" deleted.`;
}

const MCP_TOOL_HANDLERS = {
  get_video_capabilities: mcpGetCapabilities,
  list_compositions:      mcpListCompositions,
  create_composition:     mcpCreateComposition,
  update_composition:     mcpCreateComposition,
  render_video:           mcpRenderVideo,
  get_render_status:      mcpGetRenderStatus,
  list_rendered_videos:   mcpListRenderedVideos,
  delete_composition:     mcpDeleteComposition,
};

// GET /sse — Claude Desktop connects here; we send the endpoint event then heartbeat
app.get('/sse', (req, res) => {
  const sessionId = crypto.randomUUID();
  const origin    = process.env.VIDEO_FORGER_ORIGIN || `http://localhost:${PORT}`;

  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Tell Claude Desktop where to POST messages for this session
  res.write(`event: endpoint\ndata: ${origin}/messages?sessionId=${sessionId}\n\n`);

  mcpSessions.set(sessionId, { res, initialized: false });

  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(hb); }
  }, 15000);

  req.on('close', () => {
    clearInterval(hb);
    mcpSessions.delete(sessionId);
  });
});

// POST /messages — JSON-RPC from Claude Desktop
app.post('/messages', express.json({ limit: '10mb' }), async (req, res) => {
  const sessionId = req.query.sessionId;
  const session   = mcpSessions.get(sessionId);

  const messages = Array.isArray(req.body) ? req.body : [req.body];
  const responses = [];

  for (const msg of messages) {
    const { id, method, params } = msg || {};
    if (id == null) continue; // notification — no response

    try {
      let result;
      switch (method) {
        case 'initialize':
          if (session) session.initialized = true;
          result = {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'video-forger', version: '1.0.0' },
          };
          break;
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: MCP_TOOL_DEFS };
          break;
        case 'tools/call': {
          const toolName = params?.name;
          const toolArgs = params?.arguments || {};
          const handler  = MCP_TOOL_HANDLERS[toolName];
          if (!handler) {
            responses.push({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } });
            continue;
          }
          const text = await handler(toolArgs);
          result = { content: [{ type: 'text', text: String(text) }], isError: false };
          break;
        }
        default:
          responses.push({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
          continue;
      }
      responses.push({ jsonrpc: '2.0', id, result });
    } catch (e) {
      responses.push({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } });
    }
  }

  // Send HTTP response
  if (responses.length === 0) {
    res.status(202).end();
  } else {
    const body = responses.length === 1 ? responses[0] : responses;
    res.json(body);

    // Also push each response into the SSE stream so Claude Desktop sees them
    if (session) {
      for (const r of responses) {
        try { session.res.write(`event: message\ndata: ${JSON.stringify(r)}\n\n`); } catch {}
      }
    }
  }
});


// ── API: MCP Capabilities (used by Claude MCP plugin) ───────────────────────
app.get('/api/mcp/capabilities', (_, res) => {
  res.json({
    serverInfo: {
      name: 'Video Forger',
      description: 'AI-powered programmatic video generation. ' +
        'Create animated MP4 videos by writing TypeScript/TSX compositions (powered by Remotion + React).',
    },
    format: {
      requiredFirstLine: '// @remotion durationInFrames=<N> fps=30 width=1920 height=1080',
      requiredExport: 'export default function MyComponent() { ... }',
      imports: 'import React from "react"; import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig, Sequence, Audio } from "remotion";',
    },
    coreApis: [
      { name: 'useCurrentFrame()', returns: 'number', desc: 'Current frame index (0 to durationInFrames-1)' },
      { name: 'useVideoConfig()', returns: '{ fps, durationInFrames, width, height }', desc: 'Composition metadata' },
      { name: 'interpolate(frame, [in0,in1], [out0,out1], opts)', returns: 'number', desc: 'Linearly interpolate between values. Use extrapolateLeft/Right: "clamp" to stop outside range.' },
      { name: 'spring({ frame, fps, config })', returns: 'number (0→1)', desc: 'Physics spring animation. config: { stiffness, damping, mass }' },
      { name: '<AbsoluteFill>', desc: 'Full-size absolutely positioned container (position:absolute, inset:0)' },
      { name: '<Sequence from={n} durationInFrames={n}>', desc: 'Renders children only during a time window. useCurrentFrame() inside is offset.' },
      { name: '<Audio src="url" volume={0.5} />', desc: 'Audio track. MUST use absolute URL (http://...) for runtime-fetched audio.' },
      { name: '<Video src="url" />', desc: 'Embedded video source.' },
      { name: '<Img src="url" />', desc: 'Frame-safe image (waits for load before rendering).' },
    ],
    videoTemplates: [
      {
        id: 'product_demo',
        name: 'Product / Feature Demo',
        description: 'Animated slides showcasing product features with text overlays, icons, and smooth slide transitions.',
        suggestedDuration: '30s (900 frames @ 30fps)',
        resolution: '1920×1080',
      },
      {
        id: 'explainer_narrated',
        name: 'Explainer / Narrated Video',
        description: `Visuals synchronized to a narration voice script. TTS generated via Google AI Studio. Use <Audio src="${process.env.VIDEO_FORGER_ORIGIN || 'http://localhost:' + PORT}/api/audio/mcpforger-narration" /> for the pre-generated narration or POST /api/tts/google with {text, filename} for custom audio.`,
        suggestedDuration: '30–60s',
        resolution: '1920×1080',
      },
      {
        id: 'data_viz',
        name: 'Data Visualization / Chart',
        description: 'Animate bar charts, line graphs, counters using interpolate() for smooth value transitions.',
        suggestedDuration: '15–30s',
        resolution: '1920×1080',
      },
      {
        id: 'title_card',
        name: 'Animated Title Card / Logo Reveal',
        description: 'Spring-animated text entries, fade-ins, scale effects for professional intros and outros.',
        suggestedDuration: '5–15s (150–450 frames)',
        resolution: '1920×1080',
      },
      {
        id: 'code_walkthrough',
        name: 'Code Walkthrough',
        description: 'Syntax-highlighted code blocks revealed line by line using <Sequence> components.',
        suggestedDuration: '30–90s',
        resolution: '1920×1080',
      },
      {
        id: 'social_short',
        name: 'Social Media Short (9:16)',
        description: 'Vertical format for Reels / TikTok / Shorts. Set width=1080 height=1920.',
        suggestedDuration: '15–30s',
        resolution: '1080×1920',
      },
      {
        id: 'presentation',
        name: 'Presentation Slides',
        description: 'Multi-scene video with chapter transitions, bullet points revealed with spring animations.',
        suggestedDuration: '60–120s',
        resolution: '1920×1080',
      },
      {
        id: 'countdown',
        name: 'Countdown Timer / Event Promo',
        description: 'Animated countdown with glow/particle background — great for event announcements.',
        suggestedDuration: '15–30s',
        resolution: '1920×1080',
      },
    ],
    durationGuide: {
      '15s': '450 frames',
      '30s': '900 frames',
      '60s': '1800 frames',
      '90s': '2700 frames (max recommended)',
    },
    minimalTemplate: [
      '// @remotion durationInFrames=300 fps=30 width=1920 height=1080',
      "import React from 'react';",
      "import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';",
      '',
      'export default function MyVideo() {',
      '  const frame = useCurrentFrame();',
      '  const { fps } = useVideoConfig();',
      '',
      '  const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: \'clamp\' });',
      '  const scale   = spring({ frame, fps, config: { stiffness: 80 } });',
      '',
      '  return (',
      '    <AbsoluteFill style={{ background: \'#0f0f0f\', justifyContent: \'center\', alignItems: \'center\' }}>',
      '      <div style={{ opacity, transform: `scale(${scale})`, color: \'#fff\', fontSize: 64, fontFamily: \'sans-serif\' }}>',
      '        Hello, Remotion!',
      '      </div>',
      '    </AbsoluteFill>',
      '  );',
      '}',
    ].join('\n'),
    workflow: [
      '1. Call get_video_capabilities to understand what is possible',
      '2. Write TSX code following the required format',
      '3. Call create_composition with the name + TSX code',
      '4. Call render_video with the composition name',
      '5. Poll get_render_status until status === "complete"',
      '6. Share the Video URL with the user',
    ],
  });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message });
});

// ── Startup ───────────────────────────────────────────────────────────────────
generateRootTsx();  // sync Root.tsx with whatever is already in uploaded_tsx/

app.listen(PORT, () => {
  console.log(`🎬 Video Forger → http://localhost:${PORT}`);
  console.log(`   Uploads  : ${UPLOADS}`);
  console.log(`   Videos   : ${VIDEOS}`);
});
