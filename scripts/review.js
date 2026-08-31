#!/usr/bin/env node
// Review clips held back by REVIEW_MODE before they reach air.
//
//   node scripts/review.js list              # what's waiting, with playable URLs
//   node scripts/review.js approve <id|all>  # unhide -> enters rotation
//   node scripts/review.js reject  <id|all>  # stays hidden, marked rejected
import { initStore, hiddenClips, unhideClip, hideClip } from '../lib/store-adapter.js';

const [cmd = 'list', arg] = process.argv.slice(2);
await initStore();

const pending = await hiddenClips(200);

if (cmd === 'list') {
  if (!pending.length) {
    console.log('nothing awaiting review');
    process.exit(0);
  }
  console.log(`${pending.length} clip(s) awaiting review:\n`);
  for (const c of pending) {
    console.log(`  ${c.id}`);
    console.log(`    ${c.title}  [${c.genre ?? '-'}]  ${Number(c.duration).toFixed(1)}s`);
    console.log(`    ${c.url ?? c.file}\n`);
  }
  console.log('approve all:  node scripts/review.js approve all');
  process.exit(0);
}

if (!['approve', 'reject'].includes(cmd) || !arg) {
  console.error('usage: review.js [list|approve <id|all>|reject <id|all>]');
  process.exit(1);
}

const targets = arg === 'all' ? pending : pending.filter((c) => c.id === arg);
if (!targets.length) {
  console.error(arg === 'all' ? 'nothing awaiting review' : `no hidden clip ${arg}`);
  process.exit(1);
}

for (const c of targets) {
  if (cmd === 'approve') await unhideClip(c.id);
  else await hideClip(c.id, 'rejected in review');
  console.log(`${cmd === 'approve' ? 'ON AIR ' : 'REJECTED'}  ${c.title}`);
}
console.log(`\n${targets.length} clip(s) ${cmd === 'approve' ? 'approved' : 'rejected'}`);
process.exit(0);
