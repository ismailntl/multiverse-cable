import pg from 'pg';
import { config } from './config.js';

// ---------------------------------------------------------------------------
// Postgres (Supabase) access layer.
//
// Everything that touches money goes through the SQL functions defined in the
// migration (adjust_credits / place_bid / refund_bid) so the balance and its
// ledger row can never disagree, even under concurrent requests. The JSON file
// store had no transactions and two processes silently clobbered each other.
//
// If DATABASE_URL is unset the app falls back to the JSON store, so a local
// checkout still runs with no database.
// ---------------------------------------------------------------------------

export const dbEnabled = Boolean(config.databaseUrl);

let pool = null;

export function getPool() {
  if (!dbEnabled) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      // Supabase terminates TLS at the pooler with its own CA chain
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  }
  return pool;
}

export async function q(text, params = []) {
  const res = await getPool().query(text, params);
  return res.rows;
}

export async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] ?? null;
}

// Run several statements in a single transaction.
export async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function ping() {
  try {
    await q('select 1');
    return true;
  } catch (err) {
    console.error('[db] ping failed:', err.message);
    return false;
  }
}

export async function close() {
  if (pool) await pool.end();
  pool = null;
}

// --- row mappers: snake_case columns -> the camelCase shape the app uses ----

export const mapUser = (r) =>
  r && {
    id: r.id,
    email: r.email,
    passHash: r.pass_hash,
    salt: r.salt,
    credits: r.credits,
    ageAttestedAt: r.age_attested_at ? new Date(r.age_attested_at).getTime() : null,
    termsVersion: r.terms_version,
    isAdmin: r.is_admin,
    createdAt: new Date(r.created_at).getTime(),
  };

export const mapClip = (r) =>
  r && {
    id: r.id,
    file: r.file,
    url: r.url ?? null,
    title: r.title,
    channel: r.channel,
    duration: Number(r.duration),
    genre: r.genre,
    source: r.source,
    isAd: r.is_ad,
    prompt: r.prompt,
    archiveId: r.archive_id,
    bidder: r.bidder,
    amount: r.amount,
    mock: r.mock,
    createdAt: new Date(r.created_at).getTime(),
  };

export const mapBid = (r) =>
  r && {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    idea: r.idea,
    kind: r.kind,
    genre: r.genre,
    durationSec: r.duration_sec,
    amount: r.amount,
    status: r.status,
    attempts: r.attempts,
    refunded: r.refunded,
    clipId: r.clip_id,
    ad: r.ad_brand ? { brand: r.ad_brand, product: r.ad_product, cta: r.ad_cta } : null,
    createdAt: new Date(r.created_at).getTime(),
  };

export const mapUpload = (r) =>
  r && {
    id: r.id,
    userId: r.user_id,
    email: r.email,
    file: r.file,
    url: r.url ?? null,
    title: r.title,
    duration: Number(r.duration),
    amount: r.amount,
    status: r.status,
    reviewNote: r.review_note,
    clipId: r.clip_id,
    createdAt: new Date(r.created_at).getTime(),
  };

export const mapChat = (r) =>
  r && {
    id: r.id,
    name: r.name,
    text: r.text,
    system: r.system,
    guest: r.guest,
    createdAt: new Date(r.created_at).getTime(),
  };
