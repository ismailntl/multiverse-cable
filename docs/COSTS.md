# Cost analysis — 24/7 AI video channel

*(researched 2026-08-31; prices are us-east-1 on-demand unless noted)*

## The key insight

"24/7 channel" ≠ "24/7 generation". The broadcast loops its library and
splices in new clips as they finish. **Cost is set by generation cadence
(`GEN_INTERVAL_SEC`), not by air time.** Viewers still get an always-on stream.

## Option A — MiniMax H3 hosted API

Reported pricing ≈ **$0.13/s of 2K video** (≈$7.80/min); 768P is cheaper but
same order of magnitude.

| Cadence | Video generated/day | $/day (2K) | $/month |
|---|---|---|---|
| Truly continuous (86,400 s/day) | 24 h | **~$7,000–11,000** | ~$250–340k |
| 6s clip / 5 min | 1,728 s | ~$225 | ~$6.7k |
| 6s clip / 15 min | 576 s | ~$75 | ~$2.2k |

Verdict: unusable as the always-on workhorse; fine as a **premium tier**
(e.g. only paid bids ≥ N credits render on H3 at 2K).

## Option B — self-hosted open weights on AWS (recommended)

MiniMax H3's open weights need ~80GB VRAM (A100/H100-class → p4de/p5 boxes,
$40–98/hr — not worth it). The practical choices are the open-weight models
that fit a single 48GB L40S:

- **LTX-Video / LTX-2.x** (Lightricks, permissive license) — fastest family;
  distilled variants approach real-time on top GPUs. Best throughput/$: the
  default in `gpu-worker/worker.py`.
- **Wan 2.x** (Alibaba) — higher fidelity, slower; good "quality" alternative.
- **HunyuanVideo 1.5** — middle ground (reported ~75s per clip on a 4090).

### Instance pricing

| Instance | GPU | On-demand | $/day | $/month |
|---|---|---|---|---|
| **g6e.xlarge** ⭐ | 1× L40S 48GB | $1.86/hr | ~$45 | ~$1,360 |
| g6e.2xlarge | 1× L40S 48GB (more CPU/RAM) | ~$2.24/hr | ~$54 | ~$1,630 |
| g6.xlarge (budget) | 1× L4 24GB | ~$0.80/hr | ~$19 | ~$585 |
| p4de.24xlarge (only if H3 weights) | 8× A100 80GB | ~$41/hr | ~$980 | ~$29.5k |

Spot pricing on g6e is typically 50–70% off (≈ $550–650/mo effective) —
fine here since a killed instance just pauses new clips; the channel keeps
looping its library.

### Effective cost per clip

At $1.86/hr, if a 6s clip takes ~1–3 min on the L40S: **$0.03–0.09/clip**,
vs **$0.50–0.80/clip** on the H3 API. Generating ~500–1,400 clips/day the
box is saturated and cost is flat — the more you generate, the bigger the win.

## Recommended setup

1. **g6e.xlarge + LTX** as the always-on workhorse (~$1.4k/mo on-demand,
   covered by AWS credits; switch to spot or a savings plan later).
2. Platform server itself is negligible (t3.small ~$15/mo, or reuse an
   existing box) + S3/CloudFront for clips if traffic grows.
3. Optionally add `minimax` backend for premium bid slots only.

**Bottom line: ~$1.4–1.5k/mo on-demand (≈$50/day) instead of ~$7k/day** —
a ~150× reduction — and it burns credits, not cash.
