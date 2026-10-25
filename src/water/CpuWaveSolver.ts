import { evaluateDisturbance, type Disturbance, type SplatDelta } from './disturbance';
import { SIM, stepCoefficients, type BoundaryMode, type StepCoefficients } from './simulationParams';

/**
 * Pure TypeScript damped wave-equation solver on a height field.
 * Used as the fallback backend when float render targets are unavailable, and as the
 * reference implementation in unit tests. Mirrors shaders/waveStep.frag.glsl.
 */
export class CpuWaveSolver {
  width = 0;
  height = 0;
  /** Domain size in world units (used to place disturbances). */
  worldWidth = 1;
  worldHeight = 1;
  current: Float32Array = new Float32Array(0);
  previous: Float32Array = new Float32Array(0);
  private next: Float32Array = new Float32Array(0);
  private sponge: Float32Array = new Float32Array(0);
  private coeff: StepCoefficients;
  private boundary: BoundaryMode;
  private readonly delta: SplatDelta = { current: 0, previous: 0 };

  constructor(width: number, height: number, worldWidth: number, worldHeight: number, boundary: BoundaryMode = 'absorb', referenceResolution = Math.max(width, height)) {
    this.boundary = boundary;
    this.coeff = stepCoefficients(referenceResolution);
    this.resize(width, height, worldWidth, worldHeight);
  }

  resize(width: number, height: number, worldWidth: number, worldHeight: number): void {
    const w = Math.max(4, Math.floor(width));
    const h = Math.max(4, Math.floor(height));
    if (w !== this.width || h !== this.height) {
      const oldW = this.width;
      const oldH = this.height;
      const oldCur = this.current;
      const oldPrev = this.previous;
      this.width = w;
      this.height = h;
      this.current = new Float32Array(w * h);
      this.previous = new Float32Array(w * h);
      this.next = new Float32Array(w * h);
      if (oldW > 0 && oldH > 0) {
        resample(oldCur, oldW, oldH, this.current, w, h);
        resample(oldPrev, oldW, oldH, this.previous, w, h);
      }
      this.coeff = stepCoefficients(Math.max(w, h));
      this.buildSponge();
    }
    this.worldWidth = worldWidth;
    this.worldHeight = worldHeight;
  }

  setBoundary(mode: BoundaryMode): void {
    this.boundary = mode;
    this.buildSponge();
  }

  get travelShift(): number {
    return Math.sqrt(this.coeff.c2) * (this.worldHeight / this.height);
  }

  reset(): void {
    this.current.fill(0);
    this.previous.fill(0);
    this.next.fill(0);
  }

  apply(list: readonly Disturbance[], count: number): void {
    const { width: w, height: h, current, previous, delta } = this;
    const shift = this.travelShift;
    const max = SIM.maxHeight;
    for (let k = 0; k < count; k++) {
      const d = list[k];
      // Bounding box of the disturbance footprint (4 radii, wider for pushes).
      const reach = d.radius * (d.kind === 2 ? 9 : 4);
      const x0 = Math.max(0, Math.floor((d.x - reach / this.worldWidth) * w));
      const x1 = Math.min(w - 1, Math.ceil((d.x + reach / this.worldWidth) * w));
      const y0 = Math.max(0, Math.floor((d.y - reach / this.worldHeight) * h));
      const y1 = Math.min(h - 1, Math.ceil((d.y + reach / this.worldHeight) * h));
      for (let y = y0; y <= y1; y++) {
        const v = (y + 0.5) / h;
        const dy = (v - d.y) * this.worldHeight;
        for (let x = x0; x <= x1; x++) {
          const u = (x + 0.5) / w;
          const dx = (u - d.x) * this.worldWidth;
          evaluateDisturbance(d, dx, dy, shift, delta);
          if (delta.current === 0 && delta.previous === 0) continue;
          const i = y * w + x;
          current[i] = clamp(current[i] + delta.current, -max, max);
          previous[i] = clamp(previous[i] + delta.previous, -max, max);
        }
      }
    }
  }

  step(): void {
    const { width: w, height: h, current: c, previous: p, next: n, sponge } = this;
    const { c2, damping, viscosity, restoring } = this.coeff;
    const max = SIM.maxHeight;
    for (let y = 0; y < h; y++) {
      const ym = (y > 0 ? y - 1 : 0) * w;
      const yp = (y < h - 1 ? y + 1 : h - 1) * w;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const xm = x > 0 ? x - 1 : 0;
        const xp = x < w - 1 ? x + 1 : w - 1;
        const i = row + x;
        const cc = c[i];
        const pc = p[i];
        const lapC = c[row + xm] + c[row + xp] + c[ym + x] + c[yp + x] - 4 * cc;
        const lapP = p[row + xm] + p[row + xp] + p[ym + x] + p[yp + x] - 4 * pc;
        const damp = damping + sponge[i];
        let next = cc + (cc - pc) * (1 - damp) + c2 * lapC + viscosity * (lapC - lapP);
        next *= 1 - restoring;
        n[i] = next > max ? max : next < -max ? -max : next;
      }
    }
    // Rotate buffers: previous <- current, current <- next.
    this.previous = c;
    this.current = n;
    this.next = p;
  }

  /** Sum of squared heights and velocities: a convenient energy proxy for tests. */
  energy(): number {
    let e = 0;
    const { current: c, previous: p } = this;
    for (let i = 0; i < c.length; i++) {
      const v = c[i] - p[i];
      e += c[i] * c[i] + v * v;
    }
    return e;
  }

  sample(u: number, v: number): number {
    const x = clampInt(Math.floor(u * this.width), 0, this.width - 1);
    const y = clampInt(Math.floor(v * this.height), 0, this.height - 1);
    return this.current[y * this.width + x];
  }

  private buildSponge(): void {
    const { width: w, height: h } = this;
    this.sponge = new Float32Array(w * h);
    if (this.boundary !== 'absorb') return;
    const widthTexels = Math.max(2, SIM.spongeWidth * Math.min(w, h));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const edge = Math.min(x, w - 1 - x, y, h - 1 - y);
        const t = 1 - Math.min(1, edge / widthTexels);
        this.sponge[y * w + x] = SIM.spongeStrength * t * t;
      }
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function resample(src: Float32Array, sw: number, sh: number, dst: Float32Array, dw: number, dh: number): void {
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) / dh) * sh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) / dw) * sw));
      dst[y * dw + x] = src[sy * sw + sx];
    }
  }
}
