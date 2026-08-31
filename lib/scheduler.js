import { config } from './config.js';
import * as db from './store-adapter.js';
import { generateClip, activeBackend, leaseWorker, releaseWorker, poolStatus } from './generate.js';
import { randomConcept, conceptFromBid, writePrompt, SAFETY_SUFFIX } from './shows.js';
import { moderate } from './moderation.js';
import * as auction from './auction.js';
import * as playout from './playout.js';

let inFlight = 0;
let batchRemaining = 0;
let batchRunning = false;

// Pick the next thing to make: highest pending bid, else a random concept.
// Bids are re-moderated here even though intake already checked them — defense
// in depth if a rule changed while the bid sat in the queue.
async function nextJob() {
  // Only take a bid once its auction window has closed — otherwise a higher
  // bid landing mid-generation would have wasted the GPU time.
  let bid = await auction.takeWinner();
  while (bid) {
    const verdict = await moderate(bid.idea);
    if (verdict.allowed) break;
    console.warn(`[scheduler] bid ${bid.id} rejected at generation time: ${verdict.reason}`);
    await db.logModeration({ userId: bid.userId, surface: 'bid', text: bid.idea, reason: verdict.reason });
    await db.settleBid(bid.id, 'rejected');
    bid = await db.topPendingBid();
  }
  // Claim atomically so two parallel workers can't take the same bid
  if (bid) bid = await db.claimBid(bid.id);
  return { bid, concept: bid ? conceptFromBid(bid) : randomConcept() };
}

// Generate one clip on a leased GPU. Returns true when a clip made it to air.
async function runOne() {
  if ((await db.generationsLeftToday()) <= 0) {
    console.log('[scheduler] daily generation limit reached, coasting on the library');
    return false;
  }
  const backend = activeBackend();
  const worker = backend === 'local' ? leaseWorker() : null;
  if (backend === 'local' && !worker) return false; // every GPU busy

  inFlight += 1;
  const { bid, concept } = await nextJob();
  try {
    const prompt = (await writePrompt(concept)) + SAFETY_SUFFIX;
    console.log(
      `[scheduler] generating "${concept.title}" [${concept.genre}] via ${backend}` +
        `${worker ? ` @ ${worker.url}` : ''} (${bid ? `bid by ${bid.name} for ${bid.amount}cr` : 'auto'})`
    );
    const { file, duration, mock } = await generateClip(concept, prompt, bid?.durationSec, worker);
    const clip = await db.addClip({
      file, duration, mock,
      title: concept.title,
      channel: concept.channel,
      genre: concept.genre,
      isAd: !!concept.isAd,
      prompt,
      source: bid ? (bid.kind === 'ad' ? 'ad' : 'bid') : 'auto',
      bidder: bid?.bidderName ?? bid?.name ?? null,
      amount: bid?.amount ?? null,
    });
    if (bid && clip) {
      await db.settleBid(bid.id, 'aired', clip.id);
      // Somebody paid for this slot — air it right after the current clip
      // instead of at the end of the library rotation.
      playout.airNext(clip);
    }
    console.log(`[scheduler] on air: "${concept.title}" (${duration.toFixed(1)}s, library=${db.clips().length})`);
    return true;
  } catch (err) {
    console.error(`[scheduler] generation failed: ${err.message}`);
    db.recordFailure();
    if (bid) {
      // Give a paid slot two retries before refunding it out of the queue
      if (bid.attempts >= 2) await db.settleBid(bid.id, 'failed');
      else await db.settleBid(bid.id, 'pending');
    }
    return false;
  } finally {
    releaseWorker(worker);
    inFlight -= 1;
  }
}

// Burst mode: saturate every GPU in the pool until the batch drains.
async function runBatch() {
  if (batchRunning) return;
  batchRunning = true;
  try {
    while (batchRemaining > 0 && (await db.generationsLeftToday()) > 0) {
      const { free } = poolStatus();
      const slots = Math.max(1, Math.min(free || 1, batchRemaining));
      const jobs = [];
      for (let i = 0; i < slots && batchRemaining > 0; i += 1) {
        batchRemaining -= 1;
        jobs.push(runOne());
      }
      const results = await Promise.all(jobs);
      if (!results.some(Boolean)) await new Promise((r) => setTimeout(r, 10_000));
    }
    batchRemaining = 0;
  } finally {
    batchRunning = false;
  }
}

export function requestBatch(count) {
  batchRemaining = Math.min(2000, batchRemaining + count);
  runBatch();
  return batchRemaining;
}

// A paid bid shouldn't wait out the idle timer — start it immediately if a GPU
// is free. Otherwise it's already next in line (the queue sorts by amount).
// Called when the auction window closes: start the winner immediately.
export function kickNow() {
  const { free } = poolStatus();
  if (activeBackend() === 'local' && free <= 0) return false;
  if (inFlight > 0 && activeBackend() !== 'local') return false;
  runOne();
  return true;
}

// Watch for a closing auction so the winner starts the instant bidding ends,
// rather than waiting for the next idle tick.
setInterval(() => {
  if (auction.closed()) kickNow();
  else auction.openIfNeeded().catch(() => {});
}, 2000);

export function batchStatus() {
  return { remaining: batchRemaining, busy: inFlight > 0, inFlight, ...poolStatus() };
}

export function startScheduler() {
  console.log(
    `[scheduler] backend=${activeBackend()} pool=${JSON.stringify(poolStatus())} ` +
      `interval=${config.genIntervalSec}s dailyLimit=${config.dailyGenLimit}`
  );
  runOne();
  setInterval(() => {
    if (batchRemaining === 0) runOne();
  }, config.genIntervalSec * 1000);
}
