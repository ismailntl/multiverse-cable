import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './lib/config.js';
import * as db from './lib/store-adapter.js';
import { initStore } from './lib/store-adapter.js';
import { startScheduler, requestBatch, batchStatus, kickNow } from './lib/scheduler.js';
import * as chat from './lib/chat.js';
import * as auction from './lib/auction.js';
import * as playout from './lib/playout.js';
import { startFreeFeed } from './lib/freefeed.js';
import { activeBackend, transcodeUpload } from './lib/generate.js';
import { s3Enabled } from './lib/storage.js';
import os from 'node:os';
import crypto from 'node:crypto';
import { moderate } from './lib/moderation.js';
import { GENRES } from './lib/shows.js';
import { createCheckout, findPack, handleWebhook, stripeEnabled } from './lib/payments.js';
import { minimumBid, priceTable, quote } from './lib/pricing.js';
import { check as rateCheck, LIMITS } from './lib/ratelimit.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function json(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

// mp4 with HTTP Range support so <video> can seek to the live offset
function serveFile(res, file, rangeHeader) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return json(res, 404, { error: 'not found' });
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    const range = rangeHeader && /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    if (range) {
      const start = range[1] ? parseInt(range[1], 10) : 0;
      const end = range[2] ? parseInt(range[2], 10) : stat.size - 1;
      if (start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(file).pipe(res);
    }
  });
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((p) => p[0])
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress;

function sessionCookie(token) {
  const bits = [`ic_session=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${config.sessionTtlDays * 86400}`];
  if (config.secureCookies) bits.push('Secure');
  return bits.join('; ');
}

const currentUser = (req) => db.userForSession(cookies(req).ic_session);
const publicUser = (u) => ({ id: u.id, email: u.email, credits: u.credits, ageAttestedAt: u.ageAttestedAt });

function publicBid(b) {
  return {
    id: b.id, name: b.name, idea: b.idea, genre: b.genre, kind: b.kind,
    brand: b.ad?.brand ?? null, amount: b.amount, status: b.status, createdAt: b.createdAt,
  };
}

function publicClip(c) {
  return {
    id: c.id, file: c.file, url: c.url ?? null, title: c.title, channel: c.channel, duration: c.duration, genre: c.genre,
    source: c.source, isAd: !!c.isAd, bidder: c.bidder, amount: c.amount, mock: !!c.mock, createdAt: c.createdAt,
  };
}

// Live viewer presence. /api/now is polled by every open player, so it doubles
// as a heartbeat; entries expire after viewerTtlSec.
const viewers = new Map(); // key -> lastSeen ms

function markViewer(req) {
  const key = cookies(req).ic_session || cookies(req).ic_guest || clientIp(req);
  viewers.set(key, Date.now());
}

function viewerCount() {
  const cutoff = Date.now() - config.viewerTtlSec * 1000;
  for (const [k, t] of viewers) if (t < cutoff) viewers.delete(k);
  return viewers.size;
}

// Loopback alone is NOT proof of local origin: behind a same-host reverse
// proxy (how this deploys) every internet request arrives from 127.0.0.1. So a
// loopback caller must also have arrived without proxy headers, and machine
// callers should present ADMIN_TOKEN.
const isLoopback = (req) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
  !req.headers['x-forwarded-for'] &&
  !req.headers['forwarded'];

function tokenMatches(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Admin = signed-in account in ADMIN_EMAILS, or a caller holding ADMIN_TOKEN,
// or a genuinely local process when no token is configured.
async function isAdmin(req) {
  const token = req.headers['x-admin-token'];
  if (config.adminToken) return Boolean(token) && tokenMatches(token, config.adminToken);
  const user = await currentUser(req);
  if (user && config.adminEmails.includes(user.email)) return true;
  return isLoopback(req);
}

// Rate limit key: the account when signed in, otherwise the source address.
function limited(res, req, name, user = null) {
  const key = user?.id ?? clientIp(req);
  const r = rateCheck(name, key, LIMITS[name]);
  if (!r.allowed) {
    json(res, 429, { error: `too many requests — try again in ${r.retryAfter}s` },
      { 'Retry-After': String(r.retryAfter) });
    return true;
  }
  return false;
}

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  try {
    // --- broadcast ---------------------------------------------------------

    if (req.method === 'GET' && url.pathname === '/api/now') {
      markViewer(req);
      const now = playout.nowPlaying();
      return json(res, 200, {
        viewers: viewerCount(),
        now: now ? { clip: publicClip(now.clip), offset: Math.round(now.offset * 10) / 10 } : null,
        upNext: playout.upNext(3).map((u) => ({ clip: publicClip(u.clip), startsAt: u.startsAt, paid: u.priority })),
        serverTime: Date.now(),
      });
    }

    // DVR: the last N clips in broadcast order so a viewer can rewind
    if (req.method === 'GET' && url.pathname === '/api/recent') {
      const n = Math.min(30, Math.max(1, parseInt(url.searchParams.get('n') ?? '12', 10)));
      return json(res, 200, {
        clips: playout.history(n).map((h) => ({ ...publicClip(h.clip), airedAt: h.startedAt, paid: h.priority })),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const user = await currentUser(req);
      const pending = await db.pendingBids(20);
      return json(res, 200, {
        backend: activeBackend(),
        batch: batchStatus(),
        libraryClips: db.clips().length,
        aiClips: await db.generatedCount(),
        storage: {
          s3: s3Enabled(),
          bucket: config.s3Bucket || null,
          cdn: config.cdnBase || null,
          unstored: db.clips().filter((c) => !c.url).length,
        },
        stats: await db.stats(),
        nextSlot: pending[0] ? publicBid(pending[0]) : null,
        pendingBids: pending.slice(0, 20).map(publicBid),
        recentClips: playout.history(12).map((h) => ({ ...publicClip(h.clip), airedAt: h.startedAt, paid: h.priority })),
        genIntervalSec: config.genIntervalSec,
        genres: GENRES.map((g) => ({ key: g.key, label: g.label })),
        packs: config.creditPacks,
        stripeEnabled: stripeEnabled(),
        termsVersion: config.termsVersion,
        user: user ? publicUser(user) : null,
        myBids: user ? (await db.bidsFor(user.id, 10)).map(publicBid) : [],
        ledger: user ? await db.ledgerFor(user.id, 10) : [],
        // pricing + uploads
        auction: await auction.status(),
        viewers: viewerCount(),
        pricing: priceTable(),
        uploadCost: config.uploadCostCredits,
        maxUploadSec: config.maxUploadSec,
        maxUploadMb: config.maxUploadMb,
        myUploads: user
          ? (await db.uploadsFor(user.id)).map((u) => ({
              id: u.id, title: u.title, status: u.status, amount: u.amount, createdAt: u.createdAt,
            }))
          : [],
        pendingReview: user && config.adminEmails.includes(user.email) ? (await db.pendingUploads()).length : undefined,
      });
    }

    // --- accounts ----------------------------------------------------------

    if (req.method === 'POST' && url.pathname === '/api/signup') {
      if (limited(res, req, 'signup')) return;
      const b = JSON.parse((await readBody(req)) || '{}');
      const email = String(b.email ?? '').trim().toLowerCase();
      const password = String(b.password ?? '');
      if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'a valid email is required' });
      if (password.length < 8) return json(res, 400, { error: 'password must be at least 8 characters' });
      // Age + terms attestation is mandatory and recorded with the account
      if (b.ageConfirmed !== true || b.termsAccepted !== true) {
        return json(res, 400, { error: 'you must confirm you are 18+ and accept the content policy' });
      }
      if (await db.findUserByEmail(email)) return json(res, 409, { error: 'that email already has an account' });
      // Admin rights key off this address and email is never verified, so an
      // admin address must not be claimable through public signup.
      if (config.adminEmails.includes(email)) {
        return json(res, 403, { error: 'that address cannot be registered here' });
      }
      const user = await db.createUser({ email, password, ip: clientIp(req), termsVersion: config.termsVersion });
      const token = await db.createSession(user.id);
      return json(res, 201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (req.method === 'POST' && url.pathname === '/api/login') {
      if (limited(res, req, 'login')) return;
      const b = JSON.parse((await readBody(req)) || '{}');
      const user = await db.findUserByEmail(String(b.email ?? ''));
      if (!user || !db.checkPassword(user, String(b.password ?? ''))) {
        return json(res, 401, { error: 'wrong email or password' });
      }
      const token = await db.createSession(user.id);
      return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      await db.destroySession(cookies(req).ic_session);
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'ic_session=; HttpOnly; Path=/; Max-Age=0' });
    }

    // --- credits / stripe --------------------------------------------------

    if (req.method === 'POST' && url.pathname === '/api/checkout') {
      if (limited(res, req, 'checkout')) return;
      const user = await currentUser(req);
      if (!user) return json(res, 401, { error: 'sign in first' });
      const b = JSON.parse((await readBody(req)) || '{}');
      const pack = findPack(b.packId);
      if (!pack) return json(res, 400, { error: 'unknown credit pack' });
      const result = await createCheckout(user, pack);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/stripe/webhook') {
      const raw = await readBody(req, 1_000_000);
      try {
        const result = await handleWebhook(raw, req.headers['stripe-signature']);
        return json(res, 200, result);
      } catch (err) {
        console.error('[stripe] webhook rejected:', err.message);
        return json(res, 400, { error: 'invalid webhook' });
      }
    }

    // --- bidding (shows + ads) ---------------------------------------------

    if (req.method === 'POST' && url.pathname === '/api/bid') {
      const user = await currentUser(req);
      if (!user) return json(res, 401, { error: 'sign in to place a bid' });
      if (limited(res, req, 'bid', user)) return;

      const b = JSON.parse((await readBody(req)) || '{}');
      const idea = String(b.idea ?? '').trim();
      const kind = b.kind === 'ad' ? 'ad' : 'show';
      const genre = GENRES.some((g) => g.key === b.genre) ? b.genre : null;
      const amount = Math.floor(Number(b.amount));
      const ad = kind === 'ad'
        ? {
            brand: String(b.brand ?? '').trim().slice(0, 40),
            product: String(b.product ?? '').trim().slice(0, 80),
            cta: String(b.cta ?? '').trim().slice(0, 80),
          }
        : null;

      // Longer slots cost more to generate, so they must cost the bidder more.
      const durationSec = Math.min(
        config.maxSlotSec,
        Math.max(config.minSlotSec, Math.floor(Number(b.durationSec) || config.videoDuration))
      );
      const floor = minimumBid({ durationSec, kind });

      if (!idea) return json(res, 400, { error: 'describe what should air' });
      if (kind === 'ad' && !ad.brand) return json(res, 400, { error: 'ads need a (fictional) brand name' });
      if (!Number.isFinite(amount) || amount < 1) return json(res, 400, { error: 'bid must be at least 1 credit' });
      if (amount < floor) {
        return json(res, 400, {
          error: `a ${durationSec}s ${kind === 'ad' ? 'ad' : 'slot'} costs at least ${floor} credits — raise your bid`,
          minCredits: floor,
        });
      }
      // Content + copyright gate across every field the advertiser controls.
      // Runs before the balance check so a policy rejection reports the real
      // reason instead of masking it behind "not enough credits".
      const verdict = await moderate([idea, ad?.brand, ad?.product, ad?.cta].filter(Boolean).join(' '));
      if (!verdict.allowed) {
        await db.logModeration({ userId: user.id, surface: 'bid', text: idea, reason: verdict.reason, ip: clientIp(req) });
        return json(res, 422, { error: verdict.reason });
      }

      if (user.credits < amount) return json(res, 402, { error: `not enough credits (you have ${user.credits})` });

      // Credits are held at bid time and refunded automatically if the slot
      // fails. place_bid() debits and inserts in one transaction, so credits
      // can never be taken without a bid existing.
      const name = ad?.brand || user.email.split('@')[0];
      // Client-supplied key makes a double-clicked submit return the same bid
      const idemKey = typeof b.idemKey === 'string' ? b.idemKey.slice(0, 64) : null;
      const bid = await db.placeBid({ userId: user.id, name, idea, amount, genre, kind, ad, durationSec, idemKey });
      if (!bid) return json(res, 402, { error: 'not enough credits' });
      const a = await auction.noteBid();
      await chat.systemMessage(`${name} bid ${amount}cr — "${idea.slice(0, 80)}"`);
      return json(res, 201, {
        bid: publicBid(bid),
        credits: (await db.findUser(user.id)).credits,
        auction: await auction.status(),
        queuePosition: await db.queuePosition(bid.id),
      });
    }

    // --- live chat ---------------------------------------------------------

    if (req.method === 'GET' && url.pathname === '/api/chat') {
      return json(res, 200, {
        messages: await chat.since(url.searchParams.get('since') || ''),
        now: Date.now(),
        maxLength: chat.maxLength,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const user = await currentUser(req);
      const b = JSON.parse((await readBody(req)) || '{}');

      // Guests may chat under a stable per-browser handle, moderated
      // identically to members and rate-limited harder.
      let author;
      let setCookie = null;
      if (user) {
        author = { key: user.id, name: user.email.split('@')[0].slice(0, 20), guest: false };
      } else if (config.guestChat) {
        let gid = cookies(req).ic_guest;
        if (!gid || !/^[a-f0-9]{32}$/.test(gid)) {
          gid = crypto.randomBytes(16).toString('hex');
          setCookie = `ic_guest=${gid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}` +
            (config.secureCookies ? '; Secure' : '');
        }
        author = { key: `guest:${clientIp(req)}`, name: chat.guestName(gid), guest: true };
      } else {
        return json(res, 401, { error: 'sign in to chat' });
      }

      const result = await chat.post(author, b.text, clientIp(req));
      if (result.error) return json(res, 422, { error: result.error });
      return json(res, 201, result, setCookie ? { 'Set-Cookie': setCookie } : {});
    }

    if (req.method === 'GET' && url.pathname === '/api/quote') {
      const durationSec = Math.min(
        config.maxSlotSec,
        Math.max(config.minSlotSec, Math.floor(Number(url.searchParams.get('durationSec')) || config.videoDuration))
      );
      const kind = url.searchParams.get('kind') === 'ad' ? 'ad' : 'show';
      return json(res, 200, quote({ durationSec, kind }));
    }

    // --- paid viewer uploads (human-reviewed before airing) ----------------

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const user = await currentUser(req);
      if (!user) return json(res, 401, { error: 'sign in to upload a clip' });

      if (limited(res, req, 'upload', user)) return;
      const title = String(url.searchParams.get('title') ?? '').trim().slice(0, 60);
      if (!title) return json(res, 400, { error: 'give your clip a title' });

      const verdict = await moderate(title);
      if (!verdict.allowed) {
        await db.logModeration({ userId: user.id, surface: 'upload', text: title, reason: verdict.reason, ip: clientIp(req) });
        return json(res, 422, { error: verdict.reason });
      }

      const type = String(req.headers['content-type'] ?? '').split(';')[0].toLowerCase();
      if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(type)) {
        return json(res, 415, { error: 'upload an mp4, webm, or mov video file' });
      }
      const declared = parseInt(req.headers['content-length'] ?? '0', 10);
      const maxBytes = config.maxUploadMb * 1024 * 1024;
      if (declared > maxBytes) {
        return json(res, 413, { error: `file is too large (max ${config.maxUploadMb} MB)` });
      }
      if (user.credits < config.uploadCostCredits) {
        return json(res, 402, {
          error: `uploading costs ${config.uploadCostCredits} credits (you have ${user.credits})`,
        });
      }

      // Stream to a temp file, enforcing the cap as bytes actually arrive
      const tmp = path.join(os.tmpdir(), `mc-upload-${crypto.randomUUID()}`);
      const sink = fs.createWriteStream(tmp);
      let received = 0;
      let aborted = null;
      try {
        await new Promise((resolve, reject) => {
          req.on('data', (chunk) => {
            received += chunk.length;
            if (received > maxBytes) {
              aborted = `file is too large (max ${config.maxUploadMb} MB)`;
              req.destroy();
            }
          });
          req.on('error', reject);
          sink.on('error', reject);
          sink.on('finish', resolve);
          req.pipe(sink);
        });
      } catch (err) {
        if (!aborted) aborted = err.message;
      }
      if (aborted || received === 0) {
        fs.unlink(tmp, () => {});
        return json(res, 413, { error: aborted || 'no file received' });
      }

      let normalized;
      try {
        normalized = await transcodeUpload(tmp, `upload-${crypto.randomUUID()}.mp4`, config.maxUploadSec);
      } catch (err) {
        console.warn('[upload] transcode failed:', err.message);
        return json(res, 422, { error: "that file couldn't be read as a video" });
      } finally {
        fs.unlink(tmp, () => {});
      }

      if ((await db.adjustCredits(user.id, -config.uploadCostCredits, 'upload', null)) === null) {
        return json(res, 402, { error: 'not enough credits' });
      }

      // Uploaded video can't be machine-screened the way a prompt can, so it
      // NEVER airs automatically — a human approves it first.
      const upload = await db.addUpload({
        userId: user.id,
        email: user.email,
        file: normalized.file,
        duration: normalized.duration,
        title,
        amount: config.uploadCostCredits,
        ip: clientIp(req),
      });
      console.log(`[upload] ${upload.id} "${title}" from ${user.email} — awaiting review`);
      return json(res, 201, {
        upload: { id: upload.id, title: upload.title, status: upload.status, amount: upload.amount },
        credits: (await db.findUser(user.id)).credits,
        message: 'uploaded — a human reviews it before it airs',
      });
    }

    // Review queue: admin users (ADMIN_EMAILS) or loopback
    if (url.pathname.startsWith('/api/admin/uploads')) {
      if (!(await isAdmin(req))) return json(res, 403, { error: 'forbidden' });

      if (req.method === 'GET') {
        return json(res, 200, { pending: await db.pendingUploads() });
      }
      if (req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}');
        const decided = await db.reviewUpload(b.id, b.approve === true, b.note ?? null);
        if (!decided) return json(res, 404, { error: 'no such upload awaiting review' });
        console.log(`[upload] ${decided.id} ${decided.status}`);
        return json(res, 200, { upload: decided });
      }
    }

    // --- dmca / takedown ---------------------------------------------------

    if (req.method === 'POST' && url.pathname === '/api/dmca') {
      const b = JSON.parse((await readBody(req)) || '{}');
      const clipId = String(b.clipId ?? '').trim();
      const claim = String(b.claim ?? '').trim();
      const email = String(b.email ?? '').trim();
      if (!clipId || !claim || !EMAIL_RE.test(email)) {
        return json(res, 400, { error: 'clipId, a valid contact email, and a description of the claim are required' });
      }
      if (limited(res, req, 'dmca')) return;
      const report = await db.addDmca({ clipId, reporter: b.reporter ?? 'anonymous', email, claim, ip: clientIp(req) });
      // Pull the clip off air immediately; review happens out of band.
      // Pull the clip off air but do NOT delete it: this endpoint is
      // unauthenticated and clip ids are public, so a destructive action here
      // would let anyone erase the channel, paid slots included.
      const removed = await db.hideClip(clipId, `dmca:${report?.id ?? 'report'}`);
      console.log(`[dmca] report ${report.id} for clip ${clipId} (removed: ${removed})`);
      return json(res, 201, { reportId: report.id, removedFromAir: removed });
    }

    // --- admin (signed-in admin, ADMIN_TOKEN, or a genuinely local caller) --

    if (req.method === 'POST' && url.pathname === '/api/admin/batch') {
      if (!(await isAdmin(req))) return json(res, 403, { error: 'forbidden' });
      const b = JSON.parse((await readBody(req)) || '{}');
      const count = Math.min(500, Math.max(1, Math.floor(Number(b.count) || 1)));
      return json(res, 202, { queued: count, remaining: requestBatch(count) });
    }

    // --- feedback ----------------------------------------------------------

    if (req.method === 'POST' && url.pathname === '/api/feedback') {
      if (limited(res, req, 'dmca')) return; // reuse the low-volume limiter
      const b = JSON.parse((await readBody(req)) || '{}');
      const message = String(b.message ?? '').trim().slice(0, 2000);
      if (message.length < 3) return json(res, 400, { error: 'tell us a bit more' });

      // Same content rules as everything else people can type in public
      const verdict = await moderate(message);
      if (!verdict.allowed) return json(res, 422, { error: verdict.reason });

      const user = await currentUser(req);
      const kind = ['general', 'bug', 'idea', 'content'].includes(b.kind) ? b.kind : 'general';
      const row = await db.addFeedback({
        userId: user?.id ?? null,
        email: (b.email ? String(b.email).trim().slice(0, 200) : null) ?? user?.email ?? null,
        message, kind,
        page: String(b.page ?? '').slice(0, 300),
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
        ip: clientIp(req),
      });
      console.log(`[feedback] ${kind}: ${message.slice(0, 120)}`);
      return json(res, 201, { ok: true, id: row?.id ?? null });
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/feedback') {
      if (!(await isAdmin(req))) return json(res, 403, { error: 'forbidden' });
      return json(res, 200, { open: await db.openFeedback(50) });
    }

    // --- static ------------------------------------------------------------

    if (req.method === 'GET' && url.pathname.startsWith('/videos/')) {
      return serveFile(res, path.join(config.videoDir, path.basename(url.pathname)), req.headers.range);
    }

    if (req.method === 'GET' && url.pathname === '/policy') {
      return serveFile(res, path.join(config.root, 'docs', 'POLICY.md'));
    }

    if (req.method === 'GET') {
      const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
      return serveFile(res, path.join(config.publicDir, name), req.headers.range);
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

// A crash mid-generation leaves bids stuck in 'generating' — never aired,
// never refunded, credits still taken. Sweep them back on boot and hourly.
async function sweepStaleBids() {
  try {
    const n = await db.reclaimStaleBids(30);
    if (n) console.log(`[bids] reclaimed ${n} stale claim(s) back to the queue`);
  } catch (err) {
    console.warn('[bids] stale sweep failed:', err.message);
  }
}

// Never die silently: a host that only sees a dead socket reports 503 with
// nothing to debug.
process.on('unhandledRejection', (err) => console.error('[fatal] unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('[fatal] uncaught exception:', err));

// Listen FIRST. Managed hosts health-check the port within seconds, so the
// listener must not wait on Postgres, S3 or a GPU worker to come up.
server.listen(config.port, '0.0.0.0', async () => {
  console.log(`📺 Multiverse Cable listening on :${config.port}`);
  try {
    await initStore();
    await sweepStaleBids();
    setInterval(sweepStaleBids, 3_600_000);
  } catch (err) {
    console.error('[boot] store init failed — serving degraded:', err.message);
  }
  console.log(`   video: ${activeBackend()} | store: ${db.backend()} | stripe: ${stripeEnabled() ? 'live' : 'demo'}`);
  try {
    startScheduler();
    startFreeFeed();
  } catch (err) {
    console.error('[boot] background workers failed to start:', err.message);
  }
});
