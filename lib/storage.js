import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// ---------------------------------------------------------------------------
// Clip storage (S3).
//
// This used to shell out to the AWS CLI, which is fine on a dev box with an SSO
// profile but not on managed hosting, where there is no CLI and no ~/.aws. It
// now uses the SDK, so it works anywhere the standard credential chain resolves
// — env vars on a PaaS, an instance role on EC2, or the local SSO profile.
//
// With no bucket configured everything falls back to serving /videos/ locally,
// so a plain checkout still runs.
// ---------------------------------------------------------------------------

export const s3Enabled = () => Boolean(config.s3Bucket);

let client = null;
async function s3() {
  if (client) return client;
  const { S3Client } = await import('@aws-sdk/client-s3');
  client = new S3Client({ region: config.s3Region });
  return client;
}

export function publicUrl(key) {
  if (config.cdnBase) return `${config.cdnBase.replace(/\/$/, '')}/${key}`;
  return `https://${config.s3Bucket}.s3.${config.s3Region}.amazonaws.com/${key}`;
}

// Whether the SDK can actually resolve credentials in this process. s3Enabled()
// only looks at the bucket name, so it says "configured" while every upload
// throws -- which is how 15 clips reached air with no URL.
export async function credentialStatus() {
  if (!s3Enabled()) return { resolved: false, reason: 'no bucket configured' };
  try {
    const c = await s3();
    const creds = await c.config.credentials();
    return {
      resolved: Boolean(creds?.accessKeyId),
      // Last four only, so two environments can be compared without exposing a key
      keyIdTail: creds?.accessKeyId ? creds.accessKeyId.slice(-4) : null,
    };
  } catch (err) {
    return { resolved: false, reason: `${err.name}: ${err.message}`.slice(0, 160) };
  }
}

// Upload one clip and return its public URL (null when S3 isn't configured).
export async function uploadClip(file) {
  if (!s3Enabled()) return null;
  const local = path.join(config.videoDir, file);
  if (!fs.existsSync(local)) return null;

  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const key = `clips/${file}`;
  await (await s3()).send(new PutObjectCommand({
    Bucket: config.s3Bucket,
    Key: key,
    Body: fs.createReadStream(local),
    ContentLength: fs.statSync(local).size,
    ContentType: 'video/mp4',
    // Clip files are immutable once written, so let the CDN keep them forever
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  return publicUrl(key);
}

export async function deleteClip(file) {
  if (!s3Enabled()) return;
  try {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await (await s3()).send(new DeleteObjectCommand({
      Bucket: config.s3Bucket, Key: `clips/${file}`,
    }));
  } catch {
    // A missing object is fine; never fail a takedown over cleanup
  }
}
