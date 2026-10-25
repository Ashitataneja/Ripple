import { CompressionDetector, SwipeDetector } from '../interaction/detectors';
import type { InteractionSink } from '../interaction/types';
import { CoordinateMapper } from './CoordinateMapper';
import { fingerExtended, FINGERTIPS, handOpenness, isValidHand, palmCenter, pinchRatio, type Landmark } from './landmarkFeatures';
import { PointFilter } from './OneEuroFilter';

export interface TrackedHand {
  landmarks: readonly Landmark[];
  /** MediaPipe's handedness label ("Left" / "Right"); used only to keep hand identity stable. */
  handedness: string;
  score: number;
}

export interface HandFrame {
  hands: readonly TrackedHand[];
  /** Milliseconds (performance.now()). */
  timestamp: number;
  /** Video width / height. */
  videoAspect: number;
}

export type PinchEvent = 'none' | 'start' | 'release';

export interface PinchOptions {
  enter: number;
  exit: number;
  /** Seconds the pinch must persist before it counts (debounce). */
  holdTime: number;
  /** Seconds the open state must persist before a release counts. */
  releaseTime: number;
}

/** Hysteresis + debounce so a single pinch yields exactly one start and one release. */
export class PinchDetector {
  pinched = false;
  private candidateSince = -1;

  constructor(private readonly options: PinchOptions = { enter: 0.3, exit: 0.48, holdTime: 0.07, releaseTime: 0.05 }) {}

  update(ratio: number, t: number): PinchEvent {
    if (!Number.isFinite(ratio)) return 'none';
    const o = this.options;
    if (!this.pinched) {
      if (ratio < o.enter) {
        if (this.candidateSince < 0) this.candidateSince = t;
        if (t - this.candidateSince >= o.holdTime) {
          this.pinched = true;
          this.candidateSince = -1;
          return 'start';
        }
      } else this.candidateSince = -1;
      return 'none';
    }
    if (ratio > o.exit) {
      if (this.candidateSince < 0) this.candidateSince = t;
      // A wide-open hand releases immediately; a borderline one must hold open briefly.
      if (ratio > o.exit * 1.5 || t - this.candidateSince >= o.releaseTime) {
        this.pinched = false;
        this.candidateSince = -1;
        return 'release';
      }
    } else this.candidateSince = -1;
    return 'none';
  }

  /** True when the fingers are close enough that a pinch may be forming. */
  isForming(ratio: number): boolean {
    return this.pinched || ratio < this.options.exit;
  }

  reset(): void {
    this.pinched = false;
    this.candidateSince = -1;
  }
}

export const GESTURE = {
  minScore: 0.5,
  /** Keep a hand's state alive this long after tracking drops out (seconds). */
  lossGrace: 0.35,
  /** Palm jumps larger than this (screen heights) in one frame are treated as re-acquisition. */
  maxJump: 0.35,
  maxSpeed: 8,
  openThreshold: 0.68,
  palmWakeSpeed: 1.3,
  swipe: { minSpeed: 2.1, cooldown: 0.65, dominance: 1.3 },
  compression: { minRate: 0.35, interval: 0.09 },
} as const;

export interface FingerCursor {
  x: number;
  y: number;
  inWater: boolean;
  pinching: boolean;
}

interface HandSlot {
  index: number;
  present: boolean;
  seenThisFrame: boolean;
  label: string;
  lastSeen: number;
  lastT: number;
  tipFilters: PointFilter[];
  palmFilter: PointFilter;
  tips: { x: number; y: number }[];
  tipInWater: boolean[];
  palm: { x: number; y: number };
  /** Palm velocity in screen-heights / s. */
  vx: number;
  vy: number;
  /** Pinch point and its velocity in normalised screen units / s. */
  pinchX: number;
  pinchY: number;
  pinchVx: number;
  pinchVy: number;
  openness: number;
  pinch: PinchDetector;
  holding: boolean;
  swipe: SwipeDetector;
  palmContact: boolean;
}

/**
 * Turns raw hand landmarks into interaction events: dipping fingertips, carrying and dropping
 * pebbles, wakes, swipes and two-hand compression. Knows nothing about rendering.
 */
export class GestureClassifier {
  private readonly slots: HandSlot[];
  private readonly compression = new CompressionDetector(GESTURE.compression);
  private readonly tmp = { x: 0, y: 0 };
  private readonly raw = { x: 0, y: 0 };
  private assigned: (TrackedHand | null)[] = [null, null];
  /** Smoothed seconds between tracker results; slow trackers get a proportionally longer grace. */
  private frameInterval = 1 / 30;
  private lastFrameT = -1;

  constructor(
    private readonly sink: InteractionSink,
    readonly mapper: CoordinateMapper,
    /** Viewport width / height, for isotropic speeds. */
    private readonly viewportAspect: () => number,
  ) {
    this.slots = [0, 1].map((index) => ({
      index,
      present: false,
      seenThisFrame: false,
      label: '',
      lastSeen: 0,
      lastT: 0,
      tipFilters: FINGERTIPS.map(() => new PointFilter(1.6, 0.9)),
      palmFilter: new PointFilter(1.2, 0.7),
      tips: FINGERTIPS.map(() => ({ x: 0, y: 0 })),
      tipInWater: FINGERTIPS.map(() => false),
      palm: { x: 0, y: 0 },
      vx: 0,
      vy: 0,
      pinchX: 0,
      pinchY: 0,
      pinchVx: 0,
      pinchVy: 0,
      openness: 0,
      pinch: new PinchDetector(),
      holding: false,
      swipe: new SwipeDetector(GESTURE.swipe),
      palmContact: false,
    }));
  }

  static contactId(slot: number, finger: number): number {
    return 1000 + slot * 10 + finger;
  }

  static pebbleOwner(slot: number): number {
    return 2000 + slot;
  }

  get handsPresent(): number {
    return this.slots.filter((s) => s.present).length;
  }

  /** Process one tracker result (possibly with no hands). */
  process(frame: HandFrame): void {
    const t = frame.timestamp / 1000;
    const aspect = frame.videoAspect > 0 ? frame.videoAspect : 4 / 3;
    if (this.lastFrameT >= 0 && t > this.lastFrameT) this.frameInterval += (Math.min(1, t - this.lastFrameT) - this.frameInterval) * 0.2;
    this.lastFrameT = t;
    const grace = Math.max(GESTURE.lossGrace, this.frameInterval * 2.5);
    for (const s of this.slots) s.seenThisFrame = false;
    this.assign(frame.hands);

    for (const slot of this.slots) {
      const hand = this.assigned[slot.index];
      if (hand) this.updateSlot(slot, hand, t, aspect);
      else if (slot.present && t - slot.lastSeen > grace) this.lose(slot);
    }

    const [a, b] = this.slots;
    const bothOpen = a.seenThisFrame && b.seenThisFrame && !a.holding && !b.holding && a.openness > GESTURE.openThreshold && b.openness > GESTURE.openThreshold;
    if (bothOpen) {
      const va = this.viewportAspect();
      const rate = this.compression.update(a.palm.x * va, a.palm.y, b.palm.x * va, b.palm.y, t);
      if (rate !== 0) this.sink.compress(a.palm.x, a.palm.y, b.palm.x, b.palm.y, rate);
    } else this.compression.reset();
  }

  /** Release everything (camera stopped). Existing waves are left untouched. */
  releaseAll(): void {
    for (const slot of this.slots) if (slot.present) this.lose(slot);
    this.compression.reset();
  }

  /** Current fingertip cursors for on-water indicators; fills `out`, returns the count. */
  cursors(out: FingerCursor[]): number {
    let n = 0;
    for (const slot of this.slots) {
      if (!slot.present) continue;
      for (let f = 0; f < slot.tips.length && n < out.length; f++) {
        const c = out[n++];
        c.x = slot.tips[f].x;
        c.y = slot.tips[f].y;
        c.inWater = slot.tipInWater[f];
        c.pinching = slot.holding && f < 2;
      }
    }
    return n;
  }

  private assign(hands: readonly TrackedHand[]): void {
    this.assigned[0] = this.assigned[1] = null;
    const valid: TrackedHand[] = [];
    for (const h of hands) if (h && h.score >= GESTURE.minScore && isValidHand(h.landmarks)) valid.push(h);
    valid.sort((x, y) => y.score - x.score);
    if (valid.length > 2) valid.length = 2;
    // 1) Same handedness label as a present slot. 2) Nearest present slot. 3) Any free slot.
    const pending: TrackedHand[] = [];
    for (const h of valid) {
      const slot = this.slots.find((s) => s.present && s.label === h.handedness && !this.assigned[s.index]);
      if (slot) this.assigned[slot.index] = h;
      else pending.push(h);
    }
    for (const h of pending) {
      palmCenter(h.landmarks, this.raw);
      this.mapper.map(this.raw.x, this.raw.y, this.tmp);
      let best: HandSlot | null = null;
      let bestD = Infinity;
      for (const s of this.slots) {
        if (this.assigned[s.index]) continue;
        const d = s.present ? Math.hypot(s.palm.x - this.tmp.x, s.palm.y - this.tmp.y) : 10;
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      if (best) this.assigned[best.index] = h;
    }
  }

  private updateSlot(slot: HandSlot, hand: TrackedHand, t: number, aspect: number): void {
    const lm = hand.landmarks;
    const va = this.viewportAspect();
    palmCenter(lm, this.raw);
    this.mapper.map(this.raw.x, this.raw.y, this.tmp);
    const px = this.tmp.x;
    const py = this.tmp.y;

    const dt = slot.present ? t - slot.lastT : 0;
    const jumped = slot.present && Math.hypot((px - slot.palm.x) * va, py - slot.palm.y) > GESTURE.maxJump;
    if (!slot.present || jumped) {
      // New or re-acquired hand: start clean so no wake is dragged across the gap.
      this.endContacts(slot);
      slot.palmFilter.reset(px, py, t);
      for (let f = 0; f < FINGERTIPS.length; f++) {
        this.mapper.map(lm[FINGERTIPS[f]].x, lm[FINGERTIPS[f]].y, this.tmp);
        slot.tipFilters[f].reset(this.tmp.x, this.tmp.y, t);
      }
      slot.vx = slot.vy = 0;
      slot.pinchVx = slot.pinchVy = 0;
      slot.swipe.reset();
    }
    slot.present = true;
    slot.seenThisFrame = true;
    slot.label = hand.handedness;
    slot.lastSeen = t;

    // Smoothed palm position and velocity.
    const prevX = slot.palm.x;
    const prevY = slot.palm.y;
    slot.palmFilter.filter(px, py, t);
    slot.palm.x = slot.palmFilter.x;
    slot.palm.y = slot.palmFilter.y;
    if (dt > 1e-3 && !jumped) {
      let vx = ((slot.palm.x - prevX) * va) / dt;
      let vy = (slot.palm.y - prevY) / dt;
      const sp = Math.hypot(vx, vy);
      if (sp > GESTURE.maxSpeed) {
        vx *= GESTURE.maxSpeed / sp;
        vy *= GESTURE.maxSpeed / sp;
      }
      const k = Math.min(1, dt * 18);
      slot.vx += (vx - slot.vx) * k;
      slot.vy += (vy - slot.vy) * k;
    }
    slot.lastT = t;

    // Smoothed fingertips.
    for (let f = 0; f < FINGERTIPS.length; f++) {
      this.mapper.map(lm[FINGERTIPS[f]].x, lm[FINGERTIPS[f]].y, this.tmp);
      slot.tipFilters[f].filter(this.tmp.x, this.tmp.y, t);
      slot.tips[f].x = slot.tipFilters[f].x;
      slot.tips[f].y = slot.tipFilters[f].y;
    }

    slot.openness = handOpenness(lm, aspect);
    const ratio = pinchRatio(lm, aspect);

    // --- Pebble: pinch, carry, release -----------------------------------------------------
    const prevPinchX = slot.pinchX;
    const prevPinchY = slot.pinchY;
    slot.pinchX = (slot.tips[0].x + slot.tips[1].x) / 2;
    slot.pinchY = (slot.tips[0].y + slot.tips[1].y) / 2;
    if (dt > 1e-3 && !jumped) {
      const k = Math.min(1, dt * 15);
      slot.pinchVx += ((slot.pinchX - prevPinchX) / dt - slot.pinchVx) * k;
      slot.pinchVy += ((slot.pinchY - prevPinchY) / dt - slot.pinchVy) * k;
    }
    const pinch = slot.pinch.update(ratio, t);
    const owner = GestureClassifier.pebbleOwner(slot.index);
    if (pinch === 'start') {
      this.endContacts(slot);
      slot.holding = true;
      this.sink.pebbleGrab(owner, slot.pinchX, slot.pinchY);
    } else if (pinch === 'release' && slot.holding) {
      slot.holding = false;
      this.sink.pebbleRelease(owner, slot.pinchX, slot.pinchY, slot.pinchVx, slot.pinchVy);
    } else if (slot.holding) {
      this.sink.pebbleMove(owner, slot.pinchX, slot.pinchY);
    }

    // --- Fingertips dipping into the water ---------------------------------------------------
    const forming = slot.pinch.isForming(ratio);
    for (let f = 0; f < FINGERTIPS.length; f++) {
      const extended = fingerExtended(lm, f, aspect);
      const blocked = slot.holding || (forming && f < 2) || (f === 0 && slot.openness < 0.5);
      const inWater = extended && !blocked;
      const id = GestureClassifier.contactId(slot.index, f);
      const tip = slot.tips[f];
      if (inWater && !slot.tipInWater[f]) this.sink.contactStart(id, tip.x, tip.y, 'hand', 1);
      else if (inWater) this.sink.contactMove(id, tip.x, tip.y);
      else if (slot.tipInWater[f]) this.sink.contactEnd(id);
      slot.tipInWater[f] = inWater;
    }

    // --- Open hand dragged quickly: a broad palm wake ----------------------------------------
    const open = slot.openness > GESTURE.openThreshold && !slot.holding;
    const speed = Math.hypot(slot.vx, slot.vy);
    const palmId = GestureClassifier.contactId(slot.index, 5);
    const palmWake = open && speed > GESTURE.palmWakeSpeed;
    if (palmWake && !slot.palmContact) this.sink.contactStart(palmId, slot.palm.x, slot.palm.y, 'hand', 2.2);
    else if (palmWake) this.sink.contactMove(palmId, slot.palm.x, slot.palm.y);
    else if (slot.palmContact && speed < GESTURE.palmWakeSpeed * 0.6) {
      this.sink.contactEnd(palmId);
      slot.palmContact = false;
    }
    if (palmWake) slot.palmContact = true;

    // --- Swipe: push a broad wave --------------------------------------------------------------
    const swipe = slot.swipe.update(slot.vx, slot.vy, t, open);
    if (swipe.fired) {
      // Convert the isotropic direction back to normalised screen units.
      this.sink.push(slot.palm.x, slot.palm.y, swipe.dirX / va, swipe.dirY, swipe.speed);
    }
  }

  private endContacts(slot: HandSlot): void {
    for (let f = 0; f < FINGERTIPS.length; f++) {
      if (slot.tipInWater[f]) this.sink.contactEnd(GestureClassifier.contactId(slot.index, f));
      slot.tipInWater[f] = false;
    }
    if (slot.palmContact) this.sink.contactEnd(GestureClassifier.contactId(slot.index, 5));
    slot.palmContact = false;
  }

  /** Tracking lost for longer than the grace period. Waves continue; the hand lets go. */
  private lose(slot: HandSlot): void {
    this.endContacts(slot);
    if (slot.holding) {
      // Drop the pebble gently where it was last held: it must never float forever.
      this.sink.pebbleRelease(GestureClassifier.pebbleOwner(slot.index), slot.pinchX, slot.pinchY, 0, 0);
    }
    slot.holding = false;
    slot.pinch.reset();
    slot.swipe.reset();
    slot.present = false;
    slot.vx = slot.vy = 0;
  }
}
