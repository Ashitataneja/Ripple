/**
 * Runs MediaPipe Hand Landmarker inside a Web Worker so inference never competes with the
 * water's render loop. Frames arrive as transferable ImageBitmaps; results go back as plain data.
 * Nothing leaves the browser.
 */
import type { HandLandmarker } from '@mediapipe/tasks-vision';

export type WorkerRequest =
  | { type: 'init'; modelUrl: string; wasmBaseUrl: string }
  | { type: 'frame'; bitmap: ImageBitmap; timestamp: number }
  | { type: 'close' };

export interface WorkerHand {
  landmarks: { x: number; y: number; z: number }[];
  handedness: string;
  score: number;
}

export type WorkerResponse =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'error'; message: string; phase: 'init' | 'inference' }
  | { type: 'result'; timestamp: number; hands: WorkerHand[]; ms: number };

interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  close(): void;
}

const scope = self as unknown as WorkerScope;

// MediaPipe loads its WASM glue with importScripts(), which module workers do not support.
// Provide an equivalent: fetch synchronously and evaluate in global scope.
(scope as unknown as { importScripts: (...urls: string[]) => void }).importScripts = (...urls: string[]) => {
  for (const url of urls) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.send();
    if (xhr.status !== 200 && xhr.status !== 0) throw new Error(`Failed to load ${url} (HTTP ${xhr.status})`);
    (0, eval)(`${xhr.responseText}\n//# sourceURL=${url}`);
  }
};

let landmarker: HandLandmarker | null = null;
let lastTimestamp = 0;

function post(msg: WorkerResponse): void {
  scope.postMessage(msg);
}

async function init(modelUrl: string, wasmBaseUrl: string): Promise<void> {
  const vision = await import('@mediapipe/tasks-vision');
  const fileset = await vision.FilesetResolver.forVisionTasks(wasmBaseUrl);
  const make = (delegate: 'GPU' | 'CPU') =>
    vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelUrl, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.5,
    });
  try {
    landmarker = await make('GPU');
    post({ type: 'ready', delegate: 'GPU' });
  } catch {
    landmarker = await make('CPU');
    post({ type: 'ready', delegate: 'CPU' });
  }
}

scope.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    init(msg.modelUrl, msg.wasmBaseUrl).catch((err) => post({ type: 'error', phase: 'init', message: (err as Error)?.message ?? String(err) }));
  } else if (msg.type === 'frame') {
    const bitmap = msg.bitmap;
    try {
      if (!landmarker) {
        post({ type: 'result', timestamp: msg.timestamp, hands: [], ms: 0 });
        return;
      }
      const ts = Math.max(lastTimestamp + 1, Math.round(msg.timestamp));
      lastTimestamp = ts;
      const t0 = performance.now();
      const result = landmarker.detectForVideo(bitmap, ts);
      const ms = performance.now() - t0;
      const handedness = result.handedness ?? result.handednesses ?? [];
      const hands: WorkerHand[] = [];
      const n = Math.min(2, result.landmarks?.length ?? 0);
      for (let i = 0; i < n; i++) {
        const cat = handedness[i]?.[0];
        hands.push({
          landmarks: result.landmarks[i].map((p) => ({ x: p.x, y: p.y, z: p.z })),
          handedness: cat?.categoryName ?? `hand${i}`,
          score: cat?.score ?? 0,
        });
      }
      post({ type: 'result', timestamp: msg.timestamp, hands, ms });
    } catch (err) {
      post({ type: 'error', phase: 'inference', message: (err as Error)?.message ?? String(err) });
      post({ type: 'result', timestamp: msg.timestamp, hands: [], ms: 0 });
    } finally {
      bitmap.close();
    }
  } else if (msg.type === 'close') {
    try {
      landmarker?.close();
    } catch {
      /* ignore */
    }
    landmarker = null;
    scope.close();
  }
};
