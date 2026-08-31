#!/usr/bin/env node
// Bulk-seed the library with real public-domain archival footage.
// Free, instant, and gives the channel a deep loop while the GPUs warm up.
//
//   node scripts/seed-archive.js [count] [concurrency]
import { grabClip } from '../lib/freefeed.js';
import { store } from '../lib/store.js';

const count = parseInt(process.argv[2] || '60', 10);
const concurrency = parseInt(process.argv[3] || '4', 10);

let done = 0, failed = 0, started = 0;

async function worker(n) {
  while (started < count) {
    const mine = ++started;
    try {
      await grabClip();
      done += 1;
      console.log(`[seed ${done}/${count}] ok (worker ${n}, attempt ${mine})`);
    } catch (err) {
      failed += 1;
      console.warn(`[seed] skip: ${err.message}`);
    }
  }
}

const t0 = Date.now();
await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i + 1)));
const clips = store.state.clips;
const mins = clips.reduce((s, c) => s + c.duration, 0) / 60;
console.log(
  `\nseeded ${done} clips (${failed} skipped) in ${((Date.now() - t0) / 1000).toFixed(0)}s\n` +
  `library now: ${clips.length} clips = ${mins.toFixed(1)} min of programming`
);
process.exit(0);
