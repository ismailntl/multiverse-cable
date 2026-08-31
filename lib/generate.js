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

export function currentWorker() {
  if (config.localWorkerUrl) return { url: config.localWorkerUrl, token: config.workerToken };
  try {
    const w = JSON.parse(fs.readFileSync(config.workerStateFile, 'utf8'));
    if (w.url) return w;
  } catch {}
  return null;
}

export function activeBackend() {
  if (config.genBackend !== 'auto') return config.genBackend;
  if (currentWorker()) return 'local';
  if (config.minimaxKey) return 'minimax';
  return 'mock';
}

async function localGenerate(prompt, file) {
  const worker = currentWorker();
  if (!worker) throw new Error('no GPU worker available (data/worker.json missing)');
  const res = await fetch(`${worker.url.replace(/\/$/, '')}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, duration_sec: config.videoDuration, token: worker.token || '' }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!res.ok || !res.body) {
    throw new Error(`GPU worker ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
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

async function minimaxGenerate(prompt, file) {
  const created = await minimaxApi('/v2/video_generation', {
    method: 'POST',
    body: JSON.stringify({
      model: config.minimaxModel,
      content: [{ type: 'text', text: prompt }],
      duration: config.videoDuration,
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

async function mockGenerate(concept, file) {
  const d = config.videoDuration;
  const label = `${concept.title} - CH ${concept.channel}`.replace(/[\\:'"%]/g, ' ');
  const inputs = [
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=24:duration=${d}`,
    '-f', 'lavfi', '-i', `sine=frequency=220:duration=${d}`,
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

export async function generateClip(concept, prompt) {
  const file = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
  const full = path.join(config.videoDir, file);
  const backend = activeBackend();

  if (backend === 'minimax') await minimaxGenerate(prompt, full);
  else if (backend === 'local') await localGenerate(prompt, full);
  else await mockGenerate(concept, full);

  const duration = await probeDuration(full);
  return { file, duration, mock: backend === 'mock' };
}

export { probeDuration };
