import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

export const config = {
  root,
  dataDir: path.join(root, 'data'),
  videoDir: path.join(root, 'videos'),
  publicDir: path.join(root, 'public'),

  port: int(process.env.PORT, 4242),

  // Self-hosted GPU worker (gpu-worker/worker.py on an EC2 GPU box)
  localWorkerUrl: process.env.LOCAL_WORKER_URL || '',
  workerToken: process.env.WORKER_TOKEN || '',

  // MiniMax H3 (Hailuo 3.0) hosted API — optional premium backend
  minimaxKey: process.env.MINIMAX_API_KEY || '',
  minimaxBase: process.env.MINIMAX_BASE_URL || 'https://api.minimax.io',
  minimaxModel: process.env.MINIMAX_MODEL || 'MiniMax-H3',
  videoDuration: int(process.env.VIDEO_DURATION_SEC, 6), // H3 accepts 4-15s
  videoResolution: process.env.VIDEO_RESOLUTION || '768P', // '768P' | '2K'
  videoRatio: process.env.VIDEO_RATIO || '16:9',

  // Generation cadence and spend guardrails
  genIntervalSec: int(process.env.GEN_INTERVAL_SEC, 300), // new clip every N seconds
  dailyGenLimit: int(process.env.DAILY_GEN_LIMIT, 200),
  maxLibraryClips: int(process.env.MAX_LIBRARY_CLIPS, 500), // oldest auto-clips pruned past this

  // Optional: Claude writes the show concepts / video prompts
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  conceptModel: process.env.CONCEPT_MODEL || 'claude-opus-5',

  // Accounts / credits / payments
  signupBonusCredits: int(process.env.SIGNUP_BONUS_CREDITS, 25),
  sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 30),
  termsVersion: process.env.TERMS_VERSION || '2026-08-31',
  stripeKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${int(process.env.PORT, 4242)}`,
  secureCookies: process.env.SECURE_COOKIES === '1',
};

// Credit packs offered at checkout (price in cents)
config.creditPacks = [
  { id: 'starter', credits: 100, priceCents: 500, label: 'Starter — 100 credits' },
  { id: 'primetime', credits: 500, priceCents: 2000, label: 'Primetime — 500 credits' },
  { id: 'network', credits: 1500, priceCents: 5000, label: 'Network Exec — 1500 credits' },
];

// Free public-domain video feed (Internet Archive) spliced into the broadcast
config.freeFeed = process.env.FREE_FEED !== '0';
config.freeFeedIntervalSec = int(process.env.FREE_FEED_INTERVAL_SEC, 900);
config.freeFeedClipSec = int(process.env.FREE_FEED_CLIP_SEC, 30);

// Backend: explicit GEN_BACKEND wins; otherwise resolved per-generation in
// generate.js (batch-launched GPU worker > env worker > minimax > mock).
config.genBackend = process.env.GEN_BACKEND || 'auto';
config.workerStateFile = path.join(root, 'data', 'worker.json');
