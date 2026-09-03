import { config } from './config.js';
import * as db from './store-adapter.js';

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

// Channels are separate playout lanes over the same library. Each keeps its own
// schedule, so every viewer of a channel sees the same thing at the same time --
// the point of the product -- while a viewer who only wants the shopping feed
// isn't waiting out a nature documentary.
export const CHANNELS = {
  main: { label: 'Multiverse Cable', filter: () => true },
  shopping: {
    label: 'Live Shopping',
    filter: (c) => c.genre === 'live-shopping' || c.isAd,
  },
};

const lanes = new Map(); // name -> { schedule, fillOrder }

function lane(name) {
  const key = CHANNELS[name] ? name : 'main';
  if (!lanes.has(key)) lanes.set(key, { schedule: [], fillOrder: [] });
  return lanes.get(key);
}

// Clips a given channel is allowed to air.
function poolFor(name) {
  const f = (CHANNELS[name] ?? CHANNELS.main).filter;
  return db.clips().filter((c) => c.duration > 0 && f(c));
}

function clipById(id) {
  return db.clips().find((c) => c.id === id) ?? null;
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
function nextFiller(name) {
  const L = lane(name);
  const live = poolFor(name);
  if (!live.length) return null;
  L.fillOrder = L.fillOrder.filter((id) => live.some((c) => c.id === id));
  if (!L.fillOrder.length) L.fillOrder = shuffle(live.map((c) => c.id));
  const id = L.fillOrder.shift();
  return clipById(id);
}

function tailEnd(name) {
  const { schedule } = lane(name);
  return schedule.length ? schedule[schedule.length - 1].endsAt : Date.now();
}

function append(name, clip, priority = false) {
  const L = lane(name);
  const startsAt = Math.max(tailEnd(name), Date.now());
  const entry = { clipId: clip.id, startsAt, endsAt: startsAt + clip.duration * 1000, priority };
  L.schedule.push(entry);
  return entry;
}

// Keep the near future filled with library clips.
export function ensureSchedule(name = 'main') {
  const L = lane(name);
  const horizon = Date.now() + AHEAD_MS;
  let guard = 0;
  while (tailEnd(name) < horizon && guard < 500) {
    guard += 1;
    const clip = nextFiller(name);
    if (!clip) break;
    append(name, clip);
  }
  // Drop old entries but keep enough for a rewind history
  const cutoff = Date.now() - 60 * 60_000;
  const keepFrom = Math.max(0, L.schedule.findIndex((e) => e.endsAt > cutoff));
  if (keepFrom > HISTORY) L.schedule = L.schedule.slice(keepFrom - HISTORY);
}

// A clip somebody paid for: air it as soon as the current clip finishes,
// pushing everything scheduled behind it later.
// A clip somebody paid for airs next on every channel that carries it, so a
// bidder watching the shopping feed sees their own clip rather than only the
// main channel seeing it.
export function airNext(clip) {
  let first = null;
  for (const name of Object.keys(CHANNELS)) {
    if (!CHANNELS[name].filter(clip)) continue;
    const entry = airNextOn(name, clip);
    first = first ?? entry;
  }
  return first;
}

function airNextOn(name, clip) {
  ensureSchedule(name);
  const L = lane(name);
  const now = Date.now();
  const idx = L.schedule.findIndex((e) => e.endsAt > now);
  const startsAt = idx === -1 ? now : L.schedule[idx].endsAt;
  const entry = { clipId: clip.id, startsAt, endsAt: startsAt + clip.duration * 1000, priority: true };
  const insertAt = idx === -1 ? L.schedule.length : idx + 1;
  L.schedule.splice(insertAt, 0, entry);

  // Shift everything after it back by this clip's length
  const shift = clip.duration * 1000;
  for (let i = insertAt + 1; i < L.schedule.length; i += 1) {
    L.schedule[i].startsAt += shift;
    L.schedule[i].endsAt += shift;
  }
  return entry;
}

export function nowPlaying(name = 'main') {
  ensureSchedule(name);
  const L = lane(name);
  const now = Date.now();
  const entry = L.schedule.find((e) => e.startsAt <= now && e.endsAt > now);
  if (!entry) {
    const clip = nextFiller(name);
    if (!clip) return null;
    const e = append(name, clip);
    return { clip, offset: 0, entry: e };
  }
  const clip = clipById(entry.clipId);
  if (!clip) {
    // Clip was deleted (DMCA takedown) — drop it and move on immediately
    L.schedule = L.schedule.filter((e) => e.clipId !== entry.clipId);
    return nowPlaying(name);
  }
  return { clip, offset: (now - entry.startsAt) / 1000, entry };
}

// What's queued next, for the "NEXT UP" line.
export function upNext(n = 3, name = 'main') {
  ensureSchedule(name);
  const now = Date.now();
  return lane(name).schedule
    .filter((e) => e.startsAt > now)
    .slice(0, n)
    .map((e) => ({ clip: clipById(e.clipId), startsAt: e.startsAt, priority: e.priority }))
    .filter((x) => x.clip);
}

// What actually aired, most recent first — this is the real channel history,
// which is what a rewind strip should show (not creation order).
export function history(n = 12, name = 'main') {
  const now = Date.now();
  const aired = lane(name).schedule
    .filter((e) => e.endsAt <= now)
    .slice(-n)
    .reverse()
    .map((e) => ({ clip: clipById(e.clipId), startedAt: e.startsAt, priority: e.priority }))
    .filter((x) => x.clip);
  if (aired.length) return aired;

  // The schedule lives in memory, so a restart leaves no aired entries and the
  // rewind strip would read "nothing has aired yet" on a channel that has been
  // broadcasting for days. Fall back to the newest clips so rewind is useful
  // immediately; real playout history takes over as soon as clips finish.
  return poolFor(name)
    .slice(-n)
    .reverse()
    .map((clip) => ({ clip, startedAt: clip.createdAt, priority: clip.source === 'bid' || clip.source === 'ad' }));
}

export function scheduleDepth(name = 'main') {
  return {
    entries: lane(name).schedule.length,
    secondsAhead: Math.max(0, (tailEnd(name) - Date.now()) / 1000),
  };
}
