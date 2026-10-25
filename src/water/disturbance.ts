/**
 * Water disturbances: the single currency between every input source and the simulation.
 * Positions are in water UV space (u → right, v → far / up the screen); radii are in world units.
 */

export const DisturbanceKind = {
  /** Pure displacement (a dipped fingertip, a droplet landing). Sign of strength = raise or depress. */
  Drop: 0,
  /** Moving contact: a bow bump ahead, a trough behind. Produces wakes when emitted along a path. */
  Wake: 1,
  /** Broad, elongated travelling wave launched along `dir`. */
  Push: 2,
  /** Pebble impact: downward-moving crater with a raised rim. */
  Impact: 3,
} as const;
export type DisturbanceKind = (typeof DisturbanceKind)[keyof typeof DisturbanceKind];

export interface Disturbance {
  id: number;
  /** Water UV, 0..1. */
  x: number;
  y: number;
  /** World units. */
  radius: number;
  strength: number;
  /** Unit direction in the water plane, UV orientation. */
  dirX: number;
  dirY: number;
  kind: DisturbanceKind;
  /** Optional impact / movement velocity (world units / s), used to shape impacts. */
  velocity: number;
}

export function createDisturbance(): Disturbance {
  return { id: 0, x: 0, y: 0, radius: 0, strength: 0, dirX: 1, dirY: 0, kind: DisturbanceKind.Drop, velocity: 0 };
}

/** Result of evaluating a disturbance at one point: change to current and previous height. */
export interface SplatDelta {
  current: number;
  previous: number;
}

/**
 * Evaluate the contribution of one disturbance at a world-space offset (dx, dy) from its centre.
 * `travelShift` is how far (world units) a wave moves in one simulation step; Push uses it to seed
 * the previous height with a shifted copy so the wave genuinely travels in `dir`.
 *
 * This is the reference implementation. `shaders/disturbance.frag.glsl` mirrors it exactly.
 */
export function evaluateDisturbance(d: Disturbance, dx: number, dy: number, travelShift: number, out: SplatDelta): SplatDelta {
  out.current = 0;
  out.previous = 0;
  const r = Math.max(1e-4, d.radius);
  const s = d.strength;
  switch (d.kind) {
    case DisturbanceKind.Drop: {
      const q = (dx * dx + dy * dy) / (r * r);
      if (q > 9) return out;
      const v = s * Math.exp(-q);
      out.current = v;
      out.previous = v;
      return out;
    }
    case DisturbanceKind.Wake: {
      const q = (dx * dx + dy * dy) / (r * r);
      if (q > 9) return out;
      const along = (dx * d.dirX + dy * d.dirY) / r;
      out.current = s * Math.exp(-q) * (0.9 * along - 0.45);
      return out;
    }
    case DisturbanceKind.Push: {
      const f = pushProfile(d, dx, dy, r, s);
      // previous = profile one step "behind" in time, i.e. shifted against the direction of travel.
      const g = pushProfile(d, dx + d.dirX * travelShift, dy + d.dirY * travelShift, r, s);
      out.current = f;
      out.previous = g;
      return out;
    }
    case DisturbanceKind.Impact: {
      const rho2 = (dx * dx + dy * dy) / (r * r);
      if (rho2 > 16) return out;
      const rho = Math.sqrt(rho2);
      const rim = Math.exp(-((rho - 1.6) * (rho - 1.6)) / 0.36);
      out.current = s * (-Math.exp(-rho2) + 0.3 * rim);
      return out;
    }
  }
  return out;
}

function pushProfile(d: Disturbance, dx: number, dy: number, r: number, s: number): number {
  const along = (dx * d.dirX + dy * d.dirY) / r;
  const across = (-dx * d.dirY + dy * d.dirX) / (r * 2.4);
  const q = along * along + across * across;
  if (q > 12) return 0;
  return s * Math.exp(-q) * (0.65 + 0.5 * along);
}
