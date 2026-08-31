import { config } from './config.js';
import * as db from './store-adapter.js';
import { generateClip, activeBackend, backendFor, leaseWorker, releaseWorker, poolStatus } from './generate.js';
import { randomConcept, conceptFromBid, writePrompt, SAFETY_SUFFIX } from './shows.js';
import { moderate } from './moderation.js';
import * as auction from './auction.js';
import * as playout from './playout.js';

let inFlight = 0;
// Paid slots run in their own lane. Background seeding can saturate a hosted
// backend's concurrency for minutes, and a bidder who paid must not queue
// behind it — that read as "the bid did nothing" and led to repeat bids.
let paidInFlight = 0;
// Set when the generation backend looks unreachable, so we stop reopening
// auctions and failing them in a loop while it's down.
let backendDownUntil = 0;
let batchRemaining = 0;
let batchRunning = false;

// Pick the next thing to make: highest pending bid, else a random concept.
// Bids are re-moderated here even though intake already checked them — defense
// in depth if a rule changed while the bid sat in the queue.
async function nextJob(prefetched = null) {
  // Only take a bid once its auction window has closed — otherwise a higher
  // bid landing mid-generation would have wasted the GPU time.
  let bid = prefetched ?? (await auction.takeWinner());
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
  if (Date.now() < backendDownUntil) return 'skipped';
  if ((await db.generationsLeftToday()) <= 0) {
    console.log('[scheduler] daily generation limit reached, coasting on the library');
    return false;
  }
  // Decide what we're making before reserving capacity, so a paid slot can use
  // the reserved lane instead of competing with batch work.
  const peek = await auction.takeWinner();
  const isPaid = !!peek;
  if (isPaid && paidInFlight >= config.paidConcurrency) return 'skipped';

  const backend = isPaid ? backendFor({ paid: true }) : activeBackend();
  const worker = backend === 'local' ? leaseWorker() : null;
  if (backend === 'local' && !worker) return 'skipped'; // every GPU busy

  inFlight += 1;
  if (isPaid) paidInFlight += 1;
  const { bid, concept } = await nextJob(peek);
  try {
    const prompt = (await writePrompt(concept)) + SAFETY_SUFFIX;
    console.log(
      `[scheduler] generating "${concept.title}" [${concept.genre}] via ${bid ? backendFor({paid:true}) : backend}` +
        `${worker ? ` @ ${worker.url}` : ''} (${bid ? `bid by ${bid.name} for ${bid.amount}cr` : 'auto'})`
    );
    const { file, duration, mock } = await generateClip(concept, prompt, bid?.durationSec, worker, { paid: !!bid });
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
    // An unreachable GPU is our problem, not the bidder's. Requeue without
    // consuming an attempt, otherwise an outage silently burns through every
    // paid bid's retries and refunds work people are still waiting for.
    const infra = /fetch failed|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|socket hang up|no GPU worker|worker \d{3}/i
      .test(err.message);
    if (bid) {
      if (infra) {
        console.warn('[scheduler] backend unavailable — requeueing bid without penalty');
        await db.settleBid(bid.id, 'pending-noretry');
      } else if (bid.attempts >= 2) {
        await db.settleBid(bid.id, 'failed');
      } else {
        await db.settleBid(bid.id, 'pending');
      }
    }
    if (infra) backendDownUntil = Date.now() + 60_000;
    return false;
  } finally {
    releaseWorker(worker);
    inFlight -= 1;
    if (isPaid) paidInFlight -= 1;
  }
}

// Burst mode: saturate every GPU in the pool until the batch drains.
async function runBatch() {
  if (batchRunning) return;
  batchRunning = true;
  try {
    while (batchRemaining > 0 && (await db.generationsLeftToday()) > 0) {
      // Local GPUs are limited by the pool; hosted backends (bedrock/fal) have
      // no worker to lease, so fan out to config.hostedConcurrency instead of
      // trickling one clip at a time.
      const backend = activeBackend();
      const capacity = backend === 'local' ? poolStatus().free : config.hostedConcurrency;
      // Never let seeding consume the whole hosted quota
      if (paidInFlight > 0 && backend !== 'local') await new Promise((r) => setTimeout(r, 5_000));
      const slots = Math.max(1, Math.min(capacity || 1, batchRemaining));
      const jobs = [];
      for (let i = 0; i < slots && batchRemaining > 0; i += 1) {
        batchRemaining -= 1;
        jobs.push(runOne());
      }
      const results = await Promise.all(jobs);
      // A job that never attempted generation must not consume its slot,
      // otherwise a transient backend outage silently eats the whole batch.
      const skipped = results.filter((r) => r === 'skipped').length;
      if (skipped) batchRemaining += skipped;
      if (!results.some((r) => r === true)) await new Promise((r) => setTimeout(r, 10_000));
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
  // A closed auction starts immediately in the reserved paid lane, even while
  // a background batch is holding the hosted backend busy.
  if (paidInFlight >= config.paidConcurrency) return false;
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
