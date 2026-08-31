import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { q, one, mapUser, mapClip, mapBid, mapUpload, mapChat } from './db.js';
import { uploadClip, deleteClip, s3Enabled } from './storage.js';

// ---------------------------------------------------------------------------
// Postgres-backed store. Same surface as the JSON store, but async, and with
// every money movement pushed into the SQL functions so balances and the
// ledger can't drift apart.
//
// Clips are additionally mirrored into an in-memory cache: the playout
// scheduler reads the clip list on every /api/now (many times a second across
// viewers) and doesn't need a round trip for that.
// ---------------------------------------------------------------------------

let clipCache = [];
let cacheLoadedAt = 0;

export async function refreshClips() {
  // Hidden clips are pulled from air but kept on record for review
  clipCache = (await q('select * from clips where not hidden order by created_at')).map(mapClip);
  cacheLoadedAt = Date.now();
  return clipCache;
}

export function clips() {
  return clipCache;
}

export function cacheAge() {
  return Date.now() - cacheLoadedAt;
}

// --- password hashing (unchanged from the JSON store) -----------------------

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

export function checkPassword(user, password) {
  const { hash } = hashPassword(password, user.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.passHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- users / sessions -------------------------------------------------------

export async function findUserByEmail(email) {
  return mapUser(await one('select * from app_users where email = $1', [String(email).toLowerCase().trim()]));
}

export async function findUser(id) {
  return mapUser(await one('select * from app_users where id = $1', [id]));
}

export async function createUser({ email, password, ip, termsVersion }) {
  const { salt, hash } = hashPassword(password);
  const row = await one(
    `insert into app_users (email, pass_hash, salt, credits, age_attested_at, terms_version, signup_ip, is_admin)
     values ($1,$2,$3,$4, now(), $5, $6, $7) returning *`,
    [
      String(email).toLowerCase().trim(), hash, salt, config.signupBonusCredits,
      termsVersion, ip ?? null,
      config.adminEmails.includes(String(email).toLowerCase().trim()),
    ]
  );
  if (config.signupBonusCredits > 0) {
    await q('insert into ledger (user_id, delta, reason) values ($1,$2,$3)',
      [row.id, config.signupBonusCredits, 'signup_bonus']);
  }
  return mapUser(row);
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await q('insert into sessions (token, user_id) values ($1,$2)', [token, userId]);
  return token;
}

export async function userForSession(token) {
  if (!token) return null;
  const row = await one(
    `select u.* from sessions s join app_users u on u.id = s.user_id
      where s.token = $1 and s.created_at > now() - ($2 || ' days')::interval`,
    [token, String(config.sessionTtlDays)]
  );
  return mapUser(row);
}

export async function destroySession(token) {
  if (token) await q('delete from sessions where token = $1', [token]);
}

// --- credits ----------------------------------------------------------------

// adjust_credits() writes the balance and the ledger row in one transaction and
// the CHECK (credits >= 0) makes an overdraft impossible; a violation surfaces
// as an error, which we translate to null ("insufficient funds").
export async function adjustCredits(userId, delta, reason, ref = null) {
  try {
    const row = await one('select adjust_credits($1,$2,$3,$4) as credits', [userId, delta, reason, ref]);
    return row.credits;
  } catch (err) {
    if (/violates check constraint|credits_check/i.test(err.message)) return null;
    throw err;
  }
}

export async function hasProcessedPayment(ref) {
  return Boolean(await one("select 1 from ledger where reason = 'purchase' and ref = $1", [ref]));
}

export async function ledgerFor(userId, limit = 20) {
  return q(
    'select delta, reason, ref, created_at from ledger where user_id = $1 order by created_at desc limit $2',
    [userId, limit]
  );
}

// --- clips ------------------------------------------------------------------

export async function addClip(clip) {
  const row = await one(
    `insert into clips (file, title, channel, duration, genre, source, is_ad, prompt, archive_id, bidder, amount, mock, url)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (archive_id) where archive_id is not null do nothing
     returning *`,
    [clip.file, clip.title, clip.channel, clip.duration, clip.genre ?? null, clip.source,
     !!clip.isAd, clip.prompt ?? null, clip.archiveId ?? null, clip.bidder ?? null,
     clip.amount ?? null, !!clip.mock, clip.url ?? null]
  );
  if (!row) return null; // duplicate archive item
  let mapped = mapClip(row);

  // Push to object storage so any web host can serve it, not just this box
  if (s3Enabled() && !mapped.url) {
    try {
      const url = await uploadClip(mapped.file);
      if (url) {
        await q('update clips set url = $2 where id = $1', [mapped.id, url]);
        mapped = { ...mapped, url };
      }
    } catch (err) {
      console.warn(`[storage] upload failed for ${mapped.file}: ${err.message}`);
    }
  }
  clipCache.push(mapped);
  await pruneClips();
  return mapped;
}

// Keep the library bounded; paid clips and uploads are never auto-pruned.
async function pruneClips() {
  const over = clipCache.length - config.maxLibraryClips;
  if (over <= 0) return;
  const doomed = await q(
    // Only archival footage is disposable — it can be re-pulled for free.
    // Generated clips cost real money, and paid slots and uploads are records.
    `delete from clips where id in (
       select id from clips where source = 'archive' order by created_at limit $1
     ) returning id, file`,
    [over]
  );
  for (const d of doomed) {
    try {
      fs.unlinkSync(path.join(config.videoDir, d.file));
    } catch {}
  }
  const gone = new Set(doomed.map((d) => d.id));
  clipCache = clipCache.filter((c) => !gone.has(c.id));
}

// Non-destructive takedown: pull from air, keep the row and the file so a
// bogus report can be reversed and a real one can still be reviewed.
export async function hideClip(id, reason = null) {
  const row = await one(
    'update clips set hidden = true, hidden_reason = $2 where id = $1 returning id', [id, reason]
  );
  if (!row) return false;
  clipCache = clipCache.filter((c) => c.id !== id);
  return true;
}

export async function unhideClip(id) {
  const row = await one('update clips set hidden = false, hidden_reason = null where id = $1 returning *', [id]);
  if (!row) return false;
  await refreshClips();
  return true;
}

// Permanent delete — admin only.
export async function removeClip(id) {
  const row = await one('delete from clips where id = $1 returning file', [id]);
  if (!row) return false;
  await deleteClip(row.file);
  try {
    fs.unlinkSync(path.join(config.videoDir, row.file));
  } catch {}
  clipCache = clipCache.filter((c) => c.id !== id);
  return true;
}

// --- bids -------------------------------------------------------------------

export async function placeBid({ userId, name, idea, kind, genre, durationSec, amount, ad, idemKey }) {
  // Debit + insert in one transaction: credits can never be taken without a
  // bid. An idempotency key makes a double-clicked submit return the original
  // bid instead of charging twice.
  const row = await one(
    'select * from place_bid($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [userId, name, idea, kind, genre ?? null, durationSec, amount,
     ad?.brand ?? null, ad?.product ?? null, ad?.cta ?? null, idemKey ?? null]
  );
  return mapBid(row);
}

export async function pendingBids(limit = 50) {
  return (await q(
    "select * from bids where status = 'pending' order by amount desc, created_at asc limit $1", [limit]
  )).map(mapBid);
}

export async function topPendingBid() {
  return (await pendingBids(1))[0] ?? null;
}

// Atomically claim the winning bid so two workers can't take the same one.
export async function claimBid(id) {
  return mapBid(await one('select * from claim_bid($1)', [id]));
}

// A crash between claiming and finishing leaves a bid stuck in 'generating':
// never aired, never refunded, credits still taken. Sweep those back.
export async function reclaimStaleBids(minutes = 30) {
  const row = await one('select reclaim_stale_bids($1) as n', [minutes]);
  return row?.n ?? 0;
}

// Where a user's bid sits in the queue (1 = wins the next slot).
export async function queuePosition(bidId) {
  const row = await one(
    `select pos from (
       select id, row_number() over (order by amount desc, created_at asc) as pos
         from bids where status = 'pending'
     ) ranked where id = $1`, [bidId]
  );
  return row?.pos ?? null;
}

export async function settleBid(id, status, clipId = null) {
  if (status === 'failed' || status === 'rejected') {
    // refund_bid() is idempotent — it refunds at most once per bid
    await q('select refund_bid($1,$2)', [id, status]);
    return;
  }
  if (status === 'pending') {
    await q("update bids set status = 'pending', attempts = attempts + 1 where id = $1", [id]);
    return;
  }
  // Requeue after an infrastructure failure: the bid keeps its retries
  if (status === 'pending-noretry') {
    await q("update bids set status = 'pending' where id = $1", [id]);
    return;
  }
  await q('update bids set status = $2, clip_id = $3 where id = $1', [id, status, clipId]);
}

export async function bidsFor(userId, limit = 10) {
  return (await q('select * from bids where user_id = $1 order by created_at desc limit $2', [userId, limit]))
    .map(mapBid);
}

// --- uploads ----------------------------------------------------------------

export async function addUpload(u) {
  return mapUpload(await one(
    `insert into uploads (user_id, email, file, title, duration, amount, ip)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [u.userId, u.email, u.file, u.title, u.duration, u.amount, u.ip ?? null]
  ));
}

export async function pendingUploads() {
  return (await q("select * from uploads where status = 'pending_review' order by created_at")).map(mapUpload);
}

export async function uploadsFor(userId, limit = 10) {
  return (await q('select * from uploads where user_id = $1 order by created_at desc limit $2', [userId, limit]))
    .map(mapUpload);
}

// Approving airs the clip; rejecting refunds the uploader and deletes the file.
export async function reviewUpload(id, approve, note = null) {
  const upload = mapUpload(await one(
    "select * from uploads where id = $1 and status = 'pending_review'", [id]
  ));
  if (!upload) return null;

  if (approve) {
    const clip = await addClip({
      file: upload.file,
      duration: upload.duration,
      title: upload.title,
      channel: Math.floor(Math.random() * 900) + 100,
      genre: 'upload',
      source: 'upload',
      bidder: upload.email,
      amount: upload.amount,
      mock: false,
    });
    await q("update uploads set status='approved', reviewed_at=now(), review_note=$2, clip_id=$3 where id=$1",
      [id, note, clip?.id ?? null]);
    return { ...upload, status: 'approved', clipId: clip?.id ?? null };
  }

  await q("update uploads set status='rejected', reviewed_at=now(), review_note=$2 where id=$1", [id, note]);
  await adjustCredits(upload.userId, upload.amount, 'refund_upload_rejected', upload.id);
  try {
    fs.unlinkSync(path.join(config.videoDir, upload.file));
  } catch {}
  return { ...upload, status: 'rejected' };
}

// --- chat (persistent) ------------------------------------------------------

export async function addChat({ userId, name, text, system = false, guest = false, guestKey = null, ip = null }) {
  return mapChat(await one(
    `insert into chat_messages (user_id, name, text, system, guest, guest_key, ip)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [userId ?? null, name, text, system, guest, guestKey, ip]
  ));
}

// Messages newer than `sinceId`, oldest-first for append-only rendering.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function chatSince(sinceId, limit = 60) {
  // A stale or malformed cursor used to reach the uuid cast and 500, which made
  // the client hide the composer until a reload. Treat it as "no cursor".
  if (sinceId && !UUID_RE.test(String(sinceId))) sinceId = null;
  if (!sinceId) {
    const rows = await q(
      'select * from chat_messages where not hidden order by created_at desc limit $1', [limit]
    );
    return rows.reverse().map(mapChat);
  }
  return (await q(
    `select * from chat_messages
      where not hidden
        and created_at > coalesce((select created_at from chat_messages where id = $1), 'epoch')
      order by created_at asc limit $2`,
    [sinceId, limit]
  )).map(mapChat);
}

export async function chatRateCount(key, windowMs) {
  const row = await one(
    `select count(*)::int as n from chat_messages
      where (guest_key = $1 or user_id::text = $1) and created_at > now() - ($2 || ' milliseconds')::interval`,
    [key, String(windowMs)]
  );
  return row?.n ?? 0;
}

export async function hideChat(id) {
  await q('update chat_messages set hidden = true where id = $1', [id]);
}

// --- moderation audit -------------------------------------------------------

// Every rejection is recorded. If anyone ever asks whether the filters are
// real, this is the evidence.
export async function logModeration({ userId, surface, text, reason, ip }) {
  await q('insert into moderation_log (user_id, surface, text, reason, ip) values ($1,$2,$3,$4,$5)',
    [userId ?? null, surface, String(text).slice(0, 2000), reason, ip ?? null]);
}

export async function moderationStats() {
  return one(
    `select count(*)::int as total,
            count(*) filter (where created_at > now() - interval '24 hours')::int as last24h
       from moderation_log`
  );
}

// --- dmca -------------------------------------------------------------------

export async function addDmca({ clipId, reporter, email, claim, ip }) {
  return one(
    `insert into dmca_reports (clip_id, reporter, email, claim, ip)
     values ($1,$2,$3,$4,$5) returning *`,
    [clipId, reporter, email, claim, ip ?? null]
  );
}

// --- stats ------------------------------------------------------------------

export async function stats() {
  const row = await one(
    `select count(*)::int as generated,
            count(*) filter (where created_at::date = current_date)::int as generated_today,
            count(*) filter (where mock)::int as mocked
       from clips`
  );
  return { generated: row.generated, generatedToday: row.generated_today, mocked: row.mocked, failed: 0 };
}

export async function generationsLeftToday() {
  const row = await one(
    "select count(*)::int as n from clips where created_at::date = current_date and source in ('auto','bid','ad')"
  );
  return Math.max(0, config.dailyGenLimit - (row?.n ?? 0));
}

// --- feedback ---------------------------------------------------------------

export async function addFeedback(f) {
  return one(
    `insert into feedback (user_id, email, message, kind, page, user_agent, ip)
     values ($1,$2,$3,$4,$5,$6,$7) returning id, created_at`,
    [f.userId ?? null, f.email ?? null, f.message, f.kind ?? 'general',
     f.page ?? null, f.userAgent ?? null, f.ip ?? null]
  );
}

export async function openFeedback(limit = 50) {
  return q('select * from feedback where not handled order by created_at desc limit $1', [limit]);
}
