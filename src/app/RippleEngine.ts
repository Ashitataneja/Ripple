import * as THREE from 'three';
import { AudioController } from '../audio/AudioController';
import { CameraError, CameraManager } from '../camera/CameraManager';
import { CalibrationRecorder, CoordinateMapper, type CalibrationRect } from '../camera/CoordinateMapper';
import { GestureClassifier, type FingerCursor, type HandFrame } from '../camera/GestureClassifier';
import { HandTracker, HandTrackerError } from '../camera/HandTracker';
import { LM } from '../camera/landmarkFeatures';
import { DisturbanceQueue } from '../interaction/DisturbanceQueue';
import { InteractionController } from '../interaction/InteractionController';
import { PointerController } from '../interaction/PointerController';
import { initialQualityLevel, PerformanceMonitor, QUALITY_LEVELS } from '../performance/PerformanceMonitor';
import type { BoundaryMode } from '../water/simulationParams';
import { LOOKS, type LookName } from '../water/WaterMaterial';
import { WaterRenderer, type WaterCursor } from '../water/WaterRenderer';
import { WaterSimulation } from '../water/WaterSimulation';
import { createInteractionState, type InteractionState } from './interactionState';
import { Loop } from './Loop';

export type CameraStatus = 'off' | 'starting' | 'loading-model' | 'active' | 'error';

export interface EngineUiState {
  entered: boolean;
  camera: CameraStatus;
  cameraMessage: string | null;
  handsVisible: number;
  muted: boolean;
  hint: string | null;
  calibrating: boolean;
  fatal: string | null;
  stats: { fps: number; simulation: string; quality: number; inferenceMs: number; grid: string; tracker: string };
}

export interface EngineOptions {
  boundary?: BoundaryMode;
  forceCpuSimulation?: boolean;
  quality?: number;
  debug?: boolean;
  /** Colour preset: bright open water (default) or the moonlit pond. */
  look?: LookName;
}

const CALIBRATION_KEY = 'ripple.calibration.v1';
const CALIBRATION_SECONDS = 4;

interface HintStep {
  text: string;
  done: (s: InteractionState, base: InteractionState['counters'], handContacts: number) => boolean;
}

const POINTER_HINTS: HintStep[] = [
  { text: 'Touch the water.', done: (s, b) => s.counters.contacts > b.contacts },
  { text: 'Drag to make waves.', done: (s, b) => s.counters.wakes > b.wakes + 80 },
  { text: 'Press and hold, then let go to drop a pebble.', done: (s, b) => s.counters.pebbles > b.pebbles },
  { text: 'Flick quickly to push a wave.', done: (s, b) => s.counters.pushes > b.pushes },
];

const HAND_HINTS: HintStep[] = [
  { text: 'Dip your fingers.', done: (_s, _b, hands) => hands > 0 },
  { text: 'Pinch to pick up a pebble. Open to drop it.', done: (s, b) => s.counters.pebbles > b.pebbles },
  { text: 'Swipe an open hand to push a wave.', done: (s, b) => s.counters.pushes > b.pushes },
  { text: 'Bring both open hands together, then apart.', done: (s, b) => s.counters.compressions > b.compressions + 2 },
];

/**
 * Owns the whole experience outside React: renderer, simulation, interaction, camera, audio.
 * Construct once per mount; dispose() releases every GPU, media and audio resource.
 */
export class RippleEngine {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly sim: WaterSimulation;
  private readonly water: WaterRenderer;
  private readonly queue = new DisturbanceQueue(1024);
  private readonly state = createInteractionState();
  private readonly interaction: InteractionController;
  private readonly pointer: PointerController;
  private readonly audio = new AudioController();
  private readonly perf: PerformanceMonitor;
  private readonly loop: Loop;
  private readonly resizeObserver: ResizeObserver;
  private readonly listeners = new Set<(s: EngineUiState) => void>();
  private ui: EngineUiState;
  private time = 0;
  private disposed = false;
  private rect = { left: 0, top: 0, width: 1, height: 1 };

  // Camera pipeline (created lazily, only when the user asks for it).
  private camera: CameraManager | null = null;
  private tracker: HandTracker | null = null;
  private readonly mapper = new CoordinateMapper(true);
  private readonly classifier: GestureClassifier;
  private previewCanvas: HTMLCanvasElement | null = null;
  private calibration: CalibrationRecorder | null = null;
  private calibrationEnds = 0;
  private readonly fingerCursors: FingerCursor[] = Array.from({ length: 10 }, () => ({ x: 0, y: 0, inWater: false, pinching: false }));
  private readonly waterCursors: WaterCursor[] = Array.from({ length: 10 }, () => ({ x: 0, z: 0, radius: 0, intensity: 0 }));
  private readonly tmpPoint = { x: 0, y: 0, z: 0 };

  // Hints.
  private hintSteps: HintStep[] = POINTER_HINTS;
  private hintIndex = 0;
  private hintBase = { ...createInteractionState().counters };
  private hintVisibleAt = 0;
  private handContacts = 0;
  private statsTimer = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: EngineOptions = {},
  ) {
    if (!webgl2Available()) {
      throw new Error('This experience needs WebGL 2, which is not available in this browser or on this GPU.');
    }
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x05080b, 1);
    this.renderer.debug.checkShaderErrors = true;
    const shaderErrors: string[] = [];
    this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const log = gl.getProgramInfoLog(program) || gl.getShaderInfoLog(fs) || gl.getShaderInfoLog(vs) || 'unknown shader error';
      shaderErrors.push(log);
      console.error('[ripple] Shader compilation failed:', log);
    };
    const canvas = this.renderer.domElement;
    canvas.className = 'water-canvas';
    canvas.setAttribute('aria-label', 'Interactive water surface. Click, drag or touch to disturb the water.');
    canvas.setAttribute('role', 'img');
    container.appendChild(canvas);

    const level = options.quality ?? initialQualityLevel();
    this.perf = new PerformanceMonitor(level);
    this.perf.adaptive = options.quality === undefined;
    const quality = QUALITY_LEVELS[this.perf.level];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio));

    this.sim = new WaterSimulation(this.renderer, { resolution: quality.simResolution, boundary: options.boundary ?? 'absorb', forceCpu: options.forceCpuSimulation });
    // Simulation shader failures are handled by its CPU fallback; only later failures are fatal.
    const simShaderErrors = shaderErrors.length;
    this.water = new WaterRenderer(this.renderer, this.sim, LOOKS[options.look ?? 'day']);
    this.water.setMeshDivisor(quality.meshDivisor);
    this.water.particles.enabled = quality.particles;

    this.interaction = new InteractionController(this.state, this.queue, this.water, this.water.particles, {
      onContact: (source) => {
        if (source === 'hand') this.handContacts++;
        if (source === 'pointer') this.audio.touch();
      },
      onImpact: (s) => this.audio.impact(s),
      onPush: (s) => this.audio.swell(s),
      onCompress: (s) => this.audio.squeeze(s),
      onWakeSpeed: (s) => this.audio.dragSpeed(s),
      onDroplet: (s) => this.audio.droplet(s),
    });
    this.water.particles.onSurface = (x, z, size) => this.interaction.dropletLanded(x, z, size);
    this.interaction.setReducedMotion(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

    this.classifier = new GestureClassifier(this.interaction, this.mapper, () => this.rect.width / Math.max(1, this.rect.height));
    this.loadCalibration();

    this.pointer = new PointerController(this.interaction, () => this.rect);
    this.pointer.attach(canvas);

    this.perf.onChange = (_lvl, q) => {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
      this.sim.setResolution(q.simResolution);
      this.water.setMeshDivisor(q.meshDivisor);
      this.water.rebuildSurface();
      this.water.particles.enabled = q.particles;
      this.resize();
    };

    this.ui = {
      entered: false,
      camera: 'off',
      cameraMessage: null,
      handsVisible: 0,
      muted: false,
      hint: null,
      calibrating: false,
      fatal: null,
      stats: { fps: 60, simulation: this.sim.kind, quality: this.perf.level, inferenceMs: 0, grid: '', tracker: '' },
    };

    canvas.addEventListener('webglcontextlost', this.onContextLost);
    window.addEventListener('keydown', this.onKey);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.loop = new Loop((dt, now) => this.frame(dt, now));

    // Compile everything now so shader problems surface immediately instead of mid-session.
    this.water.update(0, 0, this.state, this.waterCursors, 0);
    this.renderer.compile(this.water.scene, this.water.camera);
    this.water.render();
    if (shaderErrors.length > simShaderErrors) {
      const message = `The water shader could not be compiled on this GPU. ${shaderErrors[simShaderErrors]}`;
      this.dispose();
      throw new Error(message);
    }
    this.loop.start();
  }

  // ------------------------------------------------------------------ public API

  subscribe(listener: (s: EngineUiState) => void): () => void {
    this.listeners.add(listener);
    listener(this.ui);
    return () => this.listeners.delete(listener);
  }

  get uiState(): EngineUiState {
    return this.ui;
  }

  get cameraVideo(): HTMLVideoElement | null {
    return this.camera?.video ?? null;
  }

  get mirrored(): boolean {
    return this.mapper.mirror;
  }

  /** The user chose to enter: unlock audio (we are inside a user gesture) and start hints. */
  enter(): void {
    if (this.ui.entered) return;
    void this.audio.init();
    this.audio.setMuted(this.ui.muted);
    this.hintVisibleAt = performance.now() + 1400;
    this.setHintMode(POINTER_HINTS);
    this.patch({ entered: true });
  }

  setMuted(muted: boolean): void {
    this.audio.setMuted(muted);
    this.patch({ muted });
  }

  resetWater(): void {
    this.interaction.reset();
    this.pointer.cancelAll();
    this.classifier.releaseAll();
    this.sim.reset();
    this.water.particles.clear();
  }

  /** Drop a pebble in the middle of the pond (keyboard access). */
  dropPebbleAtCentre(): void {
    const owner = 9_000_000;
    const x = 0.35 + Math.random() * 0.3;
    const y = 0.35 + Math.random() * 0.3;
    this.interaction.pebbleGrab(owner, x, y);
    setTimeout(() => this.interaction.pebbleRelease(owner, x, y, 0, 0), 350);
  }

  async enableCamera(): Promise<void> {
    if (this.disposed || this.ui.camera === 'starting' || this.ui.camera === 'loading-model' || this.ui.camera === 'active') return;
    void this.audio.init();
    if (!this.camera) {
      this.camera = new CameraManager();
      this.camera.onDisconnect = () => this.disableCamera('The camera was disconnected.');
    }
    if (!this.tracker) {
      const base = import.meta.env.BASE_URL;
      this.tracker = new HandTracker({ modelUrl: `${base}models/hand_landmarker.task`, wasmBaseUrl: `${base}mediapipe/wasm`, targetHz: 30 });
      this.tracker.onError = (err) => this.disableCamera(err.message);
    }
    this.patch({ camera: 'starting', cameraMessage: null });
    const modelPromise = this.tracker.load();
    modelPromise.catch(() => undefined); // handled below; avoid unhandled-rejection noise
    try {
      const video = await this.camera.start();
      if (this.disposed) return;
      this.patch({ camera: 'loading-model' });
      await modelPromise;
      if (this.disposed || !this.camera.active) return;
      this.tracker.start(video, this.onHandFrame);
      this.setHintMode(HAND_HINTS);
      this.patch({ camera: 'active', cameraMessage: null });
    } catch (err) {
      const message = err instanceof CameraError || err instanceof HandTrackerError ? err.message : `Hand tracking could not start: ${(err as Error)?.message ?? err}`;
      this.disableCamera(message);
    }
  }

  /** Stops tracking and every media track. Waves already in the water continue naturally. */
  disableCamera(errorMessage: string | null = null): void {
    this.tracker?.stop();
    this.classifier.releaseAll();
    this.camera?.stop();
    this.calibration = null;
    if (this.hintSteps === HAND_HINTS) this.setHintMode(POINTER_HINTS);
    this.clearPreview();
    this.patch({ camera: errorMessage ? 'error' : 'off', cameraMessage: errorMessage, handsVisible: 0, calibrating: false });
  }

  /** Record the user's comfortable reach for a few seconds and map it to the full screen. */
  startCalibration(): void {
    if (this.ui.camera !== 'active') return;
    this.calibration = new CalibrationRecorder();
    this.calibrationEnds = performance.now() + CALIBRATION_SECONDS * 1000;
    this.patch({ calibrating: true, hint: 'Move one hand slowly to the edges of your comfortable reach…' });
  }

  setPreviewCanvas(canvas: HTMLCanvasElement | null): void {
    this.previewCanvas = canvas;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loop.stop();
    this.resizeObserver.disconnect();
    window.removeEventListener('keydown', this.onKey);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.pointer.detach();
    this.tracker?.dispose();
    this.camera?.stop();
    this.audio.dispose();
    this.water.dispose();
    this.sim.dispose();
    this.renderer.dispose();
    // Release the WebGL context itself; browsers only allow a handful at once.
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.listeners.clear();
  }

  // ------------------------------------------------------------------ frame loop

  private frame(dt: number, now: number): void {
    this.time += dt;
    this.perf.sample(dt);
    this.interaction.update(dt, now);
    this.sim.update(dt, this.queue);
    const cursorCount = this.updateCursors();
    this.water.update(this.time, dt, this.state, this.waterCursors, cursorCount);
    this.water.render();
    this.updateHints(now);
    this.updateCalibration(now);

    this.statsTimer += dt;
    if (this.statsTimer > 0.5) {
      this.statsTimer = 0;
      const handsVisible = this.ui.camera === 'active' ? this.classifier.handsPresent : 0;
      const stats = {
        fps: Math.round(this.perf.fps),
        simulation: this.sim.kind,
        quality: this.perf.level,
        inferenceMs: Math.round((this.tracker?.inferenceMs ?? 0) * 10) / 10,
        grid: `${this.sim.gridWidth}×${this.sim.gridHeight}`,
        tracker: this.tracker?.mode ? `${this.tracker.mode}/${this.tracker.delegate ?? '?'}` : '',
      };
      if (this.options.debug || handsVisible !== this.ui.handsVisible) this.patch({ handsVisible, stats });
    }
  }

  private readonly onHandFrame = (frame: HandFrame): void => {
    this.classifier.process(frame);
    if (this.calibration) {
      for (const h of frame.hands) {
        const tip = h.landmarks[LM.indexTip];
        if (tip) this.calibration.add(this.mapper.viewX(tip.x), tip.y);
      }
    }
    this.drawPreview(frame);
  };

  private updateCursors(): number {
    if (this.ui.camera !== 'active') return 0;
    const n = this.classifier.cursors(this.fingerCursors);
    let count = 0;
    for (let i = 0; i < n; i++) {
      const f = this.fingerCursors[i];
      if (!this.water.screenToWorld(f.x, f.y, this.tmpPoint)) continue;
      const c = this.waterCursors[count++];
      c.x = this.tmpPoint.x;
      c.z = this.tmpPoint.z;
      c.radius = f.pinching ? 0.045 : f.inWater ? 0.022 : 0.03;
      c.intensity = f.pinching ? 1.2 : f.inWater ? 1 : 0.45;
    }
    return count;
  }

  private updateHints(now: number): void {
    if (!this.ui.entered || this.ui.calibrating) return;
    const step = this.hintSteps[this.hintIndex];
    if (!step) {
      if (this.ui.hint !== null) this.patch({ hint: null });
      return;
    }
    if (step.done(this.state, this.hintBase, this.handContacts)) {
      this.hintIndex++;
      this.hintBase = { ...this.state.counters };
      this.handContacts = 0;
      this.hintVisibleAt = now + 2600;
      if (this.ui.hint !== null) this.patch({ hint: null });
      return;
    }
    if (now >= this.hintVisibleAt && this.ui.hint !== step.text) this.patch({ hint: step.text });
  }

  private setHintMode(steps: HintStep[]): void {
    this.hintSteps = steps;
    this.hintIndex = 0;
    this.hintBase = { ...this.state.counters };
    this.handContacts = 0;
    this.hintVisibleAt = performance.now() + 1200;
    if (this.ui?.hint) this.patch({ hint: null });
  }

  private updateCalibration(now: number): void {
    if (!this.calibration || now < this.calibrationEnds) return;
    const rect = this.calibration.result();
    this.calibration = null;
    if (rect) {
      this.mapper.setCalibration(rect);
      this.saveCalibration(rect);
    }
    this.patch({ calibrating: false, hint: rect ? 'Calibrated.' : 'Calibration needs more movement — try again.' });
    this.hintVisibleAt = now + 2200;
    setTimeout(() => {
      if (this.ui.hint === 'Calibrated.' || this.ui.hint?.startsWith('Calibration')) this.patch({ hint: null });
    }, 1800);
  }

  // ------------------------------------------------------------------ preview

  private drawPreview(frame: HandFrame): void {
    const canvas = this.previewCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // Calibrated region.
    const r = this.mapper.calibration;
    ctx.strokeStyle = 'rgba(160, 190, 210, 0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(r.x0 * w, r.y0 * h, (r.x1 - r.x0) * w, (r.y1 - r.y0) * h);
    ctx.setLineDash([]);
    for (const hand of frame.hands) {
      ctx.fillStyle = 'rgba(200, 225, 240, 0.85)';
      for (let i = 0; i < hand.landmarks.length; i++) {
        const p = hand.landmarks[i];
        const tip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20;
        ctx.beginPath();
        ctx.arc(this.mapper.viewX(p.x) * w, p.y * h, tip ? 2.6 : 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private clearPreview(): void {
    const c = this.previewCanvas;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
  }

  // ------------------------------------------------------------------ plumbing

  private resize(): void {
    if (this.disposed) return;
    const r = this.container.getBoundingClientRect();
    this.rect = { left: r.left, top: r.top, width: Math.max(1, r.width), height: Math.max(1, r.height) };
    this.renderer.setSize(this.rect.width, this.rect.height, false);
    this.water.setSize(this.rect.width, this.rect.height);
  }

  private patch(p: Partial<EngineUiState>): void {
    this.ui = { ...this.ui, ...p };
    for (const l of this.listeners) l(this.ui);
  }

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.loop.stop();
    this.patch({ fatal: 'The graphics context was lost (the GPU was reset or is under pressure). Reload the page to bring the water back.' });
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.ui.entered || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    switch (e.key.toLowerCase()) {
      case ' ':
        if (target?.tagName === 'BUTTON') return;
        e.preventDefault();
        this.dropPebbleAtCentre();
        break;
      case 'r':
        this.resetWater();
        break;
      case 'm':
        this.setMuted(!this.ui.muted);
        break;
      case 'c':
        if (this.ui.camera === 'active') this.disableCamera();
        else void this.enableCamera();
        break;
    }
  };

  private loadCalibration(): void {
    try {
      const raw = localStorage.getItem(CALIBRATION_KEY);
      if (!raw) return;
      const r = JSON.parse(raw) as CalibrationRect;
      if ([r.x0, r.y0, r.x1, r.y1].every((v) => typeof v === 'number' && v >= 0 && v <= 1)) this.mapper.setCalibration(r);
    } catch {
      /* storage unavailable: use defaults */
    }
  }

  private saveCalibration(rect: CalibrationRect): void {
    try {
      localStorage.setItem(CALIBRATION_KEY, JSON.stringify(rect));
    } catch {
      /* storage unavailable */
    }
  }
}

function webgl2Available(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}
