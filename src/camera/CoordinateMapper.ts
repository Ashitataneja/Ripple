/**
 * Maps camera-image coordinates to normalised screen coordinates.
 * - Mirroring makes the experience behave like a mirror: moving your right hand to the right
 *   moves the disturbance to the right of the screen (the preview is mirrored the same way).
 * - Calibration selects the comfortable region of the camera frame that spans the whole screen,
 *   because hands near the frame edges are often lost by the tracker.
 */

export interface CalibrationRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const DEFAULT_CALIBRATION: CalibrationRect = { x0: 0.1, y0: 0.08, x1: 0.9, y1: 0.82 };

export class CoordinateMapper {
  mirror: boolean;
  private rect: CalibrationRect;

  constructor(mirror = true, rect: CalibrationRect = DEFAULT_CALIBRATION) {
    this.mirror = mirror;
    this.rect = { ...rect };
  }

  get calibration(): Readonly<CalibrationRect> {
    return this.rect;
  }

  setCalibration(rect: CalibrationRect): void {
    const x0 = Math.min(rect.x0, rect.x1);
    const x1 = Math.max(rect.x0, rect.x1);
    const y0 = Math.min(rect.y0, rect.y1);
    const y1 = Math.max(rect.y0, rect.y1);
    if (x1 - x0 < 0.15 || y1 - y0 < 0.15) return; // degenerate; keep the previous calibration
    this.rect = { x0, y0, x1, y1 };
  }

  /** Image x (as delivered by the tracker, unmirrored) → mirrored-if-needed image x. */
  viewX(imageX: number): number {
    return this.mirror ? 1 - imageX : imageX;
  }

  /** Camera image (0..1) → screen (0..1, y down). Slightly overscanned so edges are reachable. */
  map(imageX: number, imageY: number, out: { x: number; y: number }): { x: number; y: number } {
    const r = this.rect;
    const vx = this.viewX(imageX);
    out.x = clamp((vx - r.x0) / (r.x1 - r.x0), -0.05, 1.05);
    out.y = clamp((imageY - r.y0) / (r.y1 - r.y0), -0.05, 1.05);
    return out;
  }
}

/** Records hand positions for a few seconds and proposes a calibration covering the reach. */
export class CalibrationRecorder {
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  samples = 0;

  add(viewX: number, imageY: number): void {
    if (!Number.isFinite(viewX) || !Number.isFinite(imageY)) return;
    this.minX = Math.min(this.minX, viewX);
    this.maxX = Math.max(this.maxX, viewX);
    this.minY = Math.min(this.minY, imageY);
    this.maxY = Math.max(this.maxY, imageY);
    this.samples++;
  }

  /** Returns null if the recorded reach was too small to be meaningful. */
  result(padding = 0.03): CalibrationRect | null {
    if (this.samples < 10) return null;
    const rect = {
      x0: Math.max(0, this.minX - padding),
      y0: Math.max(0, this.minY - padding),
      x1: Math.min(1, this.maxX + padding),
      y1: Math.min(1, this.maxY + padding),
    };
    if (rect.x1 - rect.x0 < 0.2 || rect.y1 - rect.y0 < 0.2) return null;
    return rect;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
