/**
 * Contracts between input sources, the interaction engine and the water.
 * Input sources (pointer, hands) speak in normalised screen space: x → right, y → down, both 0..1.
 * Nothing here depends on MediaPipe or Three.js.
 */

export type InputSource = 'pointer' | 'hand';

export interface WorldPoint {
  x: number;
  y: number;
  z: number;
}

export interface WaterDomain {
  /** World-space rectangle covered by the simulation (x right, z towards the viewer). */
  xmin: number;
  zmin: number;
  width: number;
  height: number;
}

/** Maps screen positions onto the water plane. Implemented by the renderer (raycast) and by tests. */
export interface WaterMapping {
  readonly domain: WaterDomain;
  /** Point where the view ray through (sx, sy) meets the still water plane (y = 0). */
  screenToWorld(sx: number, sy: number, out: WorldPoint): boolean;
  /** Point on the view ray through (sx, sy) at world height `height` (used to hold pebbles above the water). */
  screenToHover(sx: number, sy: number, height: number, out: WorldPoint): boolean;
  /** Screen height in pixels divided by width; used to make screen speeds isotropic. */
  readonly screenAspect: number;
}

/**
 * Normalised interaction events. Every input source drives the water exclusively through this
 * interface, so pointer, touch and hand tracking share one disturbance pipeline.
 */
export interface InteractionSink {
  /** A fingertip / pointer touches the water. `size` scales the contact (1 = fingertip). */
  contactStart(id: number, sx: number, sy: number, source: InputSource, size?: number): void;
  contactMove(id: number, sx: number, sy: number): void;
  contactEnd(id: number): void;
  pebbleGrab(ownerId: number, sx: number, sy: number): void;
  pebbleMove(ownerId: number, sx: number, sy: number): void;
  /** vx, vy: release velocity in screen units per second. */
  pebbleRelease(ownerId: number, sx: number, sy: number, vx: number, vy: number): void;
  /** A quick swipe: direction in screen space, speed in screen-heights per second. */
  push(sx: number, sy: number, dirX: number, dirY: number, speed: number): void;
  /** Two contacts closing (rate < 0) or separating (rate > 0), in screen-heights per second. */
  compress(x1: number, y1: number, x2: number, y2: number, rate: number): void;
}

/** Side effects of interactions that are not water physics (sound, haptics, hints). */
export interface InteractionFeedback {
  onContact?(source: InputSource): void;
  onImpact?(strength: number): void;
  onPush?(strength: number): void;
  onCompress?(strength: number): void;
  /** Called every frame with the fastest active wake speed (world units / s). */
  onWakeSpeed?(speed: number): void;
  onDroplet?(size: number): void;
  onPebbleGrab?(): void;
}
