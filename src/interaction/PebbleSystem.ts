import type { PebbleState } from '../app/interactionState';
import type { WaterMapping, WorldPoint } from './types';

export const PEBBLE = {
  holdHeight: 0.2,
  radius: 0.04,
  gravity: 6.5,
  riseTime: 0.22,
  followRate: 14,
  maxThrowSpeed: 2.6,
  sinkSpeed: 0.22,
  sinkFade: 1.6,
} as const;

export interface PebbleImpact {
  x: number;
  z: number;
  /** Normalised impact strength used for the disturbance, splash and sound. */
  strength: number;
  radius: number;
  throwSpeed: number;
  fallSpeed: number;
}

export interface PebbleCallbacks {
  onImpact(pebble: PebbleState, impact: PebbleImpact): void;
  onBubble?(x: number, y: number, z: number): void;
}

/**
 * Virtual pebbles: picked up, carried with a little inertia, released with a throw velocity,
 * falling under gravity, splashing into the water and sinking out of sight.
 * Each release produces exactly one impact.
 */
export class PebbleSystem {
  private readonly tmp: WorldPoint = { x: 0, y: 0, z: 0 };
  private readonly tmp2: WorldPoint = { x: 0, y: 0, z: 0 };
  private readonly impact: PebbleImpact = { x: 0, z: 0, strength: 0, radius: 0, throwSpeed: 0, fallSpeed: 0 };

  constructor(
    private readonly pebbles: PebbleState[],
    private readonly mapping: WaterMapping,
    private readonly callbacks: PebbleCallbacks,
  ) {}

  held(ownerId: number): PebbleState | null {
    for (const p of this.pebbles) {
      if (p.ownerId === ownerId && (p.phase === 'rising' || p.phase === 'held')) return p;
    }
    return null;
  }

  grab(ownerId: number, sx: number, sy: number): PebbleState | null {
    if (this.held(ownerId)) return null;
    if (!this.mapping.screenToHover(sx, sy, PEBBLE.holdHeight, this.tmp)) return null;
    let slot = this.pebbles.find((p) => p.phase === 'idle');
    if (!slot) {
      // Recycle the oldest sinking pebble; never steal one that is held or in flight.
      slot = this.pebbles.filter((p) => p.phase === 'sinking').sort((a, b) => b.age - a.age)[0];
    }
    if (!slot) return null;
    const p = slot;
    // The pebble is lifted out of the water at the contact point and rises to hand height.
    this.mapping.screenToWorld(sx, sy, this.tmp2);
    p.phase = 'rising';
    p.ownerId = ownerId;
    p.x = this.tmp2.x;
    p.y = 0;
    p.z = this.tmp2.z;
    p.tx = this.tmp.x;
    p.ty = this.tmp.y;
    p.tz = this.tmp.z;
    p.vx = p.vy = p.vz = 0;
    p.age = 0;
    p.scale = 0;
    p.submerge = 0;
    p.opacity = 1;
    p.seed = Math.random();
    p.impactStrength = 0;
    p.bubbleTimer = 0;
    return p;
  }

  move(ownerId: number, sx: number, sy: number): void {
    const p = this.held(ownerId);
    if (!p) return;
    if (this.mapping.screenToHover(sx, sy, PEBBLE.holdHeight, this.tmp)) {
      p.tx = this.tmp.x;
      p.ty = this.tmp.y;
      p.tz = this.tmp.z;
    }
  }

  /** Release the held pebble. Returns true when a pebble was actually dropped. */
  release(ownerId: number, sx: number, sy: number, vx: number, vy: number): boolean {
    const p = this.held(ownerId);
    if (!p) return false;
    this.move(ownerId, sx, sy);
    // Convert the screen release velocity to a world-space throw over the water.
    let wvx = 0;
    let wvz = 0;
    const dt = 0.05;
    if (Number.isFinite(vx) && Number.isFinite(vy) && this.mapping.screenToWorld(sx, sy, this.tmp) && this.mapping.screenToWorld(sx + vx * dt, sy + vy * dt, this.tmp2)) {
      wvx = (this.tmp2.x - this.tmp.x) / dt;
      wvz = (this.tmp2.z - this.tmp.z) / dt;
      const sp = Math.hypot(wvx, wvz);
      if (sp > PEBBLE.maxThrowSpeed) {
        wvx *= PEBBLE.maxThrowSpeed / sp;
        wvz *= PEBBLE.maxThrowSpeed / sp;
      }
    }
    // The pebble falls from where it is held to the water point under the hand, plus the throw.
    this.mapping.screenToWorld(sx, sy, this.tmp);
    const fallTime = Math.sqrt((2 * Math.max(0.01, p.y)) / PEBBLE.gravity);
    p.vx = (this.tmp.x - p.x) / fallTime + wvx;
    p.vz = (this.tmp.z - p.z) / fallTime + wvz;
    p.vy = 0;
    p.scale = 1;
    p.phase = 'falling';
    p.impactStrength = Math.hypot(wvx, wvz);
    return true;
  }

  /** Tracking lost or input cancelled: let go gently so nothing floats forever. */
  cancel(ownerId: number): void {
    const p = this.held(ownerId);
    if (!p) return;
    p.vx = p.vz = p.vy = 0;
    p.scale = 1;
    p.impactStrength = 0;
    p.phase = 'falling';
  }

  clear(): void {
    for (const p of this.pebbles) {
      p.phase = 'idle';
      p.ownerId = -1;
      p.opacity = 0;
    }
  }

  update(dt: number): void {
    for (const p of this.pebbles) {
      if (p.phase === 'idle') continue;
      p.age += dt;
      switch (p.phase) {
        case 'rising':
        case 'held': {
          const k = 1 - Math.exp(-PEBBLE.followRate * dt);
          p.x += (p.tx - p.x) * k;
          p.y += (p.ty - p.y) * k;
          p.z += (p.tz - p.z) * k;
          p.scale = Math.min(1, p.age / PEBBLE.riseTime);
          p.scale = 1 - (1 - p.scale) * (1 - p.scale);
          if (p.phase === 'rising' && p.age >= PEBBLE.riseTime) p.phase = 'held';
          break;
        }
        case 'falling': {
          p.vy -= PEBBLE.gravity * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.z += p.vz * dt;
          if (p.y <= 0) this.hitWater(p);
          break;
        }
        case 'sinking': {
          p.vy += (-PEBBLE.sinkSpeed - p.vy) * Math.min(1, 6 * dt);
          p.vx *= Math.exp(-5 * dt);
          p.vz *= Math.exp(-5 * dt);
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.z += p.vz * dt;
          p.submerge = Math.min(1, p.submerge + dt / 0.12);
          p.opacity = Math.max(0, p.opacity - dt / PEBBLE.sinkFade);
          p.bubbleTimer -= dt;
          if (p.bubbleTimer <= 0 && p.opacity > 0.3) {
            p.bubbleTimer = 0.06 + Math.random() * 0.12;
            this.callbacks.onBubble?.(p.x, p.y, p.z);
          }
          if (p.opacity <= 0) {
            p.phase = 'idle';
            p.ownerId = -1;
          }
          break;
        }
      }
    }
  }

  private hitWater(p: PebbleState): void {
    const fallSpeed = Math.abs(p.vy);
    const throwSpeed = p.impactStrength;
    const strength = Math.min(1.5, Math.max(0.3, 0.3 + 0.12 * fallSpeed + 0.42 * throwSpeed));
    const impact = this.impact;
    impact.x = p.x;
    impact.z = p.z;
    impact.strength = strength;
    impact.radius = PEBBLE.radius * (1 + 0.25 * Math.min(2, throwSpeed));
    impact.throwSpeed = throwSpeed;
    impact.fallSpeed = fallSpeed;
    p.y = 0;
    p.vy = -0.6;
    p.phase = 'sinking';
    p.ownerId = -1;
    p.impactStrength = strength;
    this.callbacks.onImpact(p, impact);
  }
}
