// Copies the MediaPipe Tasks Vision WASM runtime from node_modules into
// public/mediapipe/wasm so it is served locally (no CDN, no uploads).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const dest = join(root, 'public', 'mediapipe', 'wasm');

if (!existsSync(src)) {
  console.warn('[ripple] @mediapipe/tasks-vision is not installed; skipping WASM copy.');
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('[ripple] MediaPipe WASM runtime copied to public/mediapipe/wasm');

const model = join(root, 'public', 'models', 'hand_landmarker.task');
if (!existsSync(model)) {
  console.warn('[ripple] Hand landmarker model missing. Run `npm run fetch-model` to enable hand tracking.');
}
