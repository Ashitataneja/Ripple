// Downloads the MediaPipe Hand Landmarker model (Apache-2.0) into public/models.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'public', 'models', 'hand_landmarker.task');

if (existsSync(dest) && !process.argv.includes('--force')) {
  console.log('[ripple] Model already present at public/models/hand_landmarker.task');
  process.exit(0);
}
mkdirSync(dirname(dest), { recursive: true });
console.log(`[ripple] Downloading ${MODEL_URL}`);
const res = await fetch(MODEL_URL);
if (!res.ok) {
  console.error(`[ripple] Download failed: HTTP ${res.status}`);
  process.exit(1);
}
writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
console.log('[ripple] Saved public/models/hand_landmarker.task');
