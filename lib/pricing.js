import { config } from './config.js';

// ---------------------------------------------------------------------------
// Unit economics.
//
// The rule: a slot must always cost the bidder more than it costs us to make,
// no matter how long the requested video is. So price scales with duration
// rather than being a flat per-bid fee.
//
// Cost side (measured, us-east-1 on-demand g5.2xlarge @ $1.212/hr):
//   a 6s clip at ~60s of GPU wall-clock ≈ $0.020  ≈ $0.0034 per second of video
//   even at a pessimistic 3 min/clip     ≈ $0.061  ≈ $0.0101 per second
// Revenue side (credit packs): $0.033–$0.050 per credit.
//
// At the default 5 credits/second a 6s slot bills 30 credits ≈ $1.00–$1.50
// against ~$0.02–$0.06 of GPU — roughly a 20–50x gross margin, which also has
// to cover storage, egress, moderation, and the free auto-generated
// programming that fills the schedule between paid slots.
// ---------------------------------------------------------------------------

export const GPU_COST_PER_HOUR = Number(process.env.GPU_COST_PER_HOUR ?? 1.212);
export const GPU_SECONDS_PER_CLIP = Number(process.env.GPU_SECONDS_PER_CLIP ?? 90);

export function estimatedClipCostUsd(durationSec) {
  // GPU time scales roughly with output length
  const gpuSeconds = GPU_SECONDS_PER_CLIP * (durationSec / config.videoDuration);
  return (GPU_COST_PER_HOUR / 3600) * gpuSeconds;
}

// Average dollars per credit across the packs on sale (worst case for us =
// the cheapest pack, which is what we price against).
export function usdPerCredit() {
  return Math.min(...config.creditPacks.map((p) => p.priceCents / 100 / p.credits));
}

// The floor: what a slot of this length and kind must cost, in credits.
export function minimumBid({ durationSec, kind = 'show' }) {
  const perSecond = kind === 'ad' ? config.creditsPerSecondAd : config.creditsPerSecond;
  return Math.max(config.minBidCredits, Math.ceil(durationSec * perSecond));
}

export function quote({ durationSec, kind = 'show' }) {
  const credits = minimumBid({ durationSec, kind });
  const revenueUsd = credits * usdPerCredit();
  const costUsd = estimatedClipCostUsd(durationSec);
  return {
    durationSec,
    kind,
    minCredits: credits,
    approxUsd: Number(revenueUsd.toFixed(2)),
    estCostUsd: Number(costUsd.toFixed(4)),
    marginMultiple: Number((revenueUsd / Math.max(costUsd, 1e-6)).toFixed(1)),
  };
}

// What the UI needs to render the pricing table.
export function priceTable() {
  const durations = [];
  for (let d = config.minSlotSec; d <= config.maxSlotSec; d += 2) durations.push(d);
  return {
    creditsPerSecond: config.creditsPerSecond,
    creditsPerSecondAd: config.creditsPerSecondAd,
    minBidCredits: config.minBidCredits,
    minSlotSec: config.minSlotSec,
    maxSlotSec: config.maxSlotSec,
    usdPerCredit: Number(usdPerCredit().toFixed(4)),
    show: durations.map((d) => ({ durationSec: d, minCredits: minimumBid({ durationSec: d, kind: 'show' }) })),
    ad: durations.map((d) => ({ durationSec: d, minCredits: minimumBid({ durationSec: d, kind: 'ad' }) })),
  };
}
