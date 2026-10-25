import { describe, expect, it } from 'vitest';
import { DisturbanceQueue } from '../interaction/DisturbanceQueue';
import { CpuWaveSolver } from '../water/CpuWaveSolver';
import { DisturbanceKind, evaluateDisturbance, type Disturbance } from '../water/disturbance';
import { gridSizeFor, SIM, stepCoefficients } from '../water/simulationParams';

function solver(boundary: 'absorb' | 'reflect' = 'absorb') {
  // 128 × 128 grid covering a 1 × 1 world square.
  return new CpuWaveSolver(128, 128, 1, 1, boundary);
}

function drop(queue: DisturbanceQueue, x: number, y: number, strength = 0.5, radius = 0.03, kind: DisturbanceKind = DisturbanceKind.Drop, dirX = 1, dirY = 0) {
  return queue.push(kind, x, y, radius, strength, dirX, dirY);
}

function run(s: CpuWaveSolver, steps: number) {
  for (let i = 0; i < steps; i++) s.step();
}

/** Mean |h| in an annulus around (cx, cy). */
function ringEnergy(s: CpuWaveSolver, cx: number, cy: number, r0: number, r1: number) {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const d = Math.hypot((x + 0.5) / s.width - cx, (y + 0.5) / s.height - cy);
      if (d >= r0 && d < r1) {
        sum += Math.abs(s.current[y * s.width + x]);
        n++;
      }
    }
  }
  return sum / Math.max(1, n);
}

describe('wave simulation', () => {
  it('keeps the Courant number inside the stable range', () => {
    expect(SIM.waveSpeedSquared).toBeLessThan(0.5);
    for (const res of [128, 256, 512, 1024]) {
      const c = stepCoefficients(res);
      expect(c.damping).toBeGreaterThan(0);
      expect(c.damping).toBeLessThan(0.2);
    }
  });

  it('propagates a ripple outwards from a drop', () => {
    const s = solver();
    const q = new DisturbanceQueue();
    drop(q, 0.5, 0.5);
    s.apply(q.items, q.count);
    const farBefore = ringEnergy(s, 0.5, 0.5, 0.2, 0.26);
    expect(farBefore).toBeLessThan(1e-6);
    run(s, 50);
    const centre = ringEnergy(s, 0.5, 0.5, 0, 0.04);
    const far = ringEnergy(s, 0.5, 0.5, 0.2, 0.3);
    expect(far).toBeGreaterThan(1e-3);
    // The energy has moved away from the centre into the expanding ring.
    expect(far).toBeGreaterThan(centre * 0.5);
  });

  it('damps back to stillness without being reset', () => {
    const s = solver();
    const q = new DisturbanceQueue();
    drop(q, 0.4, 0.6, 0.8);
    s.apply(q.items, q.count);
    run(s, 2);
    const e0 = s.energy();
    run(s, 300);
    const e1 = s.energy();
    run(s, 3000);
    const e2 = s.energy();
    expect(e1).toBeLessThan(e0);
    expect(e2).toBeLessThan(e0 * 1e-4);
    // Strictly settling, never oscillating forever.
    expect(Math.max(...Array.from(s.current, Math.abs))).toBeLessThan(1e-3);
  });

  it('superposes overlapping disturbances (interference)', () => {
    const a = solver();
    const b = solver();
    const ab = solver();
    const qa = new DisturbanceQueue();
    const qb = new DisturbanceQueue();
    drop(qa, 0.42, 0.5, 0.2);
    drop(qb, 0.58, 0.5, 0.2);
    a.apply(qa.items, qa.count);
    b.apply(qb.items, qb.count);
    ab.apply(qa.items, qa.count);
    ab.apply(qb.items, qb.count);
    run(a, 40);
    run(b, 40);
    run(ab, 40);
    let maxErr = 0;
    let maxVal = 0;
    for (let i = 0; i < ab.current.length; i++) {
      maxErr = Math.max(maxErr, Math.abs(ab.current[i] - (a.current[i] + b.current[i])));
      maxVal = Math.max(maxVal, Math.abs(ab.current[i]));
    }
    // Linear regime: the combined field is the sum of the individual fields.
    expect(maxErr).toBeLessThan(1e-4);
    expect(maxVal).toBeGreaterThan(0.005);
    // Between the sources the two rings meet and reinforce.
    const mid = ab.sample(0.5, 0.5);
    expect(Math.abs(mid)).toBeGreaterThan(Math.abs(a.sample(0.5, 0.5)) * 1.5);
  });

  it('supports many simultaneous fingertip sources, each producing its own ring', () => {
    const s = solver();
    const q = new DisturbanceQueue();
    const tips = [
      [0.3, 0.3],
      [0.7, 0.3],
      [0.3, 0.7],
      [0.7, 0.7],
      [0.5, 0.5],
    ];
    for (const [x, y] of tips) drop(q, x, y, -0.3, 0.02);
    s.apply(q.items, q.count);
    for (const [x, y] of tips) expect(s.sample(x, y)).toBeLessThan(-0.2);
    run(s, 25);
    for (const [x, y] of tips) expect(ringEnergy(s, x, y, 0.06, 0.12)).toBeGreaterThan(1e-3);
  });

  it('stays bounded under a storm of impulses', () => {
    const s = solver();
    const q = new DisturbanceQueue(2048);
    for (let i = 0; i < 1500; i++) drop(q, 0.5 + 0.01 * Math.sin(i), 0.5, 1.5, 0.02, DisturbanceKind.Impact);
    s.apply(q.items, q.count);
    run(s, 500);
    for (const v of s.current) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(SIM.maxHeight);
    }
  });

  it('absorbs waves at the edges in absorb mode and reflects them in reflect mode', () => {
    const absorb = solver('absorb');
    const reflect = solver('reflect');
    const q = new DisturbanceQueue();
    drop(q, 0.85, 0.5, 0.6, 0.03);
    absorb.apply(q.items, q.count);
    reflect.apply(q.items, q.count);
    run(absorb, 160);
    run(reflect, 160);
    expect(absorb.energy()).toBeLessThan(reflect.energy() * 0.8);
  });

  it('launches a push wave in its direction of travel', () => {
    const s = solver('reflect');
    const q = new DisturbanceQueue();
    drop(q, 0.5, 0.5, 0.5, 0.05, DisturbanceKind.Push, 1, 0);
    s.apply(q.items, q.count);
    run(s, 60);
    let ahead = 0;
    let behind = 0;
    for (let y = 40; y < 88; y++) {
      for (let x = 0; x < 128; x++) {
        const v = Math.abs(s.current[y * 128 + x]);
        if (x > 74) ahead += v;
        if (x < 54) behind += v;
      }
    }
    expect(ahead).toBeGreaterThan(behind * 2);
  });

  it('keeps existing waves when the grid is resized', () => {
    const s = solver();
    const q = new DisturbanceQueue();
    drop(q, 0.5, 0.5, 0.5, 0.06);
    s.apply(q.items, q.count);
    const before = s.sample(0.5, 0.5);
    s.resize(64, 64, 1, 1);
    expect(s.sample(0.5, 0.5)).toBeCloseTo(before, 1);
  });

  it('evaluates disturbance shapes as documented', () => {
    const out = { current: 0, previous: 0 };
    const base: Disturbance = { id: 1, x: 0, y: 0, radius: 0.1, strength: 1, dirX: 1, dirY: 0, kind: DisturbanceKind.Drop, velocity: 0 };
    evaluateDisturbance(base, 0, 0, 0.001, out);
    expect(out.current).toBeCloseTo(1);
    expect(out.previous).toBeCloseTo(1);
    evaluateDisturbance({ ...base, kind: DisturbanceKind.Impact }, 0, 0, 0.001, out);
    expect(out.current).toBeLessThan(-0.5); // crater
    expect(out.previous).toBe(0); // with downward velocity
    evaluateDisturbance({ ...base, kind: DisturbanceKind.Wake }, 0.05, 0, 0.001, out);
    const front = out.current;
    evaluateDisturbance({ ...base, kind: DisturbanceKind.Wake }, -0.05, 0, 0.001, out);
    expect(front).toBeGreaterThan(out.current); // bow ahead, trough behind
    evaluateDisturbance(base, 1, 1, 0.001, out);
    expect(out.current).toBe(0); // finite support
  });

  it('sizes the grid by aspect with the long side at the requested resolution', () => {
    expect(gridSizeFor(512, 16 / 9)).toEqual({ width: 512, height: 288 });
    expect(gridSizeFor(512, 0.5)).toEqual({ width: 256, height: 512 });
  });
});

describe('disturbance queue', () => {
  it('reuses preallocated slots and reports overflow instead of growing', () => {
    const q = new DisturbanceQueue(4);
    const first = q.items[0];
    for (let i = 0; i < 6; i++) q.push(DisturbanceKind.Drop, 0.5, 0.5, 0.01, 0.1);
    expect(q.count).toBe(4);
    expect(q.overflowed).toBe(2);
    expect(q.items[0]).toBe(first);
    q.clear();
    expect(q.count).toBe(0);
  });

  it('rejects invalid disturbances and gives each a unique id', () => {
    const q = new DisturbanceQueue(8);
    expect(q.push(DisturbanceKind.Drop, Number.NaN, 0.5, 0.01, 0.1)).toBeNull();
    expect(q.push(DisturbanceKind.Drop, 0.5, 0.5, 0, 0.1)).toBeNull();
    expect(q.push(DisturbanceKind.Drop, 0.5, 0.5, 0.01, Infinity)).toBeNull();
    const a = q.push(DisturbanceKind.Wake, 0.5, 0.5, 0.01, 0.1, 3, 4)!;
    const aId = a.id;
    const b = q.push(DisturbanceKind.Wake, 0.5, 0.5, 0.01, 0.1, 0, 0)!;
    expect(b.id).not.toBe(aId);
    expect(a.dirX).toBeCloseTo(0.6);
    expect(a.dirY).toBeCloseTo(0.8);
    expect([b.dirX, b.dirY]).toEqual([1, 0]);
  });
});
