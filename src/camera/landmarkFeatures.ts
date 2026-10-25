/**
 * Geometry on MediaPipe's 21 hand landmarks (image-normalised x, y; z relative depth).
 * Pure functions; distances are computed with the image aspect so they are isotropic.
 */

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

export const LM = {
  wrist: 0,
  thumbCmc: 1,
  thumbMcp: 2,
  thumbIp: 3,
  thumbTip: 4,
  indexMcp: 5,
  indexPip: 6,
  indexTip: 8,
  middleMcp: 9,
  middlePip: 10,
  middleTip: 12,
  ringMcp: 13,
  ringPip: 14,
  ringTip: 16,
  pinkyMcp: 17,
  pinkyPip: 18,
  pinkyTip: 20,
} as const;

/** Fingertip landmark indices in the order thumb, index, middle, ring, little. */
export const FINGERTIPS = [LM.thumbTip, LM.indexTip, LM.middleTip, LM.ringTip, LM.pinkyTip] as const;
const PIPS = [LM.thumbIp, LM.indexPip, LM.middlePip, LM.ringPip, LM.pinkyPip] as const;
const MCPS = [LM.thumbMcp, LM.indexMcp, LM.middleMcp, LM.ringMcp, LM.pinkyMcp] as const;

export function isValidHand(landmarks: readonly Landmark[] | null | undefined): landmarks is readonly Landmark[] {
  if (!landmarks || landmarks.length !== 21) return false;
  for (const p of landmarks) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
    if (p.x < -0.5 || p.x > 1.5 || p.y < -0.5 || p.y > 1.5) return false;
  }
  return true;
}

export function dist(a: Landmark, b: Landmark, aspect: number): number {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

const PALM_IDS = [LM.wrist, LM.indexMcp, LM.middleMcp, LM.ringMcp, LM.pinkyMcp] as const;

/** Palm centre: mean of the wrist and the four finger MCP joints. */
export function palmCenter(lm: readonly Landmark[], out: { x: number; y: number }): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const i of PALM_IDS) {
    x += lm[i].x;
    y += lm[i].y;
  }
  out.x = x / PALM_IDS.length;
  out.y = y / PALM_IDS.length;
  return out;
}

/** Characteristic hand size: wrist to middle-finger MCP. */
export function handScale(lm: readonly Landmark[], aspect: number): number {
  return Math.max(1e-4, dist(lm[LM.wrist], lm[LM.middleMcp], aspect));
}

/** Whether a finger (0 = thumb … 4 = little) is extended rather than curled. */
export function fingerExtended(lm: readonly Landmark[], finger: number, aspect: number): boolean {
  if (finger === 0) {
    // Thumb: extended when its tip is clearly further from the little-finger base than its IP joint.
    const ref = lm[LM.pinkyMcp];
    return dist(lm[LM.thumbTip], ref, aspect) > dist(lm[LM.thumbIp], ref, aspect) * 1.12;
  }
  const wrist = lm[LM.wrist];
  return dist(lm[FINGERTIPS[finger]], wrist, aspect) > dist(lm[PIPS[finger]], wrist, aspect) * 1.12;
}

/** 0 = closed fist, 1 = fully open hand. */
export function handOpenness(lm: readonly Landmark[], aspect: number): number {
  const wrist = lm[LM.wrist];
  let sum = 0;
  for (let f = 1; f < 5; f++) {
    const ratio = dist(lm[FINGERTIPS[f]], wrist, aspect) / Math.max(1e-4, dist(lm[MCPS[f]], wrist, aspect));
    sum += clamp01((ratio - 1.15) / (1.85 - 1.15));
  }
  return sum / 4;
}

/** Thumb-tip to index-tip distance relative to hand size. ~0.1 pinched, >0.5 open. */
export function pinchRatio(lm: readonly Landmark[], aspect: number): number {
  return dist(lm[LM.thumbTip], lm[LM.indexTip], aspect) / handScale(lm, aspect);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
