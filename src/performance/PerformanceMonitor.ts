/** Quality levels, best first. The monitor steps down when frames are slow and cautiously back up. */
export interface QualityLevel {
  simResolution: number;
  pixelRatio: number;
  /** Surface mesh has one vertex per `meshDivisor` simulation texels. */
  meshDivisor: number;
  particles: boolean;
}

export const QUALITY_LEVELS: readonly QualityLevel[] = [
  { simResolution: 512, pixelRatio: 1.75, meshDivisor: 2, particles: true },
  { simResolution: 384, pixelRatio: 1.5, meshDivisor: 2, particles: true },
  { simResolution: 320, pixelRatio: 1.0, meshDivisor: 3, particles: true },
  { simResolution: 224, pixelRatio: 0.75, meshDivisor: 3, particles: false },
];

export interface PerformanceOptions {
  slowMs: number;
  fastMs: number;
  downgradeAfter: number;
  upgradeAfter: number;
  settleTime: number;
  maxUpgrades: number;
}

const DEFAULTS: PerformanceOptions = {
  slowMs: 21,
  fastMs: 12.5,
  downgradeAfter: 2.5,
  upgradeAfter: 10,
  settleTime: 2,
  maxUpgrades: 2,
};

/**
 * Measures frame time and adapts quality. Time-based hysteresis prevents oscillation:
 * a level change waits for a settle period, and upgrades are limited in number.
 */
export class PerformanceMonitor {
  frameMs = 16.7;
  fps = 60;
  level: number;
  /** When false the level is pinned (e.g. chosen explicitly with ?quality=). */
  adaptive = true;
  private slowFor = 0;
  private fastFor = 0;
  private settle: number;
  private upgrades = 0;
  private readonly options: PerformanceOptions;
  onChange: ((level: number, quality: QualityLevel) => void) | null = null;

  constructor(initialLevel = 0, options: Partial<PerformanceOptions> = {}) {
    this.level = clampLevel(initialLevel);
    this.options = { ...DEFAULTS, ...options };
    this.settle = this.options.settleTime;
  }

  get quality(): QualityLevel {
    return QUALITY_LEVELS[this.level];
  }

  /** Feed one frame's duration in seconds. */
  sample(dt: number): void {
    if (!(dt > 0) || dt > 0.25) return; // hidden tab, breakpoint, etc.
    const ms = dt * 1000;
    this.frameMs += (ms - this.frameMs) * 0.05;
    this.fps = 1000 / this.frameMs;
    if (!this.adaptive) return;
    if (this.settle > 0) {
      this.settle -= dt;
      return;
    }
    const o = this.options;
    this.slowFor = this.frameMs > o.slowMs ? this.slowFor + dt : 0;
    this.fastFor = this.frameMs < o.fastMs ? this.fastFor + dt : 0;
    if (this.slowFor > o.downgradeAfter && this.level < QUALITY_LEVELS.length - 1) this.setLevel(this.level + 1);
    else if (this.fastFor > o.upgradeAfter && this.level > 0 && this.upgrades < o.maxUpgrades) {
      this.upgrades++;
      this.setLevel(this.level - 1);
    }
  }

  setLevel(level: number): void {
    const next = clampLevel(level);
    this.slowFor = 0;
    this.fastFor = 0;
    this.settle = this.options.settleTime;
    if (next === this.level) return;
    this.level = next;
    this.frameMs = 16.7;
    this.onChange?.(next, QUALITY_LEVELS[next]);
  }
}

/** A conservative first guess before any frames are measured. */
export function initialQualityLevel(): number {
  if (typeof navigator === 'undefined') return 0;
  const cores = navigator.hardwareConcurrency ?? 8;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (mobile) return 2;
  if (cores <= 4) return 1;
  return 0;
}

function clampLevel(level: number): number {
  return Math.max(0, Math.min(QUALITY_LEVELS.length - 1, Math.round(level)));
}
