import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Minimal .env loader. Values already in the real environment win, so a
// deployment can override the file without editing it.
export function loadEnv() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const file = path.join(root, '.env');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    // Support ${VAR} references to values defined earlier in the file
    value = value.replace(/\$\{(\w+)\}/g, (_, v) => process.env[v] ?? '');
    if (!(key in process.env)) process.env[key] = value;
  }
}
