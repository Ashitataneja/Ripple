import { MAX_CONTACTS, TRAJECTORY_LENGTH, type ContactState, type InteractionState, type PebbleState } from '../app/interactionState';
import { DisturbanceKind } from '../water/disturbance';
import type { DisturbanceQueue } from './DisturbanceQueue';
import { PebbleSystem, type PebbleImpact } from './PebbleSystem';
import type { InputSource, InteractionFeedback, InteractionSink, WaterMapping, WorldPoint } from './types';

/** Visual effects the controller can request (implemented by the renderer's particle system). */
export interface SplashEffects {
  splash(x: number, z: number, strength: number, dirX: number, dirZ: number): void;
  bubble(x: number, y: number, z: number): void;
}

/** Tunables for how contacts disturb the water. World units, seconds. */
export const WAKE = {
  /** How quickly the smoothed contact follows its input (1/s). Gives a short, physical lag. */
  followRate: { pointer: 45, hand: 22 } as Record<InputSource, number>,
  minSpeed: 0.04,
  minSpacing: 0.006,
  baseRadius: 0.016,
  radiusPerSpeed: 0.012,
  maxRadius: 0.05,
  baseStrength: 0.03,
  strengthPerSpeed: 0.05,
  maxStrength: 0.16,
  maxEmitPerFrame: 16,
  /** A jump larger than this (world units) between frames is treated as re-acquisition, not motion. */
  teleport: 0.6,
  dip: { pointer: -0.5, hand: -0.24 } as Record<InputSource, number>,
  dipRadius: 0.016,
} as const;

/**
 * The interaction engine. Converts normalised interaction events from any input source into
 * water disturbances, drives pebbles and splashes, and reports feedback for sound and hints.
 */
export class InteractionController implements InteractionSink {
  readonly pebbles: PebbleSystem;
  private readonly p: WorldPoint = { x: 0, y: 0, z: 0 };
  private readonly q: WorldPoint = { x: 0, y: 0, z: 0 };
  private emitted = 0;
  private now = 0;
  private reduceMotion = false;

  constructor(
    readonly state: InteractionState,
    private readonly queue: DisturbanceQueue,
    private readonly mapping: WaterMapping,
    private readonly effects: SplashEffects | null,
    private readonly feedback: InteractionFeedback = {},
  ) {
    this.pebbles = new PebbleSystem(state.pebbles, mapping, {
      onImpact: (pebble, impact) => this.onPebbleImpact(pebble, impact),
      onBubble: (x, y, z) => this.effects?.bubble(x, y, z),
    });
  }

  setReducedMotion(reduce: boolean): void {
    this.reduceMotion = reduce;
  }

  // ------------------------------------------------------------------ InteractionSink

  contactStart(id: number, sx: number, sy: number, source: InputSource, size = 1): void {
    if (!finite(sx, sy)) return;
    let c = this.findContact(id);
    if (!c) c = this.state.contacts.find((s) => !s.active) ?? null;
    if (!c) return;
    if (!this.mapping.screenToWorld(sx, sy, this.p)) return;
    c.id = id;
    c.active = true;
    c.source = source;
    c.size = Math.max(0.3, Math.min(3, size));
    c.targetX = c.x = sx;
    c.targetY = c.y = sy;
    c.wx = c.emitX = this.p.x;
    c.wz = c.emitZ = this.p.z;
    c.speed = 0;
    c.startedAt = this.now;
    c.distance = 0;
    c.trailHead = 0;
    c.trailCount = 0;
    pushTrail(c);
    // The fingertip entering the water: a small depression that rings outwards.
    this.emitWorld(DisturbanceKind.Drop, c.wx, c.wz, WAKE.dipRadius * Math.sqrt(c.size), WAKE.dip[source] * c.size, 1, 0);
    this.state.counters.contacts++;
    this.feedback.onContact?.(source);
  }

  contactMove(id: number, sx: number, sy: number): void {
    const c = this.findContact(id);
    if (!c || !finite(sx, sy)) return;
    c.targetX = sx;
    c.targetY = sy;
  }

  contactEnd(id: number): void {
    const c = this.findContact(id);
    if (!c) return;
    // Finish the path to the last reported point, then lift out with a faint rebound.
    this.advanceContact(c, 1, 1 / 60);
    this.emitWorld(DisturbanceKind.Drop, c.wx, c.wz, WAKE.dipRadius * 0.8, 0.05 * c.size, 1, 0);
    c.active = false;
    c.id = -1;
  }

  pebbleGrab(ownerId: number, sx: number, sy: number): void {
    if (!finite(sx, sy)) return;
    if (this.pebbles.grab(ownerId, sx, sy)) {
      this.feedback.onPebbleGrab?.();
      this.markInteraction();
    }
  }

  pebbleMove(ownerId: number, sx: number, sy: number): void {
    if (!finite(sx, sy)) return;
    this.pebbles.move(ownerId, sx, sy);
  }

  pebbleRelease(ownerId: number, sx: number, sy: number, vx: number, vy: number): void {
    if (!finite(sx, sy)) {
      this.pebbles.cancel(ownerId);
      return;
    }
    this.pebbles.release(ownerId, sx, sy, finiteOr(vx, 0), finiteOr(vy, 0));
  }

  pebbleCancel(ownerId: number): void {
    this.pebbles.cancel(ownerId);
  }

  push(sx: number, sy: number, dirX: number, dirY: number, speed: number): void {
    if (!finite(sx, sy) || !finite(dirX, dirY) || !Number.isFinite(speed)) return;
    if (!this.worldDirection(sx, sy, dirX, dirY, this.q)) return;
    const s = Math.min(0.85, 0.3 + 0.16 * speed) * this.motionScale();
    const r = Math.min(0.15, 0.07 + 0.025 * speed);
    // Launch the wave slightly ahead of the hand, travelling in the swipe direction.
    const x = this.p.x + this.q.x * r * 0.8;
    const z = this.p.z + this.q.z * r * 0.8;
    this.emitWorld(DisturbanceKind.Push, x, z, r, s, this.q.x, -this.q.z);
    this.effects?.splash(x, z, s * 0.25, this.q.x, this.q.z);
    this.state.counters.pushes++;
    this.feedback.onPush?.(s);
  }

  compress(x1: number, y1: number, x2: number, y2: number, rate: number): void {
    if (!finite(x1, y1) || !finite(x2, y2) || !Number.isFinite(rate)) return;
    const a = this.p;
    const b = this.q;
    if (!this.mapping.screenToWorld(x1, y1, a) || !this.mapping.screenToWorld(x2, y2, b)) return;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-4) return;
    const ux = dx / dist;
    const uz = dz / dist;
    const mag = Math.min(0.32, 0.08 + 0.12 * Math.abs(rate)) * this.motionScale();
    const r = 0.05;
    // Closing: waves from each hand travel towards the other. Opening: they travel outwards.
    const sign = rate < 0 ? 1 : -1;
    this.emitWorld(DisturbanceKind.Push, a.x, a.z, r, mag, sign * ux, -sign * uz);
    this.emitWorld(DisturbanceKind.Push, b.x, b.z, r, mag, -sign * ux, sign * uz);
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    // The water between the hands is squeezed up, or drawn down as they part.
    const squeeze = rate < 0 ? Math.max(0, 1 - dist / 1.2) : 0.6;
    this.emitWorld(DisturbanceKind.Drop, mx, mz, Math.min(0.12, dist * 0.18 + 0.03), sign * mag * 0.35 * squeeze, 1, 0);
    this.state.counters.compressions++;
    this.feedback.onCompress?.(mag);
  }

  /** A falling droplet or popping bubble touching the surface. */
  dropletLanded(x: number, z: number, size: number): void {
    this.emitWorld(DisturbanceKind.Drop, x, z, 0.008 + size * 0.01, -0.05 - size * 0.08, 1, 0, false);
    this.feedback.onDroplet?.(size);
  }

  // ------------------------------------------------------------------ frame update

  update(dt: number, now: number): void {
    this.now = now;
    this.emitted = 0;
    let maxSpeed = 0;
    for (const c of this.state.contacts) {
      if (!c.active) continue;
      const k = 1 - Math.exp(-WAKE.followRate[c.source] * dt);
      this.advanceContact(c, k, dt);
      if (c.speed > maxSpeed) maxSpeed = c.speed;
    }
    this.pebbles.update(dt);
    this.feedback.onWakeSpeed?.(maxSpeed);
    this.state.emittedLastFrame = this.emitted;
  }

  /** Finger positions for on-water hover indicators. */
  activeContacts(): readonly ContactState[] {
    return this.state.contacts;
  }

  reset(): void {
    for (const c of this.state.contacts) {
      c.active = false;
      c.id = -1;
    }
    this.pebbles.clear();
    this.queue.clear();
  }

  // ------------------------------------------------------------------ internals

  private advanceContact(c: ContactState, k: number, dt: number): void {
    const nx = c.x + (c.targetX - c.x) * k;
    const ny = c.y + (c.targetY - c.y) * k;
    if (!this.mapping.screenToWorld(nx, ny, this.p)) return;
    const dx = this.p.x - c.wx;
    const dz = this.p.z - c.wz;
    const step = Math.hypot(dx, dz);
    c.x = nx;
    c.y = ny;
    if (step > WAKE.teleport) {
      // Tracking glitch or re-acquired hand: jump without dragging a wake across the pond.
      c.wx = c.emitX = this.p.x;
      c.wz = c.emitZ = this.p.z;
      c.speed = 0;
      return;
    }
    c.wx = this.p.x;
    c.wz = this.p.z;
    const instSpeed = dt > 0 ? step / dt : 0;
    c.speed += (instSpeed - c.speed) * Math.min(1, dt * 12);
    c.distance += step;
    if (step > 0) pushTrail(c);
    this.emitWake(c);
  }

  /** Emit wake disturbances along the path since the last emission, spaced by distance. */
  private emitWake(c: ContactState): void {
    const speed = c.speed;
    if (speed < WAKE.minSpeed) {
      // Holding still: no new energy. Keep the emission anchor under the finger.
      c.emitX = c.wx;
      c.emitZ = c.wz;
      return;
    }
    const radius = Math.min(WAKE.maxRadius, WAKE.baseRadius + WAKE.radiusPerSpeed * speed) * Math.sqrt(c.size);
    const strength = Math.min(WAKE.maxStrength, WAKE.baseStrength + WAKE.strengthPerSpeed * speed) * c.size * this.motionScale();
    const spacing = Math.max(WAKE.minSpacing, radius * 0.45);
    let dx = c.wx - c.emitX;
    let dz = c.wz - c.emitZ;
    const dist = Math.hypot(dx, dz);
    if (dist < spacing) return;
    dx /= dist;
    dz /= dist;
    // Interpolate along the segment so fast movement leaves a continuous wake, not dots.
    let n = Math.floor(dist / spacing);
    let gap = spacing;
    if (n > WAKE.maxEmitPerFrame) {
      gap = dist / WAKE.maxEmitPerFrame;
      n = WAKE.maxEmitPerFrame;
    }
    for (let i = 1; i <= n; i++) {
      const x = c.emitX + dx * gap * i;
      const z = c.emitZ + dz * gap * i;
      this.emitWorld(DisturbanceKind.Wake, x, z, radius, strength, dx, -dz);
    }
    c.emitX += dx * gap * n;
    c.emitZ += dz * gap * n;
    this.state.counters.wakes += n;
  }

  private onPebbleImpact(_pebble: PebbleState, impact: PebbleImpact): void {
    const s = impact.strength * this.motionScale();
    this.emitWorld(DisturbanceKind.Impact, impact.x, impact.z, impact.radius, s, 1, 0, true, impact.fallSpeed);
    this.effects?.splash(impact.x, impact.z, s, 0, 0);
    for (let i = 0; i < 3 + Math.round(s * 5); i++) this.effects?.bubble(impact.x + (Math.random() - 0.5) * 0.03, -0.02 - Math.random() * 0.05, impact.z + (Math.random() - 0.5) * 0.03);
    this.state.counters.pebbles++;
    this.feedback.onImpact?.(s);
  }

  private emitWorld(kind: DisturbanceKind, x: number, z: number, radius: number, strength: number, dirX: number, dirY: number, userDriven = true, velocity = 0): void {
    const d = this.mapping.domain;
    const u = (x - d.xmin) / d.width;
    const v = 1 - (z - d.zmin) / d.height;
    if (u < -0.1 || u > 1.1 || v < -0.1 || v > 1.1) return;
    if (this.queue.push(kind, u, v, radius, strength, dirX, dirY, velocity)) {
      this.emitted++;
      if (userDriven) this.markInteraction();
    }
  }

  /** Converts a screen direction at (sx, sy) to a unit world direction (x, z) in `out`; `this.p` gets the world point. */
  private worldDirection(sx: number, sy: number, dirX: number, dirY: number, out: WorldPoint): boolean {
    const len = Math.hypot(dirX, dirY);
    if (len < 1e-6) return false;
    if (!this.mapping.screenToWorld(sx, sy, this.p)) return false;
    const e = 0.02;
    if (!this.mapping.screenToWorld(sx + (dirX / len) * e, sy + (dirY / len) * e, out)) return false;
    const wx = out.x - this.p.x;
    const wz = out.z - this.p.z;
    const wl = Math.hypot(wx, wz);
    if (wl < 1e-6) return false;
    out.x = wx / wl;
    out.z = wz / wl;
    return true;
  }

  private findContact(id: number): ContactState | null {
    for (let i = 0; i < MAX_CONTACTS; i++) {
      const c = this.state.contacts[i];
      if (c.active && c.id === id) return c;
    }
    return null;
  }

  private markInteraction(): void {
    this.state.lastInteractionAt = this.now;
  }

  private motionScale(): number {
    return this.reduceMotion ? 0.55 : 1;
  }
}

function pushTrail(c: ContactState): void {
  const i = c.trailHead * 2;
  c.trail[i] = c.wx;
  c.trail[i + 1] = c.wz;
  c.trailHead = (c.trailHead + 1) % TRAJECTORY_LENGTH;
  c.trailCount = Math.min(TRAJECTORY_LENGTH, c.trailCount + 1);
}

function finite(a: number, b: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b);
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}
