# Contributing

Thanks for looking. This is a working 24/7 channel, not a demo, so the fastest
way in is to run it locally and break something.

## Run it

```bash
npm install
cp .env.example .env      # nothing in it is required to start
npm start                 # http://localhost:4242
```

With no keys at all it runs on the `mock` backend (ffmpeg test patterns) and a
JSON file store — enough to work on the player, the auction, chat, moderation
or the game without a cloud account. Add `DATABASE_URL` for Postgres, and a
generation key when you want real video.

## Where things live

| Path | What it does |
|---|---|
| `server.js` | every HTTP route, auth, rate limits |
| `lib/playout.js` | the schedule — what airs when, and why paid clips jump the queue |
| `lib/auction.js` | the bidding window |
| `lib/generate.js` | generation backends (bedrock, fal, local GPU, mock) |
| `lib/moderation.js`, `lib/copyright.js` | content and trademark screening |
| `lib/pgstore.js` | Postgres access; money moves through SQL functions only |
| `public/index.html` | the entire frontend, one file, no build step |

## House rules

Two things are not negotiable, because the project only works if they hold:

1. **Nothing involving minors can ever be generated.** It is enforced in five
   layers and every rejection is written to `moderation_log`. Don't weaken any
   of them.
2. **An AI-generated clip must never finish playing unlabelled.** The
   real-or-AI game may hide provenance while a clip runs; the reveal before it
   ends is a legal requirement, not a UX choice.

Beyond that: credits move only through `adjust_credits()` / `place_bid()` so a
balance and its ledger can never disagree. If you touch money, keep it in SQL.

## Before opening a PR

- `node --check` every file you changed (there is no build step to catch you).
- Escape anything user-supplied that reaches the DOM with the existing `esc()`.
- Never commit real credentials. `.githooks/pre-commit` blocks the obvious
  shapes — enable it with `git config core.hooksPath .githooks`.

Issues labelled **good first issue** are self-contained and don't need cloud
access. Questions are welcome as issues.
