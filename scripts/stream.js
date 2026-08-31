#!/usr/bin/env node
// Push the channel to an RTMP endpoint (Twitch, Kick, YouTube Live).
//
// Why this exists: the site has no discovery surface. Twitch and Kick do, and a
// 24/7 stream with the site's name burned into the corner is the cheapest
// funnel available.
//
// IMPORTANT — what gets streamed, and why it isn't everything:
// rehan_shei's original interdimensional-cable stream was pulled from BOTH
// Twitch and Kick over copyright. Their automated systems fingerprint AUDIO
// aggressively, and archival footage frequently carries incidental music that
// trips it even when the film itself is public domain. Public domain is a
// copyright status; it is not a licence for the music on the soundtrack.
//
// So by default this streams ONLY generated clips (source auto/bid/ad) and
// skips the archive entirely. Override with --include-archive if you have
// reason to believe your archival set is clean, and expect strikes if it isn't.
//
//   node scripts/stream.js --url rtmp://... --key <stream key>
//   node scripts/stream.js --url ... --key ... --include-archive
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { initStore, clips } from '../lib/store-adapter.js';
import { config } from '../lib/config.js';

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : (process.argv[i + 1] ?? true);
};
const RTMP_URL = arg('url', process.env.RTMP_URL);
const RTMP_KEY = arg('key', process.env.RTMP_KEY || '');
const INCLUDE_ARCHIVE = process.argv.includes('--include-archive');
const BATCH = parseInt(arg('batch', '40'), 10);          // clips per ffmpeg cycle
const SITE =
  (process.env.PUBLIC_URL || '')
    .replace(/^https?:\/\//, '')
    .replace(/[:/].*$/, '')            // drop port and path — bare host only
  || 'multiversecable.com';

if (!RTMP_URL) {
  console.error('need --url rtmp://... (and usually --key)');
  process.exit(1);
}
const target = RTMP_KEY ? `${RTMP_URL.replace(/\/$/, '')}/${RTMP_KEY}` : RTMP_URL;

await initStore();

function pickClips() {
  const all = clips().filter((c) => c.duration > 0);
  const pool = INCLUDE_ARCHIVE ? all : all.filter((c) => c.source !== 'archive');
  if (!pool.length) return [];
  // Shuffle so the loop isn't identical every cycle
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, BATCH);
}


let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

// The concat demuxer requires every input to have identical streams, and this
// library is mixed: fal clips carry audio, Nova clips are silent, and sources
// differ in resolution. So each clip is normalised once into a cache — 720p,
// stereo AAC, silence synthesised where there is none — and the stream concats
// those. The cache is reused across cycles and across restarts.
const CACHE = path.join(config.root, 'data', 'stream-cache');
fs.mkdirSync(CACHE, { recursive: true });

// drawtext parses ':' as its argument separator and '\\' / '%' as escapes, so
// anything interpolated into the filter string has to be escaped first.
const dtEscape = (t) => t.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');

const SITE_OVERLAY =
  `drawtext=text='${dtEscape(SITE)}':fontcolor=white@0.85:fontsize=28:` +
  `box=1:boxcolor=black@0.45:boxborderw=10:x=w-tw-28:y=28`;

// Cache entries bake in the overlay, so changing the site name must not reuse
// clips burned with the old one.
const OVERLAY_TAG = createHash('sha1').update(SITE_OVERLAY).digest('hex').slice(0, 8);

function run(bin, args, timeout = 300_000) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('exit', (code) => {
      clearTimeout(t);
      code === 0 ? resolve() : reject(new Error(err.slice(-300) || `exit ${code}`));
    });
  });
}

async function hasAudio(file) {
  try {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file]);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    await new Promise((r) => p.on('exit', r));
    return out.trim().length > 0;
  } catch { return false; }
}

// Normalise one clip into the cache, returning its path.
async function normalise(clip) {
  const out = path.join(CACHE, `${clip.id}-${OVERLAY_TAG}.ts`);          // MPEG-TS concatenates cleanly
  if (fs.existsSync(out) && fs.statSync(out).size > 1024) return out;

  const src = path.join(config.videoDir, clip.file);
  if (!fs.existsSync(src)) return null;

  const audio = await hasAudio(src);
  const args = ['-hide_banner', '-loglevel', 'error', '-i', src];
  if (!audio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  args.push(
    '-map', '0:v:0', '-map', audio ? '0:a:0' : '1:a:0',
    '-vf', `scale=1280:720:force_original_aspect_ratio=decrease,` +
           `pad=1280:720:(ow-iw)/2:(oh-ih)/2,${SITE_OVERLAY},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '3000k', '-maxrate', '3000k',
    '-bufsize', '6000k', '-g', '48', '-r', '24',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-shortest', '-f', 'mpegts', '-y', out,
  );
  await run('ffmpeg', args);
  return out;
}

async function cycle() {
  const chosen = pickClips();
  const ready = [];
  for (const c of chosen) {
    try {
      const f = await normalise(c);
      if (f) ready.push(f);
    } catch (e) {
      console.warn(`[stream] skip ${c.file}: ${e.message.slice(0, 80)}`);
    }
  }
  if (!ready.length) {
    console.warn('[stream] nothing streamable — waiting');
    await new Promise((r) => setTimeout(r, 30_000));
    return;
  }

  const list = path.join(os.tmpdir(), `mc-stream-${Date.now()}.txt`);
  fs.writeFileSync(list, ready.map((f) => `file '${f}'`).join('\n'));

  console.log(`[stream] cycle: ${ready.length} clips${INCLUDE_ARCHIVE ? '' : ' (generated only)'}`);
  await new Promise((resolve) => {
    // Everything is already normalised, so this is a stream copy — cheap enough
    // to run beside the generator on the same box.
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'warning',
      '-re', '-f', 'concat', '-safe', '0', '-i', list,
      '-c', 'copy', '-f', 'flv', target,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    ff.on('exit', (code) => { console.log(`[stream] ffmpeg exited ${code}`); resolve(); });
    process.on('SIGINT', () => ff.kill('SIGTERM'));
    process.on('SIGTERM', () => ff.kill('SIGTERM'));
  });
  try { fs.unlinkSync(list); } catch {}
}

console.log(`[stream] target ${RTMP_URL} — archive ${INCLUDE_ARCHIVE ? 'INCLUDED (strike risk)' : 'excluded'}`);
while (!stopping) {
  await cycle();
  if (!stopping) await new Promise((r) => setTimeout(r, 1500));  // brief reconnect gap
}
console.log('[stream] stopped');
