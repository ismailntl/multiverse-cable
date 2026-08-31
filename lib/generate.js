import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
}

async function probeDuration(file) {
  try {
    const { stdout } = await exec('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
    ]);
    const d = parseFloat(stdout.trim());
    if (Number.isFinite(d) && d > 0) return d;
  } catch {}
  return config.videoDuration;
}

// ---------------------------------------------------------------------------
// Backend: local — self-hosted GPU worker (gpu-worker/worker.py on EC2).
// Contract: POST {url}/generate {prompt, duration_sec} blocks until done and
// returns the mp4 bytes (video/mp4). The worker's address comes from
// LOCAL_WORKER_URL, or from data/worker.json which scripts/batch.js writes
// while the spot instance is up.
// ---------------------------------------------------------------------------

// ---- worker pool ----------------------------------------------------------
// data/worker.json holds either one {url, token} or {workers:[{url,token}...]}.
// LOCAL_WORKER_URL may be a comma-separated list. Generation is serial on any
// single GPU, so throughput comes from spreading clips across workers.

const busyWorkers = new Set();

export function allWorkers() {
  if (config.localWorkerUrl) {
    return config.localWorkerUrl.split(',').map((u) => ({ url: u.trim(), token: config.workerToken }));
  }
  try {
    const w = JSON.parse(fs.readFileSync(config.workerStateFile, 'utf8'));
    if (Array.isArray(w.workers) && w.workers.length) return w.workers;
    if (w.url) return [w];
  } catch {}
  return [];
}

export function currentWorker() {
  return allWorkers()[0] ?? null;
}

// Reserve an idle worker; returns null when every GPU is busy.
export function leaseWorker() {
  for (const w of allWorkers()) {
    if (!busyWorkers.has(w.url)) {
      busyWorkers.add(w.url);
      return w;
    }
  }
  return null;
}

export function releaseWorker(w) {
  if (w) busyWorkers.delete(w.url);
}

export function poolStatus() {
  const all = allWorkers();
  return { workers: all.length, busy: busyWorkers.size, free: all.length - busyWorkers.size };
}

export function activeBackend() {
  if (config.genBackend !== 'auto') return config.genBackend;
  // Prefer hosted frontier models when a key is present — better and faster
  // than anything we can self-host; the GPU is the cheap fallback.
  if (config.falKey) return 'fal';
  if (allWorkers().length) return 'local';
  if (config.minimaxKey) return 'minimax';
  return 'mock';
}

async function localGenerate(prompt, file, seconds, worker) {
  if (!worker) throw new Error('no GPU worker available (data/worker.json missing)');
  const res = await fetch(`${worker.url.replace(/\/$/, '')}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, duration_sec: seconds, token: worker.token || '' }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!res.ok || !res.body) {
    throw new Error(`GPU worker ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
}

// ---------------------------------------------------------------------------
// Backend: fal — hosted frontier models via fal.ai's queue API.
//
// Why this exists: the strongest video models (Veo, Kling, Seedance, MiniMax
// H3) are CLOSED weights. No amount of GPU rents them — self-hosting caps you
// at open weights (LTX, Wan), which are a tier below on realism and, until
// LTX-2.x, silent. fal also runs optimized inference, so a clip lands in
// seconds rather than the ~90s our single L40S takes.
//
//   submit : POST https://queue.fal.run/<model>      -> { request_id, status_url }
//   poll   : GET  <status_url>                        -> { status: IN_QUEUE|IN_PROGRESS|COMPLETED }
//   result : GET  <response_url>                      -> { video: { url } }
// ---------------------------------------------------------------------------

const FAL_POLL_MS = 3_000;
const FAL_TIMEOUT_MS = 15 * 60_000;

async function falFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Key ${config.falKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`fal ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

async function falGenerate(prompt, file, seconds) {
  const submitted = await falFetch(`https://queue.fal.run/${config.falModel}`, {
    method: 'POST',
    body: JSON.stringify({
      prompt,
      duration: seconds,
      resolution: config.falResolution,
      aspect_ratio: config.videoRatio,
      generate_audio: true,
    }),
  });

  const statusUrl = submitted.status_url;
  const responseUrl = submitted.response_url;
  if (!statusUrl) throw new Error(`fal returned no status_url: ${JSON.stringify(submitted).slice(0, 200)}`);
  console.log(`[fal] ${config.falModel} queued ${submitted.request_id}`);

  const deadline = Date.now() + FAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await falFetch(statusUrl);
    const state = String(status.status || '').toUpperCase();
    if (state === 'COMPLETED') {
      const result = await falFetch(responseUrl);
      // Different models nest the output slightly differently
      const url = result.video?.url ?? result.videos?.[0]?.url ?? result.output?.video?.url;
      if (!url) throw new Error(`fal completed with no video url: ${JSON.stringify(result).slice(0, 250)}`);
      await download(url, file);
      return;
    }
    if (state === 'FAILED' || state === 'ERROR') {
      throw new Error(`fal job failed: ${JSON.stringify(status).slice(0, 250)}`);
    }
    await new Promise((r) => setTimeout(r, FAL_POLL_MS));
  }
  throw new Error(`fal job timed out after ${FAL_TIMEOUT_MS / 60000} min`);
}

// ---------------------------------------------------------------------------
// Backend: minimax — MiniMax H3 (Hailuo 3.0) hosted API, v2 async task flow.
//   create : POST {base}/v2/video_generation           -> task id
//   poll   : GET  {base}/v2/query/video_generation/{id} -> status, content.url
// Result URLs are time-limited, so we download immediately.
// ---------------------------------------------------------------------------

const POLL_MS = 10_000;
const POLL_TIMEOUT_MS = 20 * 60_000;

async function minimaxApi(pathname, options = {}) {
  const res = await fetch(config.minimaxBase + pathname, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.minimaxKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`MiniMax ${pathname} ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

async function minimaxGenerate(prompt, file, seconds) {
  const created = await minimaxApi('/v2/video_generation', {
    method: 'POST',
    body: JSON.stringify({
      model: config.minimaxModel,
      content: [{ type: 'text', text: prompt }],
      duration: seconds,
      resolution: config.videoResolution,
      ratio: config.videoRatio,
    }),
  });
  const taskId = created.task_id ?? created.task?.id;
  if (!taskId) throw new Error(`MiniMax create returned no task id: ${JSON.stringify(created).slice(0, 300)}`);
  console.log(`[minimax] task ${taskId} queued`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const body = await minimaxApi(`/v2/query/video_generation/${taskId}`);
    const task = body.task ?? body;
    const status = (task.status || '').toLowerCase();
    if (status === 'succeeded') {
      const url = task.content?.url ?? task.video?.url;
      if (!url) throw new Error(`MiniMax task ${taskId} succeeded but returned no URL`);
      await download(url, file);
      return;
    }
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(`MiniMax task ${taskId} ${status}: ${task.error?.message ?? 'unknown error'}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`MiniMax task ${taskId} timed out after ${POLL_TIMEOUT_MS / 60000} min`);
}

// ---------------------------------------------------------------------------
// Backend: mock — keeps the whole broadcast loop running with zero API keys
// and zero GPUs. ffmpeg renders a retro test-pattern clip with the show title.
// ---------------------------------------------------------------------------

// Visually distinct lavfi sources so a mock library doesn't look like one clip
// repeated. Real backends replace all of this.
const MOCK_SOURCES = [
  (d) => `testsrc2=size=1280x720:rate=24:duration=${d}`,
  (d) => `smptebars=size=1280x720:rate=24:duration=${d}`,
  (d) => `rgbtestsrc=size=1280x720:rate=24:duration=${d}`,
  (d) => `mandelbrot=size=1280x720:rate=24:end_pts=${d}`,
  (d) => `life=size=1280x720:rate=24:mold=10:ratio=0.1:death_color=#C83232:life_color=#00ff00`,
  (d) => `cellauto=size=1280x720:rate=24:scroll=1`,
  (d) => `gradients=size=1280x720:rate=24:duration=${d}`,
  (d) => `plasma=size=1280x720:rate=24:duration=${d}`,
];

async function mockGenerate(concept, file, seconds) {
  const d = seconds || config.videoDuration;
  const label = `${concept.title} - CH ${concept.channel}`.replace(/[\\:'"%]/g, ' ');
  const src = MOCK_SOURCES[Math.floor(Math.random() * MOCK_SOURCES.length)](d);
  const tone = 110 + Math.floor(Math.random() * 500);
  const inputs = [
    '-f', 'lavfi', '-i', src,
    '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${d}`,
    '-t', String(d),
  ];
  const outputs = [
    '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast',
    '-c:a', 'aac', '-y',
  ];
  const drawtext =
    `drawtext=text='${label}':fontcolor=white:fontsize=36:box=1:boxcolor=black@0.6:` +
    `boxborderw=12:x=(w-text_w)/2:y=h-th-60`;
  try {
    await exec('ffmpeg', [...inputs, '-vf', drawtext, ...outputs, file]);
  } catch {
    // drawtext needs fontconfig; fall back to a bare test pattern
    await exec('ffmpeg', [...inputs, ...outputs, file]);
  }
}

// ---------------------------------------------------------------------------

export async function generateClip(concept, prompt, durationSec, worker = null) {
  const file = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
  const full = path.join(config.videoDir, file);
  const backend = activeBackend();
  const seconds = durationSec || config.videoDuration;

  if (backend === 'fal') await falGenerate(prompt, full, seconds);
  else if (backend === 'minimax') await minimaxGenerate(prompt, full, seconds);
  else if (backend === 'local') await localGenerate(prompt, full, seconds, worker ?? currentWorker());
  else await mockGenerate(concept, full, seconds);

  const duration = await probeDuration(full);
  return { file, duration, mock: backend === 'mock' };
}

export { probeDuration };

// Normalize a viewer-uploaded file into the broadcast format (720p, capped
// length, AAC audio). Rejects anything ffmpeg can't decode as video.
export async function transcodeUpload(srcPath, outFile, maxSec) {
  const out = path.join(config.videoDir, outFile);
  await exec(
    'ffmpeg',
    [
      '-i', srcPath, '-t', String(maxSec),
      '-vf', 'scale=-2:720', '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac',
      '-movflags', '+faststart', '-y', out,
    ],
    { timeout: 600_000, maxBuffer: 10 * 1024 * 1024 }
  );
  const duration = await probeDuration(out);
  return { file: outFile, duration };
}
