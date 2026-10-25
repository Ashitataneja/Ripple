import type { InputSource } from '../interaction/types';

/** Shared, mutable interaction state. Allocated once; mutated in place by the interaction engine. */

export const MAX_CONTACTS = 16;
export const MAX_PEBBLES = 4;
export const TRAJECTORY_LENGTH = 24;

export interface ContactState {
  id: number;
  active: boolean;
  source: InputSource;
  size: number;
  /** Latest reported screen position (target) and the smoothed position actually driving the water. */
  targetX: number;
  targetY: number;
  x: number;
  y: number;
  /** World position of the smoothed point and the last point where a wake was emitted. */
  wx: number;
  wz: number;
  emitX: number;
  emitZ: number;
  /** Smoothed speed in world units per second. */
  speed: number;
  startedAt: number;
  distance: number;
  /** Ring buffer of recent world positions (x, z pairs). */
  trail: Float32Array;
  trailHead: number;
  trailCount: number;
}

export type PebblePhase = 'idle' | 'rising' | 'held' | 'falling' | 'sinking';

export interface PebbleState {
  slot: number;
  phase: PebblePhase;
  ownerId: number;
  x: number;
  y: number;
  z: number;
  /** Where a held pebble wants to be. */
  tx: number;
  ty: number;
  tz: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  scale: number;
  submerge: number;
  opacity: number;
  seed: number;
  impactStrength: number;
  bubbleTimer: number;
}

export interface InteractionCounters {
  contacts: number;
  wakes: number;
  pebbles: number;
  pushes: number;
  compressions: number;
}

export interface InteractionState {
  contacts: ContactState[];
  pebbles: PebbleState[];
  counters: InteractionCounters;
  /** performance.now() of the last user-driven disturbance. */
  lastInteractionAt: number;
  /** Disturbances emitted during the last frame (diagnostics). */
  emittedLastFrame: number;
}

export function createInteractionState(): InteractionState {
  return {
    contacts: Array.from({ length: MAX_CONTACTS }, () => ({
      id: -1,
      active: false,
      source: 'pointer' as InputSource,
      size: 1,
      targetX: 0,
      targetY: 0,
      x: 0,
      y: 0,
      wx: 0,
      wz: 0,
      emitX: 0,
      emitZ: 0,
      speed: 0,
      startedAt: 0,
      distance: 0,
      trail: new Float32Array(TRAJECTORY_LENGTH * 2),
      trailHead: 0,
      trailCount: 0,
    })),
    pebbles: Array.from({ length: MAX_PEBBLES }, (_, slot) => ({
      slot,
      phase: 'idle' as PebblePhase,
      ownerId: -1,
      x: 0,
      y: 0,
      z: 0,
      tx: 0,
      ty: 0,
      tz: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      age: 0,
      scale: 0,
      submerge: 0,
      opacity: 0,
      seed: Math.random(),
      impactStrength: 0,
      bubbleTimer: 0,
    })),
    counters: { contacts: 0, wakes: 0, pebbles: 0, pushes: 0, compressions: 0 },
    lastInteractionAt: 0,
    emittedLastFrame: 0,
  };
}
