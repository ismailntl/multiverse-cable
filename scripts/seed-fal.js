#!/usr/bin/env node
// Seed the library with fal H3 Max clips — the only backend that returns a
// synchronized audio track. Billed in cash (~$0.30 per 15s clip), so it stops
// on a spend cap rather than a clip count you might mis-estimate.
//
//   node scripts/seed-fal.js [maxSpendUSD] [concurrency]
import { initStore, addClip } from '../lib/store-adapter.js';
import { generateClip } from '../lib/generate.js';
import { randomConcept, writePrompt, SAFETY_SUFFIX } from '../lib/shows.js';
import { config } from '../lib/config.js';

const BUDGET = parseFloat(process.argv[2] || '18');
const CONC = parseInt(process.argv[3] || '3', 10);
const KEY = config.falKey;

async function balance() {
  try {
    const r = await fetch('https://rest.fal.ai/billing/user_balance', {
      headers: { Authorization: `Key ${KEY}` },
    });
    return parseFloat(await r.text());
  } catch { return null; }
}

await initStore();
const start = await balance();
if (start === null) { console.error('could not read fal balance'); process.exit(1); }
console.log(`fal balance $${start.toFixed(2)} — spending up to $${BUDGET.toFixed(2)} at ${config.videoDuration}s/clip`);

let made = 0, failed = 0, stop = false;

async function worker(n) {
  while (!stop) {
    const now = await balance();
    if (now !== null && start - now >= BUDGET) { stop = true; break; }
    if (now !== null && now < 0.5) { stop = true; break; }   // leave a floor

    const concept = randomConcept();
    try {
      const prompt = (await writePrompt(concept)) + SAFETY_SUFFIX;
      const { file, duration } = await generateClip(concept, prompt, config.videoDuration, null, { paid: true });
      const clip = await addClip({
        file, duration, mock: false,
        title: concept.title, channel: concept.channel, genre: concept.genre,
        source: 'auto', prompt, bidder: null, amount: null,
      });
      made += 1;
      console.log(`  [${made}] ${concept.title} — ${duration.toFixed(1)}s${clip?.url ? ' (on CDN)' : ''}`);
    } catch (err) {
      failed += 1;
      console.warn(`  skip: ${err.message.slice(0, 110)}`);
      if (failed > 8) { stop = true; }
    }
  }
}

await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i)));
const end = await balance();
console.log(`\nmade ${made} clips (${failed} failed). Spent $${(start - (end ?? start)).toFixed(2)}, $${(end ?? 0).toFixed(2)} left.`);
process.exit(0);
