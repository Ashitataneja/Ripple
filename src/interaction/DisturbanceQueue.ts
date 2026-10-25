import { createDisturbance, DisturbanceKind, type Disturbance } from '../water/disturbance';

/**
 * Fixed-capacity, allocation-free queue of pending disturbances.
 * Producers call `push(...)`; the simulation drains the whole batch once per frame.
 */
export class DisturbanceQueue {
  readonly capacity: number;
  readonly items: Disturbance[];
  count = 0;
  /** Disturbances dropped because the queue was full (diagnostics). */
  overflowed = 0;
  private nextId = 1;

  constructor(capacity = 512) {
    this.capacity = capacity;
    this.items = Array.from({ length: capacity }, createDisturbance);
  }

  push(kind: DisturbanceKind, x: number, y: number, radius: number, strength: number, dirX = 1, dirY = 0, velocity = 0): Disturbance | null {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius) || !Number.isFinite(strength)) return null;
    if (radius <= 0 || strength === 0) return null;
    if (this.count >= this.capacity) {
      this.overflowed++;
      return null;
    }
    const d = this.items[this.count++];
    d.id = this.nextId++;
    d.kind = kind;
    d.x = x;
    d.y = y;
    d.radius = radius;
    d.strength = strength;
    const len = Math.hypot(dirX, dirY);
    d.dirX = len > 1e-6 ? dirX / len : 1;
    d.dirY = len > 1e-6 ? dirY / len : 0;
    d.velocity = velocity;
    return d;
  }

  clear(): void {
    this.count = 0;
  }
}
