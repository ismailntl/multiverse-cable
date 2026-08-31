#!/usr/bin/env node
// Daily batch run: start the GPU spot instance, point the platform at it,
// burst-generate BATCH_COUNT clips, then stop the instance. The channel
// coasts on its library (plus the free archive feed) the rest of the day.
//
// Cron example (9:00 UTC daily):
//   0 9 * * * cd ~/multiverse-cable && node scripts/batch.js >> data/batch.log 2>&1
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const inst = JSON.parse(fs.readFileSync(path.join(root, 'data', 'instance.json'), 'utf8'));
const workerFile = path.join(root, 'data', 'worker.json');

const PLATFORM = process.env.PLATFORM_URL || 'http://127.0.0.1:4242';
const BATCH_COUNT = parseInt(process.env.BATCH_COUNT || '80', 10);
const BOOT_TIMEOUT_MIN = 45;
const BATCH_TIMEOUT_MIN = parseInt(process.env.BATCH_TIMEOUT_MIN || '300', 10);

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function aws(...args) {
  const { stdout } = await exec('aws', ['--region', inst.region, '--profile', inst.profile, ...args]);
  return stdout.trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log(`starting GPU instance ${inst.instanceId}`);
  await aws('ec2', 'start-instances', '--instance-ids', inst.instanceId);
  await aws('ec2', 'wait', 'instance-running', '--instance-ids', inst.instanceId);
  const ip = await aws('ec2', 'describe-instances', '--instance-ids', inst.instanceId,
    '--query', 'Reservations[0].Instances[0].PublicIpAddress', '--output', 'text');
  const url = `http://${ip}:8189`;
  log(`instance running at ${url}, waiting for worker health (first boot loads model weights)`);

  const bootDeadline = Date.now() + BOOT_TIMEOUT_MIN * 60_000;
  let healthy = false;
  while (Date.now() < bootDeadline) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) { healthy = true; break; }
    } catch {}
    await sleep(20_000);
  }
  if (!healthy) throw new Error(`worker never became healthy within ${BOOT_TIMEOUT_MIN} min`);

  fs.writeFileSync(workerFile, JSON.stringify({ url, token: inst.token, instanceId: inst.instanceId, updatedAt: Date.now() }));
  log(`worker healthy — queuing batch of ${BATCH_COUNT}`);

  const q = await fetch(`${PLATFORM}/api/admin/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: BATCH_COUNT }),
  });
  if (!q.ok) throw new Error(`platform batch trigger failed: ${q.status} ${await q.text()}`);

  const batchDeadline = Date.now() + BATCH_TIMEOUT_MIN * 60_000;
  while (Date.now() < batchDeadline) {
    await sleep(60_000);
    try {
      const s = await (await fetch(`${PLATFORM}/api/state`)).json();
      log(`batch remaining=${s.batch.remaining} busy=${s.batch.busy} library=${s.libraryClips}`);
      if (s.batch.remaining === 0 && !s.batch.busy) break;
    } catch (e) {
      log('state poll failed:', e.message);
    }
  }
}

async function cleanup() {
  try { fs.unlinkSync(workerFile); } catch {}
  try {
    log(`stopping instance ${inst.instanceId}`);
    await aws('ec2', 'stop-instances', '--instance-ids', inst.instanceId);
  } catch (e) {
    log('STOP FAILED — instance may still be running, check the console:', e.message);
    process.exitCode = 1;
  }
}

main()
  .then(() => log('batch complete'))
  .catch((e) => { log('batch failed:', e.message); process.exitCode = 1; })
  .finally(cleanup);
