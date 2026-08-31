import { config } from './config.js';
import { store } from './store.js';
import { generateClip, activeBackend } from './generate.js';
import { randomConcept, conceptFromBid, writePrompt, SAFETY_SUFFIX } from './shows.js';
import { moderate } from './moderation.js';

let busy = false;
let batchRemaining = 0;

async function tick() {
  if (busy) return false;
  if (store.generationsLeftToday() <= 0) {
    console.log('[scheduler] daily generation limit reached, coasting on the library');
    return false;
  }

  let bid = store.topPendingBid();
  // Re-moderate the bid right before generation — defense in depth in case
  // anything slipped past intake (or moderation config changed since).
  while (bid) {
    const verdict = await moderate(bid.idea);
    if (verdict.allowed) break;
    console.warn(`[scheduler] bid ${bid.id} rejected at generation time: ${verdict.reason}`);
    store.settleBid(bid.id, 'rejected');
    bid = store.topPendingBid();
  }

  const concept = bid ? conceptFromBid(bid) : randomConcept();
  busy = true;
  try {
    const prompt = (await writePrompt(concept)) + SAFETY_SUFFIX;
    console.log(
      `[scheduler] generating "${concept.title}" [${concept.genre}] via ${activeBackend()} ` +
        `(${bid ? `bid by ${bid.name} for ${bid.amount}cr` : 'auto'})`
    );
    const { file, duration, mock } = await generateClip(concept, prompt);
    const clip = store.addClip({
      file,
      duration,
      mock,
      title: concept.title,
      channel: concept.channel,
      genre: concept.genre,
      isAd: !!concept.isAd,
      prompt,
      source: bid ? (bid.kind === 'ad' ? 'ad' : 'bid') : 'auto',
      bidder: bid?.name ?? null,
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
    busy = false;
  }
}

// Burst mode: scripts/batch.js boots the GPU spot instance, then asks the
// scheduler to run N generations back-to-back while the box is up.
let batchRunning = false;
async function runBatch() {
  if (batchRunning) return;
  batchRunning = true;
  try {
    while (batchRemaining > 0 && store.generationsLeftToday() > 0) {
      batchRemaining -= 1;
      const ok = await tick();
      await new Promise((r) => setTimeout(r, ok ? 1000 : 10_000));
    }
    batchRemaining = 0;
  } finally {
    batchRunning = false;
  }
}

export function requestBatch(count) {
  batchRemaining = Math.min(500, batchRemaining + count);
  runBatch();
  return batchRemaining;
}

export function batchStatus() {
  return { remaining: batchRemaining, busy };
}

export function startScheduler() {
  console.log(
    `[scheduler] backend=${activeBackend()} interval=${config.genIntervalSec}s ` +
      `duration=${config.videoDuration}s dailyLimit=${config.dailyGenLimit}`
  );
  tick();
  setInterval(() => {
    if (batchRemaining === 0) tick();
  }, config.genIntervalSec * 1000);
}
