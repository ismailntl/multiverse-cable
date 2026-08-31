import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './lib/config.js';
import { store } from './lib/store.js';
import { startScheduler, requestBatch, batchStatus } from './lib/scheduler.js';
import { startFreeFeed } from './lib/freefeed.js';
import { activeBackend } from './lib/generate.js';
import { moderate } from './lib/moderation.js';
import { GENRES } from './lib/shows.js';
import { createCheckout, findPack, handleWebhook, stripeEnabled } from './lib/payments.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
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

const currentUser = (req) => store.userForSession(cookies(req).ic_session);
const publicUser = (u) => ({ id: u.id, email: u.email, credits: u.credits, ageAttestedAt: u.ageAttestedAt });

function publicBid(b) {
  return {
    id: b.id, name: b.name, idea: b.idea, genre: b.genre, kind: b.kind,
    brand: b.ad?.brand ?? null, amount: b.amount, status: b.status, createdAt: b.createdAt,
  };
}

function publicClip(c) {
  return {
    id: c.id, file: c.file, title: c.title, channel: c.channel, duration: c.duration, genre: c.genre,
    source: c.source, isAd: !!c.isAd, bidder: c.bidder, amount: c.amount, mock: !!c.mock, createdAt: c.createdAt,
  };
}

const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  try {
    // --- broadcast ---------------------------------------------------------

    if (req.method === 'GET' && url.pathname === '/api/now') {
      const now = store.nowPlaying();
      return json(res, 200, {
        now: now ? { clip: publicClip(now.clip), offset: Math.round(now.offset * 10) / 10 } : null,
        serverTime: Date.now(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const s = store.state;
      const user = currentUser(req);
      const pending = s.bids.filter((b) => b.status === 'pending').sort((a, b) => b.amount - a.amount);
      return json(res, 200, {
        backend: activeBackend(),
        batch: batchStatus(),
        libraryClips: s.clips.length,
        stats: s.stats,
        nextSlot: pending[0] ? publicBid(pending[0]) : null,
        pendingBids: pending.slice(0, 20).map(publicBid),
        recentClips: s.clips.slice(-12).reverse().map(publicClip),
        genIntervalSec: config.genIntervalSec,
        genres: GENRES.map((g) => ({ key: g.key, label: g.label })),
        packs: config.creditPacks,
        stripeEnabled: stripeEnabled(),
        termsVersion: config.termsVersion,
        user: user ? publicUser(user) : null,
        myBids: user ? s.bids.filter((b) => b.userId === user.id).slice(-10).reverse().map(publicBid) : [],
        ledger: user ? store.ledgerFor(user.id, 10) : [],
      });
    }

    // --- accounts ----------------------------------------------------------

    if (req.method === 'POST' && url.pathname === '/api/signup') {
      const b = JSON.parse((await readBody(req)) || '{}');
      const email = String(b.email ?? '').trim().toLowerCase();
      const password = String(b.password ?? '');
      if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'a valid email is required' });
      if (password.length < 8) return json(res, 400, { error: 'password must be at least 8 characters' });
      // Age + terms attestation is mandatory and recorded with the account
      if (b.ageConfirmed !== true || b.termsAccepted !== true) {
        return json(res, 400, { error: 'you must confirm you are 18+ and accept the content policy' });
      }
      if (store.findUserByEmail(email)) return json(res, 409, { error: 'that email already has an account' });
      const user = store.createUser({ email, password, ip: clientIp(req), termsVersion: config.termsVersion });
      const token = store.createSession(user.id);
      return json(res, 201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (req.method === 'POST' && url.pathname === '/api/login') {
      const b = JSON.parse((await readBody(req)) || '{}');
      const user = store.findUserByEmail(String(b.email ?? ''));
      if (!user || !store.checkPassword(user, String(b.password ?? ''))) {
        return json(res, 401, { error: 'wrong email or password' });
      }
      const token = store.createSession(user.id);
      return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      store.destroySession(cookies(req).ic_session);
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'ic_session=; HttpOnly; Path=/; Max-Age=0' });
    }

    // --- credits / stripe --------------------------------------------------

    if (req.method === 'POST' && url.pathname === '/api/checkout') {
      const user = currentUser(req);
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
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: 'sign in to place a bid' });

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

      if (!idea) return json(res, 400, { error: 'describe what should air' });
      if (kind === 'ad' && !ad.brand) return json(res, 400, { error: 'ads need a (fictional) brand name' });
      if (!Number.isFinite(amount) || amount < 1) return json(res, 400, { error: 'bid must be at least 1 credit' });
      if (user.credits < amount) return json(res, 402, { error: `not enough credits (you have ${user.credits})` });

      // Content + copyright gate across every field the advertiser controls
      const verdict = await moderate([idea, ad?.brand, ad?.product, ad?.cta].filter(Boolean).join(' '));
      if (!verdict.allowed) return json(res, 422, { error: verdict.reason });

      // Credits are held at bid time; refunded automatically if the slot fails
      if (store.adjustCredits(user.id, -amount, `bid_${kind}`, null) === null) {
        return json(res, 402, { error: 'not enough credits' });
      }
      const name = ad?.brand || user.email.split('@')[0];
      const bid = store.addBid({ userId: user.id, name, idea, amount, genre, kind, ad });
      return json(res, 201, { bid: publicBid(bid), credits: store.findUser(user.id).credits });
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
      const report = store.addDmca({ clipId, reporter: b.reporter ?? 'anonymous', email, claim, ip: clientIp(req) });
      // Pull the clip off air immediately; review happens out of band.
      const removed = store.removeClip(clipId);
      console.log(`[dmca] report ${report.id} for clip ${clipId} (removed: ${removed})`);
      return json(res, 201, { reportId: report.id, removedFromAir: removed });
    }

    // --- admin (loopback only) ---------------------------------------------

    if (req.method === 'POST' && url.pathname === '/api/admin/batch') {
      if (!isLoopback(req)) return json(res, 403, { error: 'forbidden' });
      const b = JSON.parse((await readBody(req)) || '{}');
      const count = Math.min(500, Math.max(1, Math.floor(Number(b.count) || 1)));
      return json(res, 202, { queued: count, remaining: requestBatch(count) });
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

server.listen(config.port, () => {
  console.log(`📺 Multiverse Cable on http://localhost:${config.port} (backend: ${activeBackend()}, stripe: ${stripeEnabled() ? 'live' : 'demo'})`);
  startScheduler();
  startFreeFeed();
});
