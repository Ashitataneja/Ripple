/**
 * Small, deterministic gesture detectors shared by pointer and hand input.
 * All speeds are in screen-heights per second; times in seconds.
 */

export interface SwipeResult {
  fired: boolean;
  dirX: number;
  dirY: number;
  speed: number;
}

export interface SwipeOptions {
  minSpeed: number;
  cooldown: number;
  /** Require |vx| ≥ dominance·|vy| (sideways swipes). 0 accepts any direction. */
  dominance: number;
}

/** Detects a quick swipe once per stroke: velocity threshold, re-arming and a cooldown. */
export class SwipeDetector {
  private lastFire = -Infinity;
  private armed = true;
  readonly result: SwipeResult = { fired: false, dirX: 0, dirY: 0, speed: 0 };

  constructor(private readonly options: SwipeOptions) {}

  update(vx: number, vy: number, t: number, enabled: boolean): SwipeResult {
    const r = this.result;
    r.fired = false;
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) return r;
    const speed = Math.hypot(vx, vy);
    if (speed < this.options.minSpeed * 0.45) this.armed = true;
    if (!enabled || !this.armed || speed < this.options.minSpeed) return r;
    if (t - this.lastFire < this.options.cooldown) return r;
    if (this.options.dominance > 0 && Math.abs(vx) < this.options.dominance * Math.abs(vy)) return r;
    this.lastFire = t;
    this.armed = false;
    r.fired = true;
    r.dirX = vx / speed;
    r.dirY = vy / speed;
    r.speed = speed;
    return r;
  }

  reset(): void {
    this.armed = true;
  }
}

export interface CompressionOptions {
  /** Minimum |d(distance)/dt| to count as squeezing or releasing. */
  minRate: number;
  /** Seconds between emitted compression pulses. */
  interval: number;
}

/** Tracks the distance between two points and emits pulses while it changes quickly. */
export class CompressionDetector {
  private distance = -1;
  private rate = 0;
  private lastT = 0;
  private lastEmit = -Infinity;

  constructor(private readonly options: CompressionOptions) {}

  /** Positions in screen-height units. Returns the signed rate when a pulse should fire, else 0. */
  update(x1: number, y1: number, x2: number, y2: number, t: number): number {
    const d = Math.hypot(x2 - x1, y2 - y1);
    if (!Number.isFinite(d)) return 0;
    if (this.distance < 0) {
      this.distance = d;
      this.lastT = t;
      this.rate = 0;
      return 0;
    }
    const dt = t - this.lastT;
    if (dt <= 1e-4) return 0;
    const inst = (d - this.distance) / dt;
    this.rate += (inst - this.rate) * Math.min(1, dt * 10);
    this.distance = d;
    this.lastT = t;
    if (Math.abs(this.rate) < this.options.minRate) return 0;
    if (t - this.lastEmit < this.options.interval) return 0;
    this.lastEmit = t;
    return this.rate;
  }

  get currentRate(): number {
    return this.rate;
  }

  reset(): void {
    this.distance = -1;
    this.rate = 0;
  }
}
