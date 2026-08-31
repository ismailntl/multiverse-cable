import { config } from './config.js';
import { store } from './store.js';
import { generateClip, activeBackend, leaseWorker, releaseWorker, poolStatus } from './generate.js';
import { randomConcept, conceptFromBid, writePrompt, SAFETY_SUFFIX } from './shows.js';
import { moderate } from './moderation.js';

let inFlight = 0;
let batchRemaining = 0;
let batchRunning = false;

// Pick the next thing to make: highest pending bid, else a random concept.
// Bids are re-moderated here even though intake already checked them — defense
// in depth if a rule changed while the bid sat in the queue.
async function nextJob() {
  let bid = store.topPendingBid();
  while (bid) {
    const verdict = await moderate(bid.idea);
    if (verdict.allowed) break;
    console.warn(`[scheduler] bid ${bid.id} rejected at generation time: ${verdict.reason}`);
    store.settleBid(bid.id, 'rejected');
    bid = store.topPendingBid();
  }
  return { bid, concept: bid ? conceptFromBid(bid) : randomConcept() };
}

// Generate one clip on a leased GPU. Returns true when a clip made it to air.
async function runOne() {
  if (store.generationsLeftToday() <= 0) {
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
    const clip = store.addClip({
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
    if (bid) store.settleBid(bid.id, 'aired', clip.id);
    console.log(`[scheduler] on air: "${concept.title}" (${duration.toFixed(1)}s, library=${store.state.clips.length})`);
    return true;
  } catch (err) {
    console.error(`[scheduler] generation failed: ${err.message}`);
    store.recordFailure();
    if (bid) {
      // Give a paid slot two retries before refunding it out of the queue
      if (bid.attempts >= 2) store.settleBid(bid.id, 'failed');
      else store.settleBid(bid.id, 'pending');
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
    while (batchRemaining > 0 && store.generationsLeftToday() > 0) {
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
export function kickNow() {
  const { free } = poolStatus();
  if (activeBackend() === 'local' && free <= 0) return false;
  if (inFlight > 0 && activeBackend() !== 'local') return false;
  runOne();
  return true;
}

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
