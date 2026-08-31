import { config } from './config.js';
import { store } from './store.js';

// ---------------------------------------------------------------------------
// Playout schedule.
//
// The old model just looped the whole library in insertion order, which meant
// a clip someone PAID for landed at the end of a 40-minute rotation. You can't
// sell "the next slot" and then air it in 40 minutes.
//
// So playout is now an explicit schedule of timed entries. Paid clips jump the
// queue and air immediately after whatever is on now; unpaid library clips
// shuffle in behind them to fill the rest of the day. The schedule is also the
// channel's real history, so "recently played" matches what actually aired.
// ---------------------------------------------------------------------------

const AHEAD_MS = 10 * 60_000; // keep ~10 min scheduled ahead
const HISTORY = 60; // entries to retain behind us

let schedule = []; // [{ clipId, startsAt, endsAt, priority }]
let fillOrder = []; // shuffled library ids not yet used this rotation

function clipById(id) {
  return store.state.clips.find((c) => c.id === id) ?? null;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Next filler clip, reshuffling once the rotation is exhausted so viewers
// don't see the same order every cycle.
function nextFiller() {
  const live = store.state.clips.filter((c) => c.duration > 0);
  if (!live.length) return null;
  fillOrder = fillOrder.filter((id) => live.some((c) => c.id === id));
  if (!fillOrder.length) fillOrder = shuffle(live.map((c) => c.id));
  const id = fillOrder.shift();
  return clipById(id);
}

function tailEnd() {
  return schedule.length ? schedule[schedule.length - 1].endsAt : Date.now();
}

function append(clip, priority = false) {
  const startsAt = Math.max(tailEnd(), Date.now());
  const entry = { clipId: clip.id, startsAt, endsAt: startsAt + clip.duration * 1000, priority };
  schedule.push(entry);
  return entry;
}

// Keep the near future filled with library clips.
export function ensureSchedule() {
  const horizon = Date.now() + AHEAD_MS;
  let guard = 0;
  while (tailEnd() < horizon && guard < 500) {
    guard += 1;
    const clip = nextFiller();
    if (!clip) break;
    append(clip);
  }
  // Drop old entries but keep enough for a rewind history
  const cutoff = Date.now() - 60 * 60_000;
  const keepFrom = Math.max(0, schedule.findIndex((e) => e.endsAt > cutoff));
  if (keepFrom > HISTORY) schedule = schedule.slice(keepFrom - HISTORY);
}

// A clip somebody paid for: air it as soon as the current clip finishes,
// pushing everything scheduled behind it later.
export function airNext(clip) {
  ensureSchedule();
  const now = Date.now();
  const idx = schedule.findIndex((e) => e.endsAt > now);
  const startsAt = idx === -1 ? now : schedule[idx].endsAt;
  const entry = { clipId: clip.id, startsAt, endsAt: startsAt + clip.duration * 1000, priority: true };
  const insertAt = idx === -1 ? schedule.length : idx + 1;
  schedule.splice(insertAt, 0, entry);

  // Shift everything after it back by this clip's length
  const shift = clip.duration * 1000;
  for (let i = insertAt + 1; i < schedule.length; i += 1) {
    schedule[i].startsAt += shift;
    schedule[i].endsAt += shift;
  }
  return entry;
}

export function nowPlaying() {
  ensureSchedule();
  const now = Date.now();
  const entry = schedule.find((e) => e.startsAt <= now && e.endsAt > now);
  if (!entry) {
    const clip = nextFiller();
    if (!clip) return null;
    const e = append(clip);
    return { clip, offset: 0, entry: e };
  }
  const clip = clipById(entry.clipId);
  if (!clip) {
    // Clip was deleted (DMCA takedown) — drop it and move on immediately
    schedule = schedule.filter((e) => e.clipId !== entry.clipId);
    return nowPlaying();
  }
  return { clip, offset: (now - entry.startsAt) / 1000, entry };
}

// What's queued next, for the "NEXT UP" line.
export function upNext(n = 3) {
  ensureSchedule();
  const now = Date.now();
  return schedule
    .filter((e) => e.startsAt > now)
    .slice(0, n)
    .map((e) => ({ clip: clipById(e.clipId), startsAt: e.startsAt, priority: e.priority }))
    .filter((x) => x.clip);
}

// What actually aired, most recent first — this is the real channel history,
// which is what a rewind strip should show (not creation order).
export function history(n = 12) {
  const now = Date.now();
  return schedule
    .filter((e) => e.endsAt <= now)
    .slice(-n)
    .reverse()
    .map((e) => ({ clip: clipById(e.clipId), startedAt: e.startsAt, priority: e.priority }))
    .filter((x) => x.clip);
}

export function scheduleDepth() {
  return { entries: schedule.length, secondsAhead: Math.max(0, (tailEnd() - Date.now()) / 1000) };
}
