import type { Landmark } from '../camera/landmarkFeatures';
import type { InputSource, InteractionSink, WaterMapping, WorldPoint } from '../interaction/types';

/** Linear screen → world mapping: world x = 2·sx, world z = sy, so water uv = (sx, 1 − sy). */
export function linearMapping(): WaterMapping {
  return {
    domain: { xmin: 0, zmin: 0, width: 2, height: 1 },
    screenAspect: 0.5,
    screenToWorld(sx: number, sy: number, out: WorldPoint) {
      out.x = sx * 2;
      out.y = 0;
      out.z = sy;
      return true;
    },
    screenToHover(sx: number, sy: number, h: number, out: WorldPoint) {
      out.x = sx * 2;
      out.y = h;
      out.z = sy;
      return true;
    },
  };
}

export type SinkCall =
  | { kind: 'contactStart'; id: number; x: number; y: number; source: InputSource; size?: number }
  | { kind: 'contactMove'; id: number; x: number; y: number }
  | { kind: 'contactEnd'; id: number }
  | { kind: 'pebbleGrab'; id: number; x: number; y: number }
  | { kind: 'pebbleMove'; id: number; x: number; y: number }
  | { kind: 'pebbleRelease'; id: number; x: number; y: number; vx: number; vy: number }
  | { kind: 'push'; x: number; y: number; dirX: number; dirY: number; speed: number }
  | { kind: 'compress'; x1: number; y1: number; x2: number; y2: number; rate: number };

export class RecordingSink implements InteractionSink {
  calls: SinkCall[] = [];
  contactStart(id: number, x: number, y: number, source: InputSource, size?: number) {
    this.calls.push({ kind: 'contactStart', id, x, y, source, size });
  }
  contactMove(id: number, x: number, y: number) {
    this.calls.push({ kind: 'contactMove', id, x, y });
  }
  contactEnd(id: number) {
    this.calls.push({ kind: 'contactEnd', id });
  }
  pebbleGrab(id: number, x: number, y: number) {
    this.calls.push({ kind: 'pebbleGrab', id, x, y });
  }
  pebbleMove(id: number, x: number, y: number) {
    this.calls.push({ kind: 'pebbleMove', id, x, y });
  }
  pebbleRelease(id: number, x: number, y: number, vx: number, vy: number) {
    this.calls.push({ kind: 'pebbleRelease', id, x, y, vx, vy });
  }
  push(x: number, y: number, dirX: number, dirY: number, speed: number) {
    this.calls.push({ kind: 'push', x, y, dirX, dirY, speed });
  }
  compress(x1: number, y1: number, x2: number, y2: number, rate: number) {
    this.calls.push({ kind: 'compress', x1, y1, x2, y2, rate });
  }
  count(kind: SinkCall['kind']): number {
    return this.calls.filter((c) => c.kind === kind).length;
  }
  of<K extends SinkCall['kind']>(kind: K): Extract<SinkCall, { kind: K }>[] {
    return this.calls.filter((c) => c.kind === kind) as Extract<SinkCall, { kind: K }>[];
  }
  clear() {
    this.calls = [];
  }
}

export interface HandPose {
  cx: number;
  cy: number;
  /** Fingers (1..4 = index..little) that are curled into the palm. */
  curled?: number[];
  pinch?: boolean;
  fist?: boolean;
}

/**
 * A plausible 21-point hand in image coordinates (palm facing the camera, fingers up).
 * Good enough for the geometric features the classifier uses.
 */
export function makeHand({ cx, cy, curled = [], pinch = false, fist = false }: HandPose): Landmark[] {
  const p = (x: number, y: number): Landmark => ({ x: cx + x, y: cy + y, z: 0 });
  const lm: Landmark[] = new Array(21);
  lm[0] = p(0, 0.16);
  // Thumb.
  lm[1] = p(-0.05, 0.12);
  lm[2] = p(-0.08, 0.08);
  lm[3] = p(-0.1, 0.04);
  lm[4] = p(-0.13, 0.01);
  const fingers: [number, number, number, number][] = [
    // mcp x, mcp y, tip y, base index
    [-0.04, 0.02, -0.11, 5],
    [-0.01, 0.015, -0.13, 9],
    [0.02, 0.02, -0.11, 13],
    [0.05, 0.03, -0.07, 17],
  ];
  fingers.forEach(([mx, my, ty, base], i) => {
    const finger = i + 1;
    lm[base] = p(mx, my);
    if (fist || curled.includes(finger)) {
      lm[base + 1] = p(mx, my - 0.03);
      lm[base + 2] = p(mx, my - 0.01);
      lm[base + 3] = p(mx, my + 0.02);
    } else {
      lm[base + 1] = p(mx * 1.1, my + (ty - my) * 0.45);
      lm[base + 2] = p(mx * 1.15, my + (ty - my) * 0.75);
      lm[base + 3] = p(mx * 1.2, ty);
    }
  });
  if (fist) {
    lm[3] = p(-0.05, 0.06);
    lm[4] = p(-0.02, 0.05);
  }
  if (pinch) {
    lm[6] = p(-0.06, -0.03);
    lm[7] = p(-0.08, -0.01);
    lm[8] = p(-0.09, 0.0);
    lm[4] = p(-0.092, 0.004);
  }
  return lm;
}
