import type { HandLandmarker, HandLandmarkerResult } from '@mediapipe/tasks-vision';
import type { HandFrame, TrackedHand } from './GestureClassifier';
import type { WorkerRequest, WorkerResponse } from './handWorker';

export class HandTrackerError extends Error {
  constructor(
    readonly kind: 'model-missing' | 'model-load' | 'inference',
    message: string,
  ) {
    super(message);
    this.name = 'HandTrackerError';
  }
}

export interface HandTrackerOptions {
  modelUrl: string;
  wasmBaseUrl: string;
  /** Target detection rate; adapted down automatically when inference is slow. */
  targetHz?: number;
  /** Run inference in a Web Worker (default). Falls back to the main thread if the worker fails. */
  useWorker?: boolean;
}

const WORKER_INIT_TIMEOUT_MS = 25_000;

/**
 * Runs MediaPipe Hand Landmarker locally.
 *
 * Preferred path: a Web Worker receives ImageBitmaps of the camera frames and returns landmarks,
 * so inference never blocks the water's render loop. Only one frame is in flight at a time,
 * and the detection rate adapts to how long inference takes.
 * Fallback path: the same model on the main thread, scheduled from video-frame callbacks.
 */
export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private worker: Worker | null = null;
  private loading: Promise<void> | null = null;
  private generation = 0;
  private lastTimestamp = 0;
  private lastDetect = 0;
  private consecutiveErrors = 0;
  private inFlight = false;
  private interval: number;
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private videoCallback: number | null = null;
  private onFrame: ((frame: HandFrame) => void) | null = null;
  private readonly frame: HandFrame & { hands: TrackedHand[] } = { hands: [], timestamp: 0, videoAspect: 4 / 3 };
  private readonly handPool: TrackedHand[] = [
    { landmarks: [], handedness: '', score: 0 },
    { landmarks: [], handedness: '', score: 0 },
  ];
  /** Exponential average of detection time in ms. */
  inferenceMs = 0;
  delegate: 'GPU' | 'CPU' | null = null;
  /** Where inference runs once loaded. */
  mode: 'worker' | 'main' | null = null;
  onError: ((err: HandTrackerError) => void) | null = null;

  constructor(private readonly options: HandTrackerOptions) {
    this.interval = 1000 / (options.targetHz ?? 30);
  }

  get ready(): boolean {
    return this.landmarker !== null || this.mode === 'worker';
  }

  get running(): boolean {
    return this.video !== null;
  }

  load(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (!this.loading) {
      this.loading = this.create().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  /** Begin detecting on `video`. Calling again replaces the previous loop (never duplicates it). */
  start(video: HTMLVideoElement, onFrame: (frame: HandFrame) => void): void {
    this.stop();
    if (!this.landmarker && !this.worker) throw new HandTrackerError('model-load', 'Hand tracker is not loaded.');
    if (this.landmarker) this.mode = 'main';
    const generation = ++this.generation;
    this.video = video;
    this.onFrame = onFrame;
    this.consecutiveErrors = 0;
    this.inFlight = false;

    const tick = () => {
      if (generation !== this.generation) return;
      const now = performance.now();
      if (!this.inFlight && now - this.lastDetect >= this.interval - 2) {
        this.lastDetect = now;
        if (this.mode === 'worker') this.sendToWorker(video, now, generation);
        else this.detectOnMainThread(video, now);
      }
      this.schedule(video, tick, generation);
    };
    this.schedule(video, tick, generation);
  }

  stop(): void {
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.videoCallback !== null && this.video && 'cancelVideoFrameCallback' in this.video) {
      this.video.cancelVideoFrameCallback(this.videoCallback);
    }
    this.videoCallback = null;
    this.video = null;
    this.onFrame = null;
    this.inFlight = false;
  }

  dispose(): void {
    this.stop();
    try {
      this.landmarker?.close();
    } catch {
      /* ignore */
    }
    this.landmarker = null;
    if (this.worker) {
      this.worker.postMessage({ type: 'close' } satisfies WorkerRequest);
      this.worker.terminate();
    }
    this.worker = null;
    this.mode = null;
  }

  // ------------------------------------------------------------------ scheduling

  private schedule(video: HTMLVideoElement, tick: () => void, generation: number): void {
    if (generation !== this.generation) return;
    if ('requestVideoFrameCallback' in video) {
      // Never leave two callbacks outstanding (the stall timer may tick first).
      if (this.videoCallback !== null) video.cancelVideoFrameCallback(this.videoCallback);
      this.videoCallback = video.requestVideoFrameCallback(() => {
        this.videoCallback = null;
        tick();
      });
      // Fallback timer in case the video stalls (e.g. tab throttled); keeps loss handling alive.
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (generation === this.generation && this.video === video) tick();
      }, 250);
    } else {
      this.timer = setTimeout(tick, Math.max(4, this.interval - (performance.now() - this.lastDetect)));
    }
  }

  private adapt(ms: number): void {
    this.inferenceMs = this.inferenceMs === 0 ? ms : this.inferenceMs * 0.9 + ms * 0.1;
    const target = 1000 / (this.options.targetHz ?? 30);
    // In the worker, one-frame-in-flight backpressure already limits the rate and the render
    // loop is unaffected. On the main thread inference steals frame time, so back off.
    if (this.mode === 'worker') {
      this.interval = target;
      return;
    }
    const m = this.inferenceMs;
    this.interval = m > 150 ? Math.max(target, 250) : m > 40 ? Math.max(target, 90) : m > 22 ? Math.max(target, 50) : target;
  }

  private emptyFrame(video: HTMLVideoElement, now: number): HandFrame & { hands: TrackedHand[] } {
    const frame = this.frame;
    frame.hands.length = 0;
    frame.timestamp = now;
    frame.videoAspect = video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 4 / 3;
    return frame;
  }

  private reportError(err: unknown): void {
    this.consecutiveErrors++;
    if (this.consecutiveErrors === 8) {
      this.onError?.(new HandTrackerError('inference', `Hand tracking failed repeatedly: ${(err as Error)?.message ?? err}`));
    }
  }

  // ------------------------------------------------------------------ worker path

  private sendToWorker(video: HTMLVideoElement, now: number, generation: number): void {
    const worker = this.worker;
    if (!worker || video.readyState < 2 || video.videoWidth === 0) {
      this.onFrame?.(this.emptyFrame(video, now));
      return;
    }
    this.inFlight = true;
    createImageBitmap(video)
      .then((bitmap) => {
        if (generation !== this.generation || this.worker !== worker) {
          bitmap.close();
          this.inFlight = false;
          return;
        }
        worker.postMessage({ type: 'frame', bitmap, timestamp: now } satisfies WorkerRequest, [bitmap]);
      })
      .catch((err) => {
        this.inFlight = false;
        this.reportError(err);
      });
  }

  private readonly onWorkerMessage = (e: MessageEvent<WorkerResponse>): void => {
    const msg = e.data;
    if (msg.type === 'result') {
      this.inFlight = false;
      const video = this.video;
      if (!video || !this.onFrame) return;
      if (msg.ms > 0) this.adapt(msg.ms);
      this.consecutiveErrors = 0;
      const frame = this.emptyFrame(video, msg.timestamp);
      for (let i = 0; i < msg.hands.length && i < 2; i++) {
        const hand = this.handPool[i];
        hand.landmarks = msg.hands[i].landmarks;
        hand.handedness = msg.hands[i].handedness;
        hand.score = msg.hands[i].score;
        frame.hands.push(hand);
      }
      this.onFrame(frame);
    } else if (msg.type === 'error' && msg.phase === 'inference') {
      this.reportError(new Error(msg.message));
    }
  };

  private initWorker(): Promise<void> {
    const worker = new Worker(new URL('./handWorker.ts', import.meta.url), { type: 'module', name: 'ripple-hands' });
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => fail(new Error('timed out')), WORKER_INIT_TIMEOUT_MS);
      const fail = (err: Error) => {
        clearTimeout(timeout);
        worker.terminate();
        reject(err);
      };
      worker.onerror = (e) => fail(new Error(e.message || 'worker error'));
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          clearTimeout(timeout);
          worker.onmessage = this.onWorkerMessage;
          worker.onerror = (ev) => this.reportError(new Error(ev.message));
          this.worker = worker;
          this.delegate = msg.delegate;
          this.mode = 'worker';
          resolve();
        } else if (msg.type === 'error') fail(new Error(msg.message));
      };
      worker.postMessage({
        type: 'init',
        modelUrl: absolute(this.options.modelUrl),
        wasmBaseUrl: absolute(this.options.wasmBaseUrl),
      } satisfies WorkerRequest);
    });
  }

  // ------------------------------------------------------------------ main-thread path

  private detectOnMainThread(video: HTMLVideoElement, now: number): void {
    const lm = this.landmarker;
    const frame = this.emptyFrame(video, now);
    if (!lm || video.readyState < 2 || video.videoWidth === 0) {
      this.onFrame?.(frame);
      return;
    }
    const ts = Math.max(this.lastTimestamp + 1, Math.round(now));
    this.lastTimestamp = ts;
    let result: HandLandmarkerResult;
    const t0 = performance.now();
    try {
      result = lm.detectForVideo(video, ts);
      this.consecutiveErrors = 0;
    } catch (err) {
      this.reportError(err);
      this.onFrame?.(frame);
      return;
    }
    this.adapt(performance.now() - t0);
    const handedness = result.handedness ?? result.handednesses ?? [];
    const count = Math.min(2, result.landmarks?.length ?? 0);
    for (let i = 0; i < count; i++) {
      const hand = this.handPool[i];
      const cat = handedness[i]?.[0];
      hand.landmarks = result.landmarks[i];
      hand.handedness = cat?.categoryName ?? `hand${i}`;
      hand.score = cat?.score ?? 0;
      frame.hands.push(hand);
    }
    this.onFrame?.(frame);
  }

  private async createMainThread(): Promise<void> {
    let vision: typeof import('@mediapipe/tasks-vision');
    try {
      vision = await import('@mediapipe/tasks-vision');
    } catch (err) {
      throw new HandTrackerError('model-load', `The MediaPipe library failed to load: ${(err as Error)?.message ?? err}`);
    }
    let fileset;
    try {
      fileset = await vision.FilesetResolver.forVisionTasks(this.options.wasmBaseUrl);
    } catch (err) {
      throw new HandTrackerError('model-load', `The MediaPipe WASM runtime failed to load from ${this.options.wasmBaseUrl}: ${(err as Error)?.message ?? err}`);
    }
    const make = (delegate: 'GPU' | 'CPU') =>
      vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: this.options.modelUrl, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.5,
      });
    try {
      this.landmarker = await make('GPU');
      this.delegate = 'GPU';
    } catch (gpuErr) {
      console.warn('[ripple] GPU hand tracking unavailable, using CPU.', gpuErr);
      try {
        this.landmarker = await make('CPU');
        this.delegate = 'CPU';
      } catch (err) {
        throw new HandTrackerError('model-load', `The hand tracking model failed to initialise: ${(err as Error)?.message ?? err}`);
      }
    }
    this.mode = 'main';
  }

  private async create(): Promise<void> {
    await assertModelAvailable(this.options.modelUrl);
    const canWorker = (this.options.useWorker ?? true) && typeof Worker !== 'undefined' && typeof createImageBitmap === 'function';
    if (canWorker) {
      try {
        await this.initWorker();
        return;
      } catch (err) {
        console.warn('[ripple] Hand tracking worker unavailable; running on the main thread instead.', err);
      }
    }
    await this.createMainThread();
  }
}

function absolute(url: string): string {
  return typeof location !== 'undefined' ? new URL(url, location.href).href : url;
}

async function assertModelAvailable(url: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  } catch (err) {
    throw new HandTrackerError('model-missing', `The hand tracking model could not be reached at ${url}: ${(err as Error)?.message ?? err}`);
  }
  // Dev servers answer unknown paths with index.html, so check the content type as well.
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || type.includes('text/html')) {
    throw new HandTrackerError('model-missing', 'The hand tracking model is missing. Run `npm run fetch-model` to download public/models/hand_landmarker.task, then reload.');
  }
}
