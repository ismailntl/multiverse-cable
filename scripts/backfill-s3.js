#!/usr/bin/env node
// Upload every clip that has no url yet, then record it.
// Safe to re-run: only touches rows where url is null.
import { q, ping, close } from '../lib/db.js';
import { uploadClip, s3Enabled } from '../lib/storage.js';

if (!s3Enabled()) { console.error('S3_BUCKET not configured'); process.exit(1); }
if (!(await ping())) { console.error('database unreachable'); process.exit(1); }

const rows = await q('select id, file from clips where url is null order by created_at');
console.log(`${rows.length} clip(s) to upload`);
let ok = 0, miss = 0;
const CONC = 6;
let i = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (i < rows.length) {
    const r = rows[i++];
    try {
      const url = await uploadClip(r.file);
      if (!url) { miss += 1; continue; }
      await q('update clips set url = $2 where id = $1', [r.id, url]);
      ok += 1;
      if (ok % 25 === 0) console.log(`  ${ok}/${rows.length}`);
    } catch (e) {
      miss += 1;
      console.warn(`  skip ${r.file}: ${e.message.slice(0, 80)}`);
    }
  }
}));
console.log(`uploaded ${ok}, skipped ${miss} (missing local file or error)`);
await close();
process.exit(0);
