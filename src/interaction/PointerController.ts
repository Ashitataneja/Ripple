import { CompressionDetector, SwipeDetector } from './detectors';
import type { InteractionSink } from './types';

export const POINTER = {
  /** Press-and-hold time (ms) that picks up a pebble instead of touching the water. */
  holdToPebbleMs: 380,
  /** Movement (px) that turns a press into a drag. */
  dragThresholdPx: 9,
  swipe: { minSpeed: 2.4, cooldown: 0.5, dominance: 0 },
  compression: { minRate: 0.45, interval: 0.09 },
} as const;

type Mode = 'pending' | 'drag' | 'pebble';

interface PointerTrack {
  id: number;
  type: string;
  mode: Mode;
  startPx: number;
  startPy: number;
  x: number;
  y: number;
  t: number;
  /** Velocity in normalised screen units / s (smoothed). */
  vx: number;
  vy: number;
  holdTimer: ReturnType<typeof setTimeout> | null;
  swipe: SwipeDetector;
}

/** Minimal pointer-event shape so the controller can be driven by tests without a DOM. */
export interface PointerLike {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  timeStamp: number;
  button?: number;
  preventDefault?: () => void;
}

/**
 * Mouse, pen and touch fallback. Uses exactly the same InteractionSink as hand tracking:
 *   press → fingertip dips in · drag → wake · fast flick → broad wave
 *   press and hold → pick up a pebble, release → drop it · two touches → compression.
 */
export class PointerController {
  private readonly tracks = new Map<number, PointerTrack>();
  private readonly compression = new CompressionDetector(POINTER.compression);
  private element: HTMLElement | null = null;
  enabled = true;

  constructor(
    private readonly sink: InteractionSink,
    /** Returns the element's client rect (cached by the caller if needed). */
    private readonly rect: () => { left: number; top: number; width: number; height: number },
    /**
     * Runs a callback after any input already queued has been dispatched. Browsers deliver pending
     * pointer events before animation-frame callbacks, so a busy main thread cannot turn a drag
     * into a pebble hold just because the hold timer ran first.
     */
    private readonly afterQueuedInput: (cb: () => void) => void = (cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => cb()) : setTimeout(cb, 0)),
  ) {}

  attach(element: HTMLElement): void {
    this.detach();
    this.element = element;
    element.addEventListener('pointerdown', this.onDown);
    element.addEventListener('pointermove', this.onMove);
    element.addEventListener('pointerup', this.onUp);
    element.addEventListener('pointercancel', this.onCancel);
    element.addEventListener('lostpointercapture', this.onCancel);
    element.addEventListener('contextmenu', this.preventContextMenu);
  }

  detach(): void {
    const el = this.element;
    if (el) {
      el.removeEventListener('pointerdown', this.onDown);
      el.removeEventListener('pointermove', this.onMove);
      el.removeEventListener('pointerup', this.onUp);
      el.removeEventListener('pointercancel', this.onCancel);
      el.removeEventListener('lostpointercapture', this.onCancel);
      el.removeEventListener('contextmenu', this.preventContextMenu);
    }
    this.element = null;
    this.cancelAll();
  }

  cancelAll(): void {
    for (const track of [...this.tracks.values()]) this.finish(track, track.x, track.y, true);
    this.tracks.clear();
    this.compression.reset();
  }

  get activeCount(): number {
    return this.tracks.size;
  }

  // Handlers are arrow functions so they can be added and removed by reference.
  readonly onDown = (e: PointerLike): void => {
    if (!this.enabled || (e.button !== undefined && e.button > 0)) return;
    e.preventDefault?.();
    const el = this.element as (HTMLElement & { setPointerCapture?: (id: number) => void }) | null;
    try {
      el?.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    const { x, y } = this.normalise(e);
    const existing = this.tracks.get(e.pointerId);
    if (existing) this.finish(existing, existing.x, existing.y, true);
    const track: PointerTrack = {
      id: e.pointerId,
      type: e.pointerType,
      mode: 'pending',
      startPx: e.clientX,
      startPy: e.clientY,
      x,
      y,
      t: e.timeStamp / 1000,
      vx: 0,
      vy: 0,
      holdTimer: null,
      swipe: new SwipeDetector(POINTER.swipe),
    };
    this.tracks.set(e.pointerId, track);
    this.sink.contactStart(contactId(e.pointerId), x, y, 'pointer', e.pointerType === 'touch' ? 1.15 : 1);
    track.holdTimer = setTimeout(() => {
      track.holdTimer = null;
      this.afterQueuedInput(() => this.beginPebble(track));
    }, POINTER.holdToPebbleMs);
  };

  readonly onMove = (e: PointerLike): void => {
    const track = this.tracks.get(e.pointerId);
    if (!track) return;
    const { x, y } = this.normalise(e);
    const t = e.timeStamp / 1000;
    const dt = t - track.t;
    if (dt > 1e-4) {
      const k = Math.min(1, dt / 0.04);
      track.vx += ((x - track.x) / dt - track.vx) * k;
      track.vy += ((y - track.y) / dt - track.vy) * k;
    }
    track.x = x;
    track.y = y;
    track.t = t;

    if (track.mode === 'pending' && Math.hypot(e.clientX - track.startPx, e.clientY - track.startPy) > POINTER.dragThresholdPx) {
      track.mode = 'drag';
      this.clearHold(track);
    }
    if (track.mode === 'pebble') {
      this.sink.pebbleMove(pebbleOwner(track.id), x, y);
    } else {
      this.sink.contactMove(contactId(track.id), x, y);
      if (track.mode === 'drag') {
        const aspect = this.aspect();
        const swipe = track.swipe.update(track.vx * aspect, track.vy, t, true);
        if (swipe.fired) this.sink.push(x, y, swipe.dirX / aspect, swipe.dirY, swipe.speed);
      }
    }
    this.updateCompression(t);
  };

  readonly onUp = (e: PointerLike): void => {
    const track = this.tracks.get(e.pointerId);
    if (!track) return;
    const { x, y } = this.normalise(e);
    this.finish(track, x, y, false);
  };

  readonly onCancel = (e: PointerLike): void => {
    const track = this.tracks.get(e.pointerId);
    if (!track) return;
    this.finish(track, track.x, track.y, true);
  };

  private readonly preventContextMenu = (e: Event): void => e.preventDefault();

  private beginPebble(track: PointerTrack): void {
    if (track.mode !== 'pending' || this.tracks.get(track.id) !== track) return;
    track.mode = 'pebble';
    // The finger lifts out of the water holding a pebble.
    this.sink.contactEnd(contactId(track.id));
    this.sink.pebbleGrab(pebbleOwner(track.id), track.x, track.y);
  }

  private finish(track: PointerTrack, x: number, y: number, cancelled: boolean): void {
    this.clearHold(track);
    if (track.mode === 'pebble') {
      // A cancelled pointer still lets go: the pebble never stays floating.
      this.sink.pebbleRelease(pebbleOwner(track.id), x, y, cancelled ? 0 : track.vx, cancelled ? 0 : track.vy);
    } else {
      this.sink.contactMove(contactId(track.id), x, y);
      this.sink.contactEnd(contactId(track.id));
    }
    this.tracks.delete(track.id);
    if (this.touchCount() < 2) this.compression.reset();
  }

  private updateCompression(t: number): void {
    if (this.touchCount() !== 2) return;
    const [a, b] = [...this.tracks.values()].filter((tr) => tr.type === 'touch');
    const aspect = this.aspect();
    const rate = this.compression.update(a.x * aspect, a.y, b.x * aspect, b.y, t);
    if (rate !== 0) this.sink.compress(a.x, a.y, b.x, b.y, rate);
  }

  private touchCount(): number {
    let n = 0;
    for (const tr of this.tracks.values()) if (tr.type === 'touch') n++;
    return n;
  }

  private clearHold(track: PointerTrack): void {
    if (track.holdTimer !== null) clearTimeout(track.holdTimer);
    track.holdTimer = null;
  }

  private normalise(e: PointerLike): { x: number; y: number } {
    const r = this.rect();
    return {
      x: (e.clientX - r.left) / Math.max(1, r.width),
      y: (e.clientY - r.top) / Math.max(1, r.height),
    };
  }

  private aspect(): number {
    const r = this.rect();
    return Math.max(1, r.width) / Math.max(1, r.height);
  }
}

export function contactId(pointerId: number): number {
  return 1_000_000 + pointerId;
}

export function pebbleOwner(pointerId: number): number {
  return 2_000_000 + pointerId;
}
