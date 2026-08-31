import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.js';

// Must run before anything below reads process.env
loadEnv();

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

  // fal.ai — hosted frontier video models (Seedance, Kling, Veo, MiniMax H3).
  // Closed-weight models can't be self-hosted at any price, so this is the only
  // route to top-tier realism + native audio.
  falKey: process.env.FAL_KEY || '',
  falModel: process.env.FAL_MODEL || 'fal-ai/bytedance/seedance/v2/fast/text-to-video',
  falResolution: process.env.FAL_RESOLUTION || '720p',

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

  // Viewer clip uploads (paid). Uploaded video CANNOT be machine-screened the
  // way a text prompt can, so uploads always land in a human review queue and
  // never air automatically. See docs/POLICY.md.
  // Slot pricing — see lib/pricing.js for the unit economics behind these
  creditsPerSecond: Number(process.env.CREDITS_PER_SECOND ?? 5),
  creditsPerSecondAd: Number(process.env.CREDITS_PER_SECOND_AD ?? 10),
  minBidCredits: int(process.env.MIN_BID_CREDITS, 10),
  minSlotSec: int(process.env.MIN_SLOT_SEC, 4),
  maxSlotSec: int(process.env.MAX_SLOT_SEC, 15),

  // Slot auction: bids collect for this long before the winner generates, so
  // we never burn GPU time on a clip that gets outbid seconds later.
  auctionWindowSec: int(process.env.AUCTION_WINDOW_SEC, 45),
  auctionAntiSnipeSec: int(process.env.AUCTION_ANTISNIPE_SEC, 15),
  viewerTtlSec: int(process.env.VIEWER_TTL_SEC, 45),

  // Clip hosting. Without a bucket, clips are served from local disk.
  s3Bucket: process.env.S3_BUCKET || '',
  s3Region: process.env.S3_REGION || 'us-east-1',
  cdnBase: process.env.CDN_BASE || '',
  awsProfile: process.env.AWS_PROFILE || '',

  databaseUrl: process.env.DATABASE_URL || '',
  supabaseUrl: process.env.SUPABASE_URL || '',

  guestChat: process.env.GUEST_CHAT !== '0',
  uploadCostCredits: int(process.env.UPLOAD_COST_CREDITS, 100),
  maxUploadMb: int(process.env.MAX_UPLOAD_MB, 200),
  maxUploadSec: int(process.env.MAX_UPLOAD_SEC, 60),
  // Demo mode grants credits without payment — never on by default, and
  // refused on a public origin (see lib/payments.js).
  allowDemoCredits:
    process.env.ALLOW_DEMO_CREDITS === '1' &&
    !/^https?:\/\/(?!localhost|127\.0\.0\.1)/.test(process.env.PUBLIC_URL || ''),
  adminToken: process.env.ADMIN_TOKEN || '',
  adminEmails: (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
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
