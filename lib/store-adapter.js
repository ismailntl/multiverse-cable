import { dbEnabled, ping } from './db.js';
import * as pg from './pgstore.js';
import { store as jsonStore, ensureLock } from './store.js';

// ---------------------------------------------------------------------------
// One async store interface over either backend.
//
// Postgres is used when DATABASE_URL is set and reachable; otherwise the JSON
// store keeps a local checkout working with no database. Every method here is
// async even on the JSON path, so call sites don't need to care which is live.
// ---------------------------------------------------------------------------

let usingPg = false;

export async function initStore() {
  if (dbEnabled && (await ping())) {
    usingPg = true;
    await pg.refreshClips();
    // The clip list backs playout; keep the cache warm without hammering PG
    setInterval(() => {
      pg.refreshClips().catch((e) => console.warn('[store] clip refresh failed:', e.message));
    }, 30_000);
    console.log(`[store] postgres (${pg.clips().length} clips cached)`);
  } else {
    usingPg = false;
    ensureLock(); // single-writer guard only matters for the JSON backend
    console.log('[store] json file (set DATABASE_URL to use postgres)');
  }
  return usingPg;
}

export const backend = () => (usingPg ? 'postgres' : 'json');

// --- clips ------------------------------------------------------------------
export const clips = () => (usingPg ? pg.clips() : jsonStore.state.clips);
export const addClip = async (c) => (usingPg ? pg.addClip(c) : jsonStore.addClip(c));
export const removeClip = async (id) => (usingPg ? pg.removeClip(id) : jsonStore.removeClip(id));

// --- users / sessions -------------------------------------------------------
export const findUserByEmail = async (e) => (usingPg ? pg.findUserByEmail(e) : jsonStore.findUserByEmail(e));
export const findUser = async (id) => (usingPg ? pg.findUser(id) : jsonStore.findUser(id));
export const createUser = async (u) => (usingPg ? pg.createUser(u) : jsonStore.createUser(u));
export const checkPassword = (u, p) => (usingPg ? pg.checkPassword(u, p) : jsonStore.checkPassword(u, p));
export const createSession = async (id) => (usingPg ? pg.createSession(id) : jsonStore.createSession(id));
export const userForSession = async (t) => (usingPg ? pg.userForSession(t) : jsonStore.userForSession(t));
export const destroySession = async (t) => (usingPg ? pg.destroySession(t) : jsonStore.destroySession(t));

// --- credits ----------------------------------------------------------------
export const adjustCredits = async (id, d, reason, ref = null) =>
  usingPg ? pg.adjustCredits(id, d, reason, ref) : jsonStore.adjustCredits(id, d, reason, ref);
export const hasProcessedPayment = async (ref) =>
  usingPg ? pg.hasProcessedPayment(ref) : jsonStore.hasProcessedPayment(ref);
export const ledgerFor = async (id, n = 10) => (usingPg ? pg.ledgerFor(id, n) : jsonStore.ledgerFor(id, n));

// --- bids -------------------------------------------------------------------
export const placeBid = async (b) => {
  if (usingPg) return pg.placeBid(b);
  // JSON path: debit then insert (no transaction available)
  if (jsonStore.adjustCredits(b.userId, -b.amount, `bid_${b.kind}`) === null) return null;
  return jsonStore.addBid(b);
};
export const pendingBids = async (n = 50) =>
  usingPg ? pg.pendingBids(n) : jsonStore.state.bids.filter((x) => x.status === 'pending')
    .sort((a, z) => z.amount - a.amount || a.createdAt - z.createdAt).slice(0, n);
export const topPendingBid = async () => (usingPg ? pg.topPendingBid() : jsonStore.topPendingBid());
export const claimBid = async (id) => {
  if (usingPg) return pg.claimBid(id);
  jsonStore.settleBid(id, 'generating');
  return jsonStore.state.bids.find((b) => b.id === id) ?? null;
};
export const settleBid = async (id, status, clipId = null) =>
  usingPg ? pg.settleBid(id, status, clipId) : jsonStore.settleBid(id, status, clipId);
export const bidsFor = async (id, n = 10) =>
  usingPg ? pg.bidsFor(id, n) : jsonStore.state.bids.filter((b) => b.userId === id).slice(-n).reverse();

// --- uploads ----------------------------------------------------------------
export const addUpload = async (u) => (usingPg ? pg.addUpload(u) : jsonStore.addUpload(u));
export const pendingUploads = async () => (usingPg ? pg.pendingUploads() : jsonStore.pendingUploads());
export const uploadsFor = async (id, n = 10) => (usingPg ? pg.uploadsFor(id, n) : jsonStore.uploadsFor(id));
export const reviewUpload = async (id, ok, note = null) =>
  usingPg ? pg.reviewUpload(id, ok, note) : jsonStore.reviewUpload(id, ok, note);

// --- chat (persistent on postgres, in-memory on json) -----------------------
export const chatEnabled = () => usingPg;
export const addChat = async (m) => (usingPg ? pg.addChat(m) : null);
export const chatSince = async (id, n = 60) => (usingPg ? pg.chatSince(id, n) : []);
export const chatRateCount = async (key, win) => (usingPg ? pg.chatRateCount(key, win) : 0);
export const hideChat = async (id) => (usingPg ? pg.hideChat(id) : null);

// --- moderation audit -------------------------------------------------------
export const logModeration = async (m) => {
  if (usingPg) return pg.logModeration(m);
  console.warn(`[moderation] ${m.surface} rejected: ${m.reason}`);
  return null;
};
export const moderationStats = async () => (usingPg ? pg.moderationStats() : { total: 0, last24h: 0 });

// --- dmca -------------------------------------------------------------------
export const addDmca = async (r) => (usingPg ? pg.addDmca(r) : jsonStore.addDmca(r));

// --- stats ------------------------------------------------------------------
export const stats = async () => (usingPg ? pg.stats() : jsonStore.state.stats);
export const generationsLeftToday = async () =>
  usingPg ? pg.generationsLeftToday() : jsonStore.generationsLeftToday();
export const recordFailure = () => {
  if (!usingPg) jsonStore.recordFailure();
};
