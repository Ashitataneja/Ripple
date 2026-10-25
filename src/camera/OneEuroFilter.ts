/**
 * One Euro filter (Casiez et al. 2012): time-based low-pass whose cutoff rises with speed,
 * removing landmark jitter at rest without adding lag to fast movement.
 */
export class OneEuroFilter {
  private x = 0;
  private dx = 0;
  private t = 0;
  private initialised = false;

  constructor(
    private readonly minCutoff = 1.4,
    private readonly beta = 0.6,
    private readonly dCutoff = 1.0,
  ) {}

  filter(value: number, t: number): number {
    if (!this.initialised || !Number.isFinite(this.x)) {
      this.x = value;
      this.dx = 0;
      this.t = t;
      this.initialised = true;
      return value;
    }
    const dt = t - this.t;
    if (dt <= 0) return this.x;
    this.t = t;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(dt, this.dCutoff) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(dt, cutoff) * (value - this.x);
    return this.x;
  }

  reset(): void {
    this.initialised = false;
  }

  get value(): number {
    return this.x;
  }
}

function alpha(dt: number, cutoff: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class PointFilter {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;
  x = 0;
  y = 0;

  constructor(minCutoff = 1.4, beta = 0.6) {
    this.fx = new OneEuroFilter(minCutoff, beta);
    this.fy = new OneEuroFilter(minCutoff, beta);
  }

  filter(x: number, y: number, t: number): void {
    this.x = this.fx.filter(x, t);
    this.y = this.fy.filter(y, t);
  }

  reset(x?: number, y?: number, t?: number): void {
    this.fx.reset();
    this.fy.reset();
    if (x !== undefined && y !== undefined && t !== undefined) this.filter(x, y, t);
  }
}
