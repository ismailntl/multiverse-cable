#!/usr/bin/env node
// Take clips off air that have no stored file.
//
// A clip whose upload failed has url = null, and on managed hosting the local
// copy does not survive the next deploy — so it becomes a black screen in the
// rotation. addClip now catches this at write time; this cleans up any that
// predate that, and is safe to re-run.
//
//   node scripts/purge-dead.js          # report only
//   node scripts/purge-dead.js --apply  # hide them
import { q, one } from '../lib/db.js';

const apply = process.argv.includes('--apply');

const dead = await q(
  "select id, title, source, amount from clips where url is null and not hidden order by created_at"
);
if (!dead.length) {
  console.log('nothing dead on air');
  process.exit(0);
}

// Paid slots and uploads are records of a transaction, so they are reported but
// never auto-hidden — a human should decide what happens to something bought.
const paid = dead.filter((c) => c.source === 'bid' || c.source === 'ad' || c.amount);
const auto = dead.filter((c) => !paid.includes(c));

console.log(`${dead.length} clip(s) on air with no stored file:`);
console.log(`  ${auto.length} generated filler — safe to hide`);
if (paid.length) console.log(`  ${paid.length} PAID — left alone, review these yourself`);

if (!apply) {
  console.log('\nre-run with --apply to hide the filler');
  process.exit(0);
}

const r = await q(
  "update clips set hidden = true, hidden_reason = 'no stored file' " +
  "where url is null and not hidden and source = 'auto' returning id"
);
console.log(`hid ${r.length} clip(s)`);
const left = await one('select count(*)::int n from clips where url is null and not hidden');
console.log(`still dead on air: ${left.n}${left.n ? ' (paid — handle manually)' : ''}`);
process.exit(0);
