import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import * as db from './store-adapter.js';
import { hardCheck } from './moderation.js';
import { trademarkedCharacterHit } from './copyright.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Free-video feed: splices short public-domain clips from the Internet Archive
// into the broadcast between AI generations. Costs nothing and fits the
// found-footage-from-another-dimension vibe.
//
// Collections used are public-domain-oriented (Prelinger ephemeral films,
// classic cartoons). We pull a random 16:9-ish mp4 derivative and clip a
// random FREE_FEED_CLIP_SEC segment with ffmpeg reading straight over HTTPS.
// Titles are run through the same minors keyword filter as bids — archival
// footage isn't generated content, but we keep kid-focused reels off the
// channel anyway.
// ---------------------------------------------------------------------------

// Prelinger only: ~10k explicitly public-domain ephemeral films (industrial
// films, ads, PSAs, home movies) — perfect found-footage texture and no famous
// characters. `classic_cartoons` was REMOVED deliberately: those prints are
// public domain by copyright, but they star Betty Boop, Popeye, Superman and
// friends, whose characters remain live trademarks. Public domain is a
// copyright status, not a trademark licence. Don't add it back.
// Public-domain / openly-licensed collections. classic_cartoons is
// deliberately excluded: those prints are out of copyright but the characters
// (Betty Boop, Popeye) are still live trademarks.
const COLLECTIONS = [
  'prelinger',
  'home_movies',
  'academic_films',
  'more_animation',
  'newsandpublicaffairs',
  'computerchronicles',
  'educationalfilms',
  'AdCouncil',
];
const ROWS = 50;
const UA = 'multiverse-cable/0.1 (public-domain broadcast bot)';

async function j(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`archive.org ${res.status} for ${url}`);
  return res.json();
}

async function search(collection, page) {
  const q = new URLSearchParams({
    q: `collection:(${collection}) AND mediatype:(movies)`,
    rows: String(ROWS),
    page: String(page),
    output: 'json',
  });
  q.append('fl[]', 'identifier');
  q.append('fl[]', 'title');
  const data = await j(`https://archive.org/advancedsearch.php?${q}`);
  return data.response ?? { docs: [], numFound: 0 };
}

// Identifiers already in the library — never splice the same reel twice.
function alreadyHave(identifier) {
  return db.clips().some((c) => c.archiveId === identifier);
}

async function randomItem() {
  const collection = COLLECTIONS[Math.floor(Math.random() * COLLECTIONS.length)];
  // Page must land inside the collection's actual result count
  const { numFound } = await search(collection, 1);
  const maxPage = Math.max(1, Math.ceil(Math.min(numFound, 5000) / ROWS));
  const page = 1 + Math.floor(Math.random() * maxPage);
  const { docs } = await search(collection, page);
  if (!docs.length) throw new Error(`no docs for ${collection} page ${page}/${maxPage}`);
  // Skip anything whose title trips the minors/content filter, and anything
  // already in the library
  const safe = docs.filter(
    (d) =>
      hardCheck(`${d.title ?? ''}`).allowed &&
      !trademarkedCharacterHit(`${d.title ?? ''} ${d.identifier ?? ''}`) &&
      !alreadyHave(d.identifier)
  );
  if (!safe.length) throw new Error('no new safe docs on this page');
  return safe[Math.floor(Math.random() * safe.length)];
}

async function pickMp4(identifier) {
  const meta = await j(`https://archive.org/metadata/${identifier}`);
  const files = (meta.files ?? []).filter(
    (f) => f.name?.toLowerCase().endsWith('.mp4') && parseFloat(f.length) > 30
  );
  if (!files.length) throw new Error(`no usable mp4 derivative for ${identifier}`);
  // Prefer the small 512kb derivative; otherwise the smallest mp4
  const file =
    files.find((f) => f.name.includes('512kb')) ??
    files.sort((a, b) => (parseInt(a.size ?? 1e12, 10) || 1e12) - (parseInt(b.size ?? 1e12, 10) || 1e12))[0];
  return {
    // Canonical /download/ URL — direct dnNNN.us.archive.org node URLs return
    // HTTP 464 to non-browser clients.
    url: `https://archive.org/download/${identifier}/${encodeURIComponent(file.name)}`,
    length: parseFloat(file.length) || 120,
  };
}

export async function grabClip() {
  const item = await randomItem();
  const { url, length } = await pickMp4(item.identifier);
  const clipSec = Math.min(config.freeFeedClipSec, Math.max(8, length - 5));
  const start = Math.max(0, Math.random() * Math.max(0, length - clipSec - 5));

  const file = `archive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
  const full = path.join(config.videoDir, file);
  await exec(
    'ffmpeg',
    [
      // archive.org rejects requests without a browser-ish UA
      '-user_agent', UA,
      '-ss', start.toFixed(1), '-t', String(clipSec), '-i', url,
      '-vf', 'scale=-2:720', '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-y', full,
    ],
    { timeout: 300_000 }
  );

  await db.addClip({
    file,
    duration: clipSec,
    mock: false,
    archiveId: item.identifier,
    title: String(item.title ?? item.identifier).slice(0, 60),
    channel: Math.floor(Math.random() * 900) + 100,
    genre: 'archive',
    prompt: null,
    source: 'archive',
    bidder: null,
    amount: null,
  });
  console.log(`[freefeed] spliced in "${item.title}" (${clipSec}s from archive.org/${item.identifier})`);
}

export function startFreeFeed() {
  if (!config.freeFeed) return;
  console.log(`[freefeed] pulling a public-domain clip every ${config.freeFeedIntervalSec}s`);
  const run = () => grabClip().catch((err) => console.warn('[freefeed] skip:', err.message));
  setTimeout(run, 15_000);
  setInterval(run, config.freeFeedIntervalSec * 1000);
}
