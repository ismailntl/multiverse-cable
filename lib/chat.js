import crypto from 'node:crypto';
import { store } from './store.js';
import { moderate } from './moderation.js';

// ---------------------------------------------------------------------------
// Live chat for viewers watching the same broadcast.
//
// In-memory ring buffer — chat is ephemeral by design, so it doesn't bloat
// state.json and doesn't survive a restart. Messages run through the same
// content/copyright moderation as bids, plus a per-user rate limit.
// ---------------------------------------------------------------------------

const MAX_MESSAGES = 300;
const MAX_LEN = 240;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 5;
const GUEST_RATE_MAX = 2;

const messages = [];
const recent = new Map(); // userId -> timestamps[]

export function systemMessage(text) {
  const msg = { id: crypto.randomUUID(), name: 'BROADCAST', text, createdAt: Date.now(), system: true };
  messages.push(msg);
  while (messages.length > MAX_MESSAGES) messages.shift();
  return msg;
}

export function since(id) {
  if (!id) return messages.slice(-60);
  const idx = messages.findIndex((m) => m.id === id);
  return idx === -1 ? messages.slice(-60) : messages.slice(idx + 1);
}

function rateLimited(key) {
  const now = Date.now();
  const limit = String(key).startsWith('guest:') ? GUEST_RATE_MAX : RATE_MAX;
  const hits = (recent.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= limit) {
    recent.set(key, hits);
    return true;
  }
  hits.push(now);
  recent.set(key, hits);
  return false;
}

// Guests chat under a stable per-browser handle. They're rate-limited by IP
// (tighter than members) and moderated identically — no exceptions on the
// content rules for anonymous users.
export function guestName(guestId) {
  const n = parseInt(crypto.createHash('sha1').update(String(guestId)).digest('hex').slice(0, 6), 16);
  return `guest-${String(n % 10000).padStart(4, '0')}`;
}

export async function post(author, rawText) {
  const text = String(rawText ?? '').trim().slice(0, MAX_LEN);
  if (!text) return { error: 'type something first' };
  if (rateLimited(author.key)) return { error: 'slow down a moment — too many messages' };

  const verdict = await moderate(text);
  if (!verdict.allowed) return { error: verdict.reason };

  const msg = {
    id: crypto.randomUUID(),
    name: author.name,
    text,
    createdAt: Date.now(),
    system: false,
    guest: !!author.guest,
  };
  messages.push(msg);
  while (messages.length > MAX_MESSAGES) messages.shift();
  return { message: msg };
}

export const maxLength = MAX_LEN;
