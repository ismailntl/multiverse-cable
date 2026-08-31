import crypto from 'node:crypto';
import * as db from './store-adapter.js';
import { moderate } from './moderation.js';

// ---------------------------------------------------------------------------
// Live chat.
//
// Messages persist in Postgres, so a restart no longer wipes the room and
// there's a record to act on if someone reports abuse. Every message — guest
// or member — goes through the same content and copyright moderation as bids,
// and every rejection is written to the moderation audit log.
//
// Without a database the room degrades to an in-memory buffer so a local
// checkout still works.
// ---------------------------------------------------------------------------

const MAX_LEN = 240;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 5;
const GUEST_RATE_MAX = 2;
const MEM_MAX = 300;

const memory = []; // fallback when no database

export function guestName(guestId) {
  const n = parseInt(crypto.createHash('sha1').update(String(guestId)).digest('hex').slice(0, 6), 16);
  return `guest-${String(n % 10000).padStart(4, '0')}`;
}

export async function systemMessage(text) {
  if (db.chatEnabled()) {
    return db.addChat({ name: 'BROADCAST', text, system: true });
  }
  const msg = { id: crypto.randomUUID(), name: 'BROADCAST', text, createdAt: Date.now(), system: true };
  memory.push(msg);
  while (memory.length > MEM_MAX) memory.shift();
  return msg;
}

export async function since(id) {
  if (db.chatEnabled()) return db.chatSince(id, 60);
  if (!id) return memory.slice(-60);
  const idx = memory.findIndex((m) => m.id === id);
  return idx === -1 ? memory.slice(-60) : memory.slice(idx + 1);
}

const memRate = new Map();

async function rateLimited(author) {
  const limit = author.guest ? GUEST_RATE_MAX : RATE_MAX;
  if (db.chatEnabled()) {
    return (await db.chatRateCount(author.key, RATE_WINDOW_MS)) >= limit;
  }
  const now = Date.now();
  const hits = (memRate.get(author.key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= limit) {
    memRate.set(author.key, hits);
    return true;
  }
  hits.push(now);
  memRate.set(author.key, hits);
  return false;
}

export async function post(author, rawText, ip = null) {
  const text = String(rawText ?? '').trim().slice(0, MAX_LEN);
  if (!text) return { error: 'type something first' };
  if (await rateLimited(author)) return { error: 'slow down a moment — too many messages' };

  const verdict = await moderate(text);
  if (!verdict.allowed) {
    // Keep an audit trail of what the filters caught, and who sent it
    await db.logModeration({
      userId: author.guest ? null : author.key,
      surface: 'chat',
      text,
      reason: verdict.reason,
      ip,
    });
    return { error: verdict.reason };
  }

  if (db.chatEnabled()) {
    const message = await db.addChat({
      userId: author.guest ? null : author.key,
      name: author.name,
      text,
      guest: !!author.guest,
      guestKey: author.guest ? author.key : null,
      ip,
    });
    return { message };
  }

  const message = {
    id: crypto.randomUUID(), name: author.name, text,
    createdAt: Date.now(), system: false, guest: !!author.guest,
  };
  memory.push(message);
  while (memory.length > MEM_MAX) memory.shift();
  return { message };
}

export const maxLength = MAX_LEN;
