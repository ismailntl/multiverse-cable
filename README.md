# 📺 Multiverse Cable

**multiversecable.com**

A 24/7 AI-generated TV channel. A scheduler continuously generates short absurd
"broadcasts from other dimensions", stitches them into one endless synced
stream, and viewers **bid credits to program the next slot** — highest pending
bid wins each generation cycle.

## How it works

```
 viewers ──POST /api/bid──▶ bid board (highest pending bid wins next slot)
                                 │
 scheduler (every GEN_INTERVAL_SEC)
   ├─ concept  = winning bid idea  OR  random multiverse show
   ├─ prompt   = Claude show-writer (optional) OR template
   ├─ video    = backend: local GPU worker | MiniMax H3 API | ffmpeg mock
   └─ clip → videos/ + playlist (data/state.json)
                                 │
 broadcast clock: every viewer's player syncs to the same wall-clock
 position in the looping library (GET /api/now → clip + offset)
```

Everything is plain Node (one dependency: `@anthropic-ai/sdk`, optional at
runtime) + ffmpeg. State is a JSON file. No database, no build step.

## Quick start (zero keys, zero GPUs)

```bash
npm install
npm run dev        # mock backend: ffmpeg test-pattern clips every 20s
# open http://localhost:4242
```

## Generation backends

Priority: `GEN_BACKEND` env > `LOCAL_WORKER_URL` set → **local** >
`MINIMAX_API_KEY` set → **minimax** > **mock**.

### 1. `local` — self-hosted GPU worker (recommended, use AWS credits)

Runs open-weight text-to-video (LTX-Video family by default) on your own EC2
GPU instance. See [gpu-worker/](gpu-worker/) and [docs/COSTS.md](docs/COSTS.md)
— roughly **$45/day on-demand (g6e.xlarge)** vs **$7–11k/day** for continuous
hosted-API generation.

```bash
# on the GPU box (Deep Learning AMI, g6e.xlarge):
bash gpu-worker/setup.sh                       # serves :8189

# on the platform box:
LOCAL_WORKER_URL=http://<gpu-ip>:8189 WORKER_TOKEN=<secret> npm start
```

### 2. `minimax` — MiniMax H3 (Hailuo 3.0) hosted API

Highest quality (native 2K + audio). `POST /v2/video_generation` with model
`MiniMax-H3`, polled via `/v2/query/video_generation/{task_id}`. **Cost scales
with `GEN_INTERVAL_SEC`** — see docs/COSTS.md before turning this on. Good as a
premium tier (e.g. only bid-funded slots use H3).

```bash
MINIMAX_API_KEY=... VIDEO_RESOLUTION=768P GEN_INTERVAL_SEC=600 npm start
```

### 3. `mock` — ffmpeg test patterns

No keys, no GPU. Lets you develop/demo the full loop (bids, scheduling,
broadcast sync) for free.

## Spend guardrails

- `GEN_INTERVAL_SEC` — one new clip per interval; the library loops between
  new clips, so the channel is always "on air" regardless of cadence.
- `DAILY_GEN_LIMIT` — hard cap; when hit, the channel coasts on the library.
- `MAX_LIBRARY_CLIPS` — old auto clips are pruned (bid-funded clips are kept).
- Failed bid generations retry twice, then the bid is marked `failed`.

## API

| Route | Description |
|---|---|
| `GET /api/now` | current clip + playback offset (broadcast sync) |
| `GET /api/state` | stats, bid board, next slot, recent clips |
| `POST /api/bid` | `{name, idea, amount}` — place a bid (demo credits) |
| `GET /videos/:file` | clip files (HTTP Range supported) |

## Notes / roadmap

- **Bids are demo credits** — no payments. Wire Stripe Checkout in front of
  `POST /api/bid` for real money (hold funds, capture on air, refund on fail).
- **MiniMax H3 open weights**: announced but need ~80GB VRAM — revisit
  self-hosting H3 when quantized single-GPU builds land.
- Frontend is one static file ([public/index.html](public/index.html)):
  CRT-styled synced player, bid form, bid board, stats.

## License

**AGPL-3.0-or-later** — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Use it, fork it, learn from it. Two conditions: if you run it (or a modified
version) as a network service, you must publish your source; and keep the
attribution in [NOTICE](NOTICE). If you want to run it commercially without
the source-disclosure obligation, open an issue.

Built by [Ismail Nafaa](https://github.com/ismailntl) — https://multiversecable.com
