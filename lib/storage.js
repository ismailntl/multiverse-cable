import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Clip storage.
//
// Clips used to live only on the box that generated them and were served from
// local disk. That breaks the moment the web app runs anywhere else (a PaaS
// deploy has no video files at all), and it puts video egress on the app
// server. So clips are uploaded to S3 and the CDN/bucket URL is stored with
// the row; the local file stays as a cache and a fallback.
//
// With no bucket configured everything falls back to local /videos/ serving,
// so a local checkout still works unchanged.
// ---------------------------------------------------------------------------

export const s3Enabled = () => Boolean(config.s3Bucket);

export function publicUrl(key) {
  if (config.cdnBase) return `${config.cdnBase.replace(/\/$/, '')}/${key}`;
  return `https://${config.s3Bucket}.s3.${config.s3Region}.amazonaws.com/${key}`;
}

// Upload one clip and return its public URL (null when S3 isn't configured).
export async function uploadClip(file) {
  if (!s3Enabled()) return null;
  const local = path.join(config.videoDir, file);
  if (!fs.existsSync(local)) return null;
  const key = `clips/${file}`;
  const args = [
    's3', 'cp', local, `s3://${config.s3Bucket}/${key}`,
    '--content-type', 'video/mp4',
    // Clip files are immutable once written, so let the CDN keep them forever
    '--cache-control', 'public, max-age=31536000, immutable',
    '--only-show-errors',
  ];
  if (config.awsProfile) args.push('--profile', config.awsProfile);
  await exec('aws', args, { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 });
  return publicUrl(key);
}

export async function deleteClip(file) {
  if (!s3Enabled()) return;
  const args = ['s3', 'rm', `s3://${config.s3Bucket}/clips/${file}`, '--only-show-errors'];
  if (config.awsProfile) args.push('--profile', config.awsProfile);
  try {
    await exec('aws', args, { timeout: 60_000 });
  } catch {
    // A missing object is fine; never fail a takedown over cleanup
  }
}
