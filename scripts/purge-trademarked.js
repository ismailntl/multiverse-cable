#!/usr/bin/env node
// Remove any library clip whose title/identifier hits the trademarked-character
// list. Public-domain prints of Betty Boop, Popeye, Superman etc. are free of
// copyright but the characters are still live trademarks — not something to air
// on a monetized channel. Run after changing the blocklist.
//
//   node scripts/purge-trademarked.js [--dry]
import { store } from '../lib/store.js';
import { trademarkedCharacterHit } from '../lib/copyright.js';

const dry = process.argv.includes('--dry');
const doomed = store.state.clips.filter((c) =>
  trademarkedCharacterHit(`${c.title ?? ''} ${c.archiveId ?? ''}`)
);

if (!doomed.length) {
  console.log('nothing to purge — library is clean');
  process.exit(0);
}

console.log(`${dry ? 'would remove' : 'removing'} ${doomed.length} clip(s):`);
for (const c of doomed) {
  console.log(`  - ${c.title} (${trademarkedCharacterHit(`${c.title} ${c.archiveId ?? ''}`)})`);
  if (!dry) store.removeClip(c.id);
}
console.log(`library now: ${store.state.clips.length} clips`);
process.exit(0);
