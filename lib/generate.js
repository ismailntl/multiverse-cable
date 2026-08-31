import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
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
  // Bedrock first: the only good-quality option that bills to AWS credits
  // rather than cash. Then hosted frontier models, then the GPU.
  if (config.bedrockEnabled && config.s3Bucket) return 'bedrock';
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


async function falGenerate(prompt, file, seconds) {
  if (seconds <= FAL_MAX_SEGMENT_S) return falGenerateOne(prompt, file, seconds);
  return falGenerateLong(prompt, file, seconds);
}

// ---------------------------------------------------------------------------
// Backend: bedrock — Amazon Nova Reel via Bedrock async invoke.
//
// This is the one good-quality option that bills to AWS credits rather than
// cash: $0.08 per second of output, so a 6s clip is ~$0.48. Self-hosting on the
// L40S could not run a model worth airing (the 19B checkpoints don't fit 48GB
// and the 13B output was unusable), and the account has no P-instance quota.
//
// Nova Reel is async: start-async-invoke writes an mp4 into S3, then we poll
// and pull it down. It generates video only — no audio track.
// ---------------------------------------------------------------------------

const BEDROCK_POLL_MS = 15_000;
const BEDROCK_TIMEOUT_MS = 20 * 60_000;

function awsArgs(extra) {
  const base = ['--region', config.bedrockRegion];
  if (config.bedrockProfile) base.push('--profile', config.bedrockProfile);
  return [...base, ...extra];
}

// Nova Reel rejects anything over 512 characters, and our prompts carry a long
// safety suffix. Keep the visual description and swap the suffix for a terse
// equivalent, trimming the description rather than the safety clause.
const NOVA_SAFETY = ' All adults, no children. No real people or brands.';

function novaPrompt(prompt) {
  const LIMIT = 512;
  // Drop the long SAFETY/ORIGINALITY suffixes; they start at the first of these
  const cut = prompt.search(/\s*(IMPORTANT:|Original characters only)/);
  let body = (cut === -1 ? prompt : prompt.slice(0, cut)).trim();
  const room = LIMIT - NOVA_SAFETY.length;
  if (body.length > room) {
    body = body.slice(0, room);
    // don't end mid-word
    body = body.slice(0, Math.max(body.lastIndexOf(' '), 40)).trim();
  }
  return (body + NOVA_SAFETY).slice(0, LIMIT);
}

// Nova Reel async invoke allows only a small number of jobs in flight, so a
// paid bid firing while filler was still rendering was rejected outright — and
// because exec() only surfaces "Command failed", the scheduler logged nothing
// useful. Serialise invocations, surface stderr, and retry throttling.
let bedrockChain = Promise.resolve();

function bedrockSerial(fn) {
  const run = bedrockChain.then(fn, fn);
  bedrockChain = run.then(() => {}, () => {});
  return run;
}

async function startInvoke(reqFile, prefix) {
  const args = awsArgs([
    'bedrock-runtime', 'start-async-invoke',
    '--model-id', config.bedrockModel,
    '--model-input', `file://${reqFile}`,
    '--output-data-config', JSON.stringify({ s3OutputDataConfig: { s3Uri: `s3://${config.s3Bucket}/${prefix}/` } }),
    '--query', 'invocationArn', '--output', 'text',
  ]);
  const MAX = 6;
  for (let attempt = 1; attempt <= MAX; attempt += 1) {
    try {
      const { stdout } = await bedrockSerial(() => exec('aws', args, { timeout: 120_000 }));
      return stdout.trim();
    } catch (err) {
      const detail = `${err.stderr ?? ''}${err.stdout ?? ''}`.trim() || err.message;
      const busy = /ServiceQuotaExceeded|ThrottlingException|TooManyRequests|ConcurrentInvocation|LimitExceeded/i.test(detail);
      if (!busy || attempt === MAX) {
        throw new Error(`bedrock start-async-invoke failed: ${detail.slice(0, 400)}`);
      }
      const wait = Math.min(60_000, 5_000 * 2 ** (attempt - 1));
      console.warn(`[bedrock] busy (attempt ${attempt}/${MAX}), retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error('bedrock start-async-invoke: exhausted retries');
}

async function bedrockGenerate(prompt, file, seconds) {
  const reqFile = path.join(os.tmpdir(), `nova-${Date.now()}.json`);
  // Nova Reel takes a fixed 6s shot; longer runs are multi-shot and priced the
  // same per second, so clamp to what the model actually accepts.
  // Nova Reel only renders in 6-second shots, so a 10s request becomes 12s.
  // fal honours arbitrary durations, which is why paid slots route there.
  // Valid Nova Reel lengths: exactly 6, or 12-120 in 6s steps. Rounding to 6
  // multiples alone produced 18 under TEXT_VIDEO, which the API rejects.
  const want = config.bedrockDuration || seconds;
  let dur = Math.round(want / 6) * 6;
  if (dur <= 6) dur = 6;
  else dur = Math.min(120, Math.max(12, dur));
  if (dur !== seconds) console.log(`[bedrock] ${seconds}s requested -> ${dur}s (6s shot multiples)`);
  // Nova Reel's TEXT_VIDEO task is fixed at exactly 6 seconds. Anything longer
  // must use MULTI_SHOT_AUTOMATED, which takes 12-120s in 6s increments and
  // composes the shots itself.
  const body = dur <= 6
    ? {
        taskType: 'TEXT_VIDEO',
        textToVideoParams: { text: novaPrompt(prompt) },
        videoGenerationConfig: { durationSeconds: 6, fps: 24, dimension: '1280x720' },
      }
    : {
        taskType: 'MULTI_SHOT_AUTOMATED',
        multiShotAutomatedParams: { text: novaPrompt(prompt) },
        videoGenerationConfig: { durationSeconds: dur, fps: 24, dimension: '1280x720' },
      };
  fs.writeFileSync(reqFile, JSON.stringify(body));

  const prefix = `bedrock/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let arn;
  try {
    arn = await startInvoke(reqFile, prefix);
  } finally {
    try { fs.unlinkSync(reqFile); } catch {}
  }
  if (!arn || !arn.startsWith('arn:')) throw new Error(`bedrock returned no invocation arn: ${arn}`);
  console.log(`[bedrock] ${config.bedrockModel} invoked ${arn.split('/').pop()}`);

  const deadline = Date.now() + BEDROCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, BEDROCK_POLL_MS));
    const { stdout } = await exec('aws', awsArgs([
      'bedrock-runtime', 'get-async-invoke', '--invocation-arn', arn,
      '--query', '[status,failureMessage]', '--output', 'text',
    ]), { timeout: 60_000 });
    const [status, failure] = stdout.trim().split(/\t/);
    if (status === 'Completed') {
      // The job writes output.mp4 under its own folder inside the prefix
      const { stdout: ls } = await exec('aws', awsArgs([
        's3', 'ls', `s3://${config.s3Bucket}/${prefix}/`, '--recursive',
      ]), { timeout: 60_000 });
      const key = ls.split('\n').map((l) => l.trim().split(/\s+/).pop())
        .find((k) => k && k.endsWith('.mp4'));
      if (!key) throw new Error('bedrock completed but wrote no mp4');
      await exec('aws', awsArgs(['s3', 'cp', `s3://${config.s3Bucket}/${key}`, file, '--only-show-errors']),
        { timeout: 300_000 });
      return;
    }
    if (status === 'Failed') throw new Error(`bedrock job failed: ${failure || 'unknown'}`);
  }
  throw new Error(`bedrock job timed out after ${BEDROCK_TIMEOUT_MS / 60000} min`);
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

// H3 Max caps a single render at 15s — 20s and 25s are accepted by the queue
// and then return no video at all. So anything longer is generated as several
// segments and concatenated. Segments carry a shot hint so the model keeps the
// same set and characters, and ffmpeg joins them preserving the audio track.
const FAL_MAX_SEGMENT_S = Number(process.env.FAL_MAX_SEGMENT_S ?? 15);

async function falGenerateLong(prompt, file, seconds) {
  const count = Math.ceil(seconds / FAL_MAX_SEGMENT_S);
  const each = Math.ceil(seconds / count);
  console.log(`[fal] ${seconds}s requested -> ${count} segments of ${each}s`);

  const dir = path.join(os.tmpdir(), `mc-seg-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const parts = [];
  try {
    // Render segments in parallel; the shot hint is what keeps them coherent.
    await Promise.all(
      Array.from({ length: count }, (_, i) => {
        const hint =
          count === 1 ? '' :
          i === 0 ? ` This is shot 1 of ${count}: establish the scene and characters.` :
          ` This is shot ${i + 1} of ${count}, continuing the SAME scene, same set, same characters, same lighting as before.`;
        const seg = path.join(dir, `seg-${i}.mp4`);
        parts[i] = seg;
        return falGenerateOne(prompt + hint, seg, each);
      })
    );

    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, parts.map((f) => `file '${f}'`).join('\n'));
    // Re-encode rather than -c copy: segments can differ in stream params and
    // a stream-copy concat then produces a file that stalls on seek.
    await exec('ffmpeg', [
      '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', file,
    ], { timeout: 600_000, maxBuffer: 10 * 1024 * 1024 });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function falGenerateOne(prompt, file, seconds) {
  const submitted = await falFetch(`https://queue.fal.run/${config.falModel}`, {
    method: 'POST',
    body: JSON.stringify({
      prompt,
      duration: seconds,
      resolution: config.falResolution,
      // H3 Max rewrites the prompt before generating; 'balanced' returns in
      // about a second, 'quality' spends ~30s on a richer prompt.
      prompt_expansion_mode: config.falExpansion,
      enable_safety_checker: true,
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

// Paid slots get the best backend configured; unpaid filler gets the cheap one.
// A bidder is spending real credits on a clip that airs next, so it should not
// come out of the same bucket as background programming.
export function backendFor({ paid = false } = {}) {
  if (config.genBackend !== 'auto') return config.genBackend;
  if (paid) {
    if (config.falKey) return 'fal';                                   // best quality + audio
    if (config.bedrockEnabled && config.s3Bucket) return 'bedrock';     // good, on AWS credits
    if (allWorkers().length) return 'local';
    return activeBackend();
  }
  // Filler: prefer whatever is cheapest per clip that still looks acceptable
  if (config.bedrockEnabled && config.s3Bucket) return 'bedrock';
  if (allWorkers().length) return 'local';
  if (config.falKey) return 'fal';
  return activeBackend();
}

export async function generateClip(concept, prompt, durationSec, worker = null, opts = {}) {
  const file = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
  const full = path.join(config.videoDir, file);
  const backend = backendFor(opts);
  const seconds = durationSec || config.videoDuration;

  if (backend === 'bedrock') await bedrockGenerate(prompt, full, seconds);
  else if (backend === 'fal') await falGenerate(prompt, full, seconds);
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
