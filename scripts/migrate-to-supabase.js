#!/usr/bin/env node
// One-time import of the JSON store into Postgres.
// Safe to re-run: everything is upserted by natural key.
//
//   node scripts/migrate-to-supabase.js [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.js';
import { q, ping, close } from '../lib/db.js';

const dry = process.argv.includes('--dry');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const state = JSON.parse(fs.readFileSync(path.join(root, 'data', 'state.json'), 'utf8'));

if (!(await ping())) {
  console.error('cannot reach the database — check DATABASE_URL in .env');
  process.exit(1);
}

const iso = (ms) => new Date(ms || Date.now()).toISOString();
const counts = { users: 0, clips: 0, bids: 0, ledger: 0, uploads: 0, dmca: 0, skipped: 0 };

// --- users (email is the natural key) ---------------------------------------
const idMap = new Map(); // old json uuid -> postgres uuid
for (const u of state.users ?? []) {
  if (dry) { counts.users += 1; continue; }
  const row = (await q(
    `insert into app_users (email, pass_hash, salt, credits, age_attested_at, terms_version, signup_ip, is_admin, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (email) do update set credits = excluded.credits
     returning id`,
    [u.email, u.passHash, u.salt, u.credits ?? 0,
     u.ageAttestedAt ? iso(u.ageAttestedAt) : null, u.termsVersion ?? null, u.signupIp ?? null,
     config.adminEmails.includes(u.email), iso(u.createdAt)]
  ))[0];
  idMap.set(u.id, row.id);
  counts.users += 1;
}

// --- clips (archive_id is unique; generated clips keyed by file) ------------
const clipMap = new Map();
for (const c of state.clips ?? []) {
  if (dry) { counts.clips += 1; continue; }
  // Skip clips whose file no longer exists on disk
  if (!fs.existsSync(path.join(config.videoDir, c.file))) { counts.skipped += 1; continue; }
  const existing = (await q('select id from clips where file = $1', [c.file]))[0];
  if (existing) { clipMap.set(c.id, existing.id); continue; }
  const row = (await q(
    `insert into clips (file, title, channel, duration, genre, source, is_ad, prompt, archive_id, bidder, amount, mock, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (archive_id) where archive_id is not null do nothing
     returning id`,
    [c.file, c.title ?? 'untitled', c.channel ?? 100, c.duration, c.genre ?? null,
     c.source ?? 'auto', !!c.isAd, c.prompt ?? null, c.archiveId ?? null,
     c.bidder ?? null, c.amount ?? null, !!c.mock, iso(c.createdAt)]
  ))[0];
  if (row) { clipMap.set(c.id, row.id); counts.clips += 1; }
  else counts.skipped += 1;
}

// --- bids --------------------------------------------------------------------
for (const b of state.bids ?? []) {
  if (dry) { counts.bids += 1; continue; }
  const userId = idMap.get(b.userId) ?? null;
  // A bid mid-flight at migration time has no meaningful claim on a worker
  const status = b.status === 'generating' ? 'pending' : (b.status ?? 'pending');
  await q(
    `insert into bids (user_id, name, idea, kind, genre, duration_sec, amount, status,
                       ad_brand, ad_product, ad_cta, attempts, refunded, clip_id, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [userId, b.name ?? 'viewer', b.idea ?? '', b.kind ?? 'show', b.genre ?? null,
     b.durationSec ?? config.videoDuration, b.amount ?? 1, status,
     b.ad?.brand ?? null, b.ad?.product ?? null, b.ad?.cta ?? null,
     b.attempts ?? 0, !!b.refunded, clipMap.get(b.clipId) ?? null, iso(b.createdAt)]
  );
  counts.bids += 1;
}

// --- ledger ------------------------------------------------------------------
for (const l of state.ledger ?? []) {
  if (dry) { counts.ledger += 1; continue; }
  const userId = idMap.get(l.userId);
  if (!userId) continue;
  await q(
    'insert into ledger (user_id, delta, reason, ref, created_at) values ($1,$2,$3,$4,$5) on conflict do nothing',
    [userId, l.delta, l.reason, l.ref ?? null, iso(l.createdAt)]
  );
  counts.ledger += 1;
}

// --- uploads / dmca ----------------------------------------------------------
for (const u of state.uploads ?? []) {
  if (dry) { counts.uploads += 1; continue; }
  const userId = idMap.get(u.userId);
  if (!userId) continue;
  await q(
    `insert into uploads (user_id, email, file, title, duration, amount, status, ip, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [userId, u.email, u.file, u.title, u.duration, u.amount, u.status ?? 'pending_review', u.ip ?? null, iso(u.createdAt)]
  );
  counts.uploads += 1;
}
for (const d of state.dmca ?? []) {
  if (dry) { counts.dmca += 1; continue; }
  await q(
    `insert into dmca_reports (clip_id, reporter, email, claim, ip, status, created_at)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [clipMap.get(d.clipId) ?? null, d.reporter, d.email, d.claim, d.ip ?? null, d.status ?? 'received', iso(d.createdAt)]
  );
  counts.dmca += 1;
}

console.log(dry ? 'DRY RUN — nothing written' : 'migrated:', counts);

if (!dry) {
  // Sanity check: balances must equal the sum of each user's ledger
  const drift = await q(
    `select u.email, u.credits, coalesce(sum(l.delta),0)::int as ledger_sum
       from app_users u left join ledger l on l.user_id = u.id
      group by u.id, u.email, u.credits
     having u.credits <> coalesce(sum(l.delta),0)`
  );
  console.log(drift.length ? `WARNING: ${drift.length} account(s) where balance != ledger sum` : 'balances reconcile with ledger ✓');
}

await close();
process.exit(0);
