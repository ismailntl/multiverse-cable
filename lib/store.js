import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const stateFile = path.join(config.dataDir, 'state.json');

const defaults = () => ({
  anchor: Date.now(), // broadcast epoch: all viewers sync playback position to this
  clips: [], // { id, file, title, channel, genre, prompt, duration, source, bidder, amount }
  bids: [], // { id, userId, name, idea, kind: 'show'|'ad', amount, status, clipId }
  users: [], // { id, email, passHash, salt, credits, createdAt, ageAttestedAt, termsVersion, ip }
  sessions: {}, // token -> { userId, createdAt }
  ledger: [], // { id, userId, delta, reason, ref, createdAt }
  dmca: [], // { id, clipId, reporter, email, claim, status, createdAt }
  stats: { generated: 0, mocked: 0, failed: 0, generatedToday: 0, today: dayKey() },
});

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

let state = load();

function load() {
  try {
    return { ...defaults(), ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
  } catch {
    return defaults();
  }
}

function save() {
  const tmp = stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile);
}

function rollDay() {
  const today = dayKey();
  if (state.stats.today !== today) {
    state.stats.today = today;
    state.stats.generatedToday = 0;
  }
}

// --- password hashing (scrypt, no external deps) ----------------------------

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expected) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const store = {
  get state() {
    return state;
  },
  save,

  // --- clips ---------------------------------------------------------------

  addClip(clip) {
    const full = { id: crypto.randomUUID(), createdAt: Date.now(), ...clip };
    state.clips.push(full);
    rollDay();
    state.stats.generated += 1;
    state.stats.generatedToday += 1;
    if (clip.mock) state.stats.mocked += 1;
    // Prune oldest auto/archive clips (never paid ones) past the cap
    while (state.clips.length > config.maxLibraryClips) {
      const idx = state.clips.findIndex((c) => c.source === 'auto' || c.source === 'archive');
      if (idx === -1) break;
      const [dead] = state.clips.splice(idx, 1);
      try {
        fs.unlinkSync(path.join(config.videoDir, dead.file));
      } catch {}
    }
    save();
    return full;
  },

  removeClip(id) {
    const idx = state.clips.findIndex((c) => c.id === id);
    if (idx === -1) return false;
    const [dead] = state.clips.splice(idx, 1);
    try {
      fs.unlinkSync(path.join(config.videoDir, dead.file));
    } catch {}
    save();
    return true;
  },

  recordFailure() {
    state.stats.failed += 1;
    save();
  },

  generationsLeftToday() {
    rollDay();
    return Math.max(0, config.dailyGenLimit - state.stats.generatedToday);
  },

  // --- users / sessions ----------------------------------------------------

  findUserByEmail(email) {
    const e = String(email).toLowerCase().trim();
    return state.users.find((u) => u.email === e) ?? null;
  },

  findUser(id) {
    return state.users.find((u) => u.id === id) ?? null;
  },

  createUser({ email, password, ip, termsVersion }) {
    const { salt, hash } = hashPassword(password);
    const user = {
      id: crypto.randomUUID(),
      email: String(email).toLowerCase().trim(),
      salt,
      passHash: hash,
      credits: config.signupBonusCredits,
      createdAt: Date.now(),
      // Age + terms attestation is recorded at signup and kept for audit
      ageAttestedAt: Date.now(),
      termsVersion,
      signupIp: ip ?? null,
    };
    state.users.push(user);
    if (config.signupBonusCredits > 0) {
      state.ledger.push({
        id: crypto.randomUUID(),
        userId: user.id,
        delta: config.signupBonusCredits,
        reason: 'signup_bonus',
        createdAt: Date.now(),
      });
    }
    save();
    return user;
  },

  checkPassword(user, password) {
    return verifyPassword(password, user.salt, user.passHash);
  },

  createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    state.sessions[token] = { userId, createdAt: Date.now() };
    save();
    return token;
  },

  userForSession(token) {
    const s = token && state.sessions[token];
    if (!s) return null;
    if (Date.now() - s.createdAt > config.sessionTtlDays * 86400_000) {
      delete state.sessions[token];
      save();
      return null;
    }
    return this.findUser(s.userId);
  },

  destroySession(token) {
    if (token && state.sessions[token]) {
      delete state.sessions[token];
      save();
    }
  },

  // --- credits -------------------------------------------------------------

  adjustCredits(userId, delta, reason, ref = null) {
    const user = this.findUser(userId);
    if (!user) return null;
    if (delta < 0 && user.credits + delta < 0) return null; // insufficient
    user.credits += delta;
    state.ledger.push({
      id: crypto.randomUUID(),
      userId,
      delta,
      reason,
      ref,
      createdAt: Date.now(),
    });
    save();
    return user.credits;
  },

  hasProcessedPayment(ref) {
    return state.ledger.some((l) => l.reason === 'purchase' && l.ref === ref);
  },

  ledgerFor(userId, limit = 20) {
    return state.ledger.filter((l) => l.userId === userId).slice(-limit).reverse();
  },

  // --- bids ----------------------------------------------------------------

  addBid({ userId, name, idea, amount, genre, kind = 'show', ad = null }) {
    const bid = {
      id: crypto.randomUUID(),
      userId,
      name: String(name).slice(0, 40),
      idea: String(idea).slice(0, 300),
      kind, // 'show' | 'ad'
      ad, // { brand, product, cta } for ad bids
      genre: genre || null,
      amount: Math.max(1, Math.floor(Number(amount) || 1)),
      status: 'pending',
      attempts: 0,
      createdAt: Date.now(),
    };
    state.bids.push(bid);
    save();
    return bid;
  },

  topPendingBid() {
    return state.bids
      .filter((b) => b.status === 'pending')
      .sort((a, b) => b.amount - a.amount || a.createdAt - b.createdAt)[0];
  },

  settleBid(id, status, clipId = null) {
    const bid = state.bids.find((b) => b.id === id);
    if (!bid) return;
    bid.status = status;
    if (clipId) bid.clipId = clipId;
    if (status === 'pending') bid.attempts += 1;
    // Refund credits when a paid slot can't air
    if ((status === 'failed' || status === 'rejected') && !bid.refunded && bid.userId) {
      bid.refunded = true;
      this.adjustCredits(bid.userId, bid.amount, `refund_${status}`, bid.id);
    }
    save();
  },

  // --- dmca ----------------------------------------------------------------

  addDmca({ clipId, reporter, email, claim, ip }) {
    const report = {
      id: crypto.randomUUID(),
      clipId,
      reporter: String(reporter).slice(0, 80),
      email: String(email).slice(0, 120),
      claim: String(claim).slice(0, 2000),
      ip: ip ?? null,
      status: 'received',
      createdAt: Date.now(),
    };
    state.dmca.push(report);
    save();
    return report;
  },

  // --- broadcast clock -----------------------------------------------------

  nowPlaying() {
    const clips = state.clips.filter((c) => c.duration > 0);
    if (!clips.length) return null;
    const total = clips.reduce((s, c) => s + c.duration, 0);
    let pos = ((Date.now() - state.anchor) / 1000) % total;
    for (const clip of clips) {
      if (pos < clip.duration) return { clip, offset: pos };
      pos -= clip.duration;
    }
    return { clip: clips[clips.length - 1], offset: 0 };
  },
};
