# Which video model should Multiverse Cable use?

*Researched 2026-08-31. Prices are per second of generated video.*

## The thing that decides this

**The best video models are closed weights.** Veo, Kling, Seedance and MiniMax
H3 cannot be self-hosted at any price - no GPU budget rents them. Self-hosting
caps you at open weights (LTX, Wan), which are a real tier below on realism and,
before LTX-2.x, silent.

That is why a competitor on fal.ai looks like a superior product: they are not
running a better version of our model, they are running models we structurally
cannot host, on optimized inference.

## Measured: what we run today

| | value |
|---|---|
| Model | LTX-Video 0.9.8 13B distilled (open weights) |
| Hardware | 1x L40S 48GB (g6e.xlarge, $1.861/hr on-demand) |
| Latency | ~90s per 6s clip (81s at 768x448 - sampling steps dominate, not resolution) |
| Cost | ~$0.047/clip = $0.0078 per second of video |
| Audio | none (0.9.x is video-only) |

## Hosted options (fal.ai)

| Model | $/sec | 6s clip | Notes |
|---|---|---|---|
| Seedance 2.0 Fast | ~$0.03 | ~$0.18 | unified audio+video, phoneme-level lip-sync |
| Seedance 1.5 Pro | ~$0.025 | ~$0.15 | cheapest live entry |
| Wan 2.5 | $0.05 | $0.30 | open-weight lineage, solid motion |
| Kling 2.5 Turbo Pro | $0.07 | $0.42 | topped the Artificial Analysis leaderboard |
| Kling 3.0 Pro | ~$0.112 | ~$0.67 | 4K/60fps in one pass |
| Veo 3.1 Fast -> Standard | $0.10 -> $0.20 | $0.60 -> $1.20 | premium tier |
| MiniMax H3 | - | - | also available here |

## The economics work

Slot pricing is 5 credits/second (10 for ads) and credits sell at $0.033-$0.050,
so one second of video earns $0.165-$0.25.

| Backend | cost/sec | margin on a show slot |
|---|---|---|
| Self-hosted LTX | $0.008 | ~20-30x |
| Seedance 2.0 Fast | $0.03 | ~5-8x |
| Kling 2.5 Turbo Pro | $0.07 | ~2-3x |
| Veo 3.1 Standard | $0.20 | ~1x - premium bids only |

Self-hosting is ~4x cheaper per second than the cheapest hosted model. It is not
4x better value: it costs 90s of latency, has no audio, looks visibly worse, and
carries the ops burden of a GPU fleet. Seedance still leaves 5-8x margin.

## Recommendation

1. Default to Seedance 2.0 Fast on fal (`FAL_KEY` + `FAL_MODEL`). Native audio,
   fast, ~$0.18 per 6s clip against $1-1.50 of revenue. Fixes quality, speed and
   audio in one move.
2. Kling 2.5 Turbo Pro or Veo 3.1 for premium bids, gated behind a higher
   credits-per-second tier so the bidder covers the cost.
3. Keep the self-hosted GPU for free filler only, or shut it down. Batch
   overnight, stop the instance.
4. Parallelism buys wall-clock, not dollars - cost per clip is flat, so extra
   GPUs only matter for burst seeding.

`activeBackend()` in lib/generate.js prefers `fal` whenever FAL_KEY is set, then
the GPU pool, then MiniMax, then the ffmpeg mock.

## Labeling: AI vs public domain

Not symmetric.

- Public domain footage carries no labeling obligation. Prelinger items need no
  attribution. Calling it "public-domain archival footage" is honesty and good
  positioning, not a legal duty.
- AI-generated content increasingly does. Synthetic-media transparency rules
  (EU AI Act Art. 50, various US state laws) push toward disclosing that content
  is machine-generated. Treat AI labeling as required, PD labeling as optional.

This is why the "Real or AI?" game hides provenance only until the viewer votes
and always reveals the truth afterwards - a quiz beat, not a permanent removal
of AI disclosure. Have a lawyer confirm for your jurisdictions before launch.
