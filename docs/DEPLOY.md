# Deploying Multiverse Cable

The app is plain Node with no build step. What makes deployment non-trivial is
that a 24/7 video channel has three things a normal web app doesn't: video
files, GPU generation, and ffmpeg.

## Hostinger (GitHub auto-deploy)

Hostinger builds from the `main` branch. A fresh deploy returns **503 until the
environment variables below are set** — the app exits at boot without a
database, and serves an empty channel without clip storage.

### 1. Environment variables (Hostinger → Environment variables)

| Variable | Why |
|---|---|
| `DATABASE_URL` | Supabase Postgres. Without it the app falls back to a JSON file, which does not survive redeploys. |
| `S3_BUCKET` = `multiverse-cable-clips` | Where clips actually live. |
| `S3_REGION` = `us-east-1` | |
| `STRIPE_SECRET_KEY` | Live checkout. Demo mode grants credits for free without it. |
| `STRIPE_WEBHOOK_SECRET` | Without it, payments never credit accounts. |
| `PUBLIC_URL` = `https://multiversecable.com` | Stripe redirect targets. |
| `SECURE_COOKIES` = `1` | Session cookies must be `Secure` over HTTPS. |
| `ADMIN_EMAILS` | Who can see the upload review queue. |
| `FAL_KEY` *(recommended)* | Pay-per-clip generation — see COSTS.md. |
| `LOCAL_WORKER_URL`, `WORKER_TOKEN` *(optional)* | Only if you run your own GPU box. |
| `FREE_FEED` = `0` *(see below)* | The archive feed needs ffmpeg. |

`PORT` is supplied by the host and already read from the environment — don't set it.

### 2. Clips must come from object storage, not disk

`videos/` is gitignored, so a deployed instance has **no clip files**. Clips are
uploaded to S3 on creation and the row stores a `url`; the player uses that and
only falls back to `/videos/<file>` locally. Backfill anything created before
this existed:

```bash
node scripts/backfill-s3.js
```

### 3. ffmpeg is required by two features

`lib/freefeed.js` (archival clipping) and viewer upload transcoding both shell
out to `ffmpeg`/`ffprobe`. Managed Node hosting usually doesn't have them. If
`ffmpeg -version` fails on the host:

- set `FREE_FEED=0` so the archive feed doesn't error in a loop, and
- run the archive seeding from a machine that does have ffmpeg
  (`node scripts/seed-archive.js 80 5`), since clips land in shared S3 + Postgres
  and the deployed app will pick them up.

Uploads will fail to transcode without ffmpeg — keep the upload feature off
until it's available, or move transcoding to the GPU box.

### 4. If you run a GPU worker

Its security group must allow the deploy's egress IP on port 8189. It currently
allows this dev box and `multiversecable.com`'s resolved address. That address
can change on a managed host — prefer `FAL_KEY` for a PaaS deploy.

## Health check

```
GET /api/now     → 200 with the current clip, its offset, and viewer count
```

Boot logs state which backends resolved, e.g.
`(video: fal, store: postgres, stripe: live)`. `store: json` in production means
`DATABASE_URL` didn't resolve.

## Database migrations

Not run automatically. After changing `supabase/migrations/`:

```bash
supabase db push --db-url "postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres"
```

(This network has no IPv6, so the direct `db.<ref>` host is used rather than the
pooler — the pooler rejected `postgres.<ref>` as an unknown tenant.)

## Secrets

`.env` is gitignored and `.githooks/pre-commit` refuses to commit anything
shaped like a live credential. On a new clone: `git config core.hooksPath .githooks`.
Rotate any key that has ever been pasted into a chat or terminal transcript.

## Model weight cache (S3)

Model weights are ~187GB and take ~25 minutes to pull from HuggingFace — dead
instance time on every launch, at GPU hourly rates.

They are cached in `s3://$S3_BUCKET/model-cache/<model-id>/` instead. On boot
the instance syncs from there before starting the worker; once the model
actually loads, a cron job pushes the cache back (guarded by a marker file so
it only happens once).

**Why S3 and not a persistent EBS volume:** EBS volumes are pinned to a single
Availability Zone. GPU capacity is scarce and dictates which AZ you can launch
in — p5.4xlarge was exhausted in all six us-east-1 AZs on 2026-08-31, and the
run landed on whichever AZ had room. A cache volume in the wrong AZ is useless.
S3 is region-wide, same-region transfer is free, and it is roughly a fifth the
cost of keeping the volume around.

Access is via the `mc-gpu-worker` IAM instance profile, scoped to the
`model-cache/*` prefix only — no credentials in user-data.
