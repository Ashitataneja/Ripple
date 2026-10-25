import { describe, expect, it } from 'vitest';
import { CalibrationRecorder, CoordinateMapper } from '../camera/CoordinateMapper';
import { GestureClassifier, PinchDetector, type HandFrame, type TrackedHand } from '../camera/GestureClassifier';
import { fingerExtended, handOpenness, isValidHand, pinchRatio } from '../camera/landmarkFeatures';
import { OneEuroFilter } from '../camera/OneEuroFilter';
import { CompressionDetector, SwipeDetector } from '../interaction/detectors';
import { makeHand, RecordingSink, type HandPose } from './helpers';

const ASPECT = 4 / 3;
const VIEWPORT = 16 / 9;

function hand(pose: HandPose, handedness = 'Right', score = 0.95): TrackedHand {
  return { landmarks: makeHand(pose), handedness, score };
}

function frame(t: number, ...hands: TrackedHand[]): HandFrame {
  return { hands, timestamp: t, videoAspect: ASPECT };
}

function setup() {
  const sink = new RecordingSink();
  const mapper = new CoordinateMapper(true);
  const classifier = new GestureClassifier(sink, mapper, () => VIEWPORT);
  return { sink, mapper, classifier };
}

/** Feed `n` frames at 30 fps starting at t0 (ms); `pose(i)` gives each frame's hands. */
function feed(classifier: GestureClassifier, t0: number, n: number, pose: (i: number) => TrackedHand[]): number {
  let t = t0;
  for (let i = 0; i < n; i++) {
    classifier.process(frame(t, ...pose(i)));
    t += 33;
  }
  return t;
}

describe('landmark features', () => {
  it('recognises open hands, fists and pinches', () => {
    const open = makeHand({ cx: 0.5, cy: 0.5 });
    const fist = makeHand({ cx: 0.5, cy: 0.5, fist: true });
    const pinch = makeHand({ cx: 0.5, cy: 0.5, pinch: true });
    expect(isValidHand(open)).toBe(true);
    expect(handOpenness(open, ASPECT)).toBeGreaterThan(0.8);
    expect(handOpenness(fist, ASPECT)).toBeLessThan(0.2);
    for (let f = 0; f < 5; f++) expect(fingerExtended(open, f, ASPECT)).toBe(true);
    for (let f = 1; f < 5; f++) expect(fingerExtended(fist, f, ASPECT)).toBe(false);
    expect(pinchRatio(open, ASPECT)).toBeGreaterThan(0.6);
    expect(pinchRatio(pinch, ASPECT)).toBeLessThan(0.15);
  });

  it('rejects invalid or missing landmark data', () => {
    expect(isValidHand(undefined)).toBe(false);
    expect(isValidHand([])).toBe(false);
    const bad = makeHand({ cx: 0.5, cy: 0.5 });
    bad[7] = { x: Number.NaN, y: 0.3, z: 0 };
    expect(isValidHand(bad)).toBe(false);
    const far = makeHand({ cx: 0.5, cy: 0.5 });
    far[3] = { x: 7, y: 0.3, z: 0 };
    expect(isValidHand(far)).toBe(false);
  });
});

describe('coordinate mapping', () => {
  it('mirrors so the hand and its disturbance move the same way', () => {
    const m = new CoordinateMapper(true, { x0: 0, y0: 0, x1: 1, y1: 1 });
    const out = { x: 0, y: 0 };
    // The user's hand on the right of their body appears on the left of the raw camera image.
    m.map(0.2, 0.3, out);
    expect(out.x).toBeCloseTo(0.8);
    expect(out.y).toBeCloseTo(0.3);
    m.mirror = false;
    m.map(0.2, 0.3, out);
    expect(out.x).toBeCloseTo(0.2);
  });

  it('maps the calibrated region to the full screen and clamps outside it', () => {
    const m = new CoordinateMapper(false, { x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.7 });
    const out = { x: 0, y: 0 };
    m.map(0.2, 0.1, out);
    expect([out.x, out.y]).toEqual([0, 0]);
    m.map(0.8, 0.7, out);
    expect(out.x).toBeCloseTo(1);
    expect(out.y).toBeCloseTo(1);
    m.map(0.5, 0.4, out);
    expect(out.x).toBeCloseTo(0.5);
    m.map(-1, 2, out);
    expect(out.x).toBe(-0.05);
    expect(out.y).toBe(1.05);
  });

  it('calibrates from recorded reach and ignores degenerate results', () => {
    const rec = new CalibrationRecorder();
    for (let i = 0; i < 40; i++) rec.add(0.25 + (i % 10) * 0.05, 0.2 + Math.floor(i / 10) * 0.12);
    const rect = rec.result(0)!;
    expect(rect.x0).toBeCloseTo(0.25);
    expect(rect.x1).toBeCloseTo(0.7);
    const m = new CoordinateMapper();
    m.setCalibration(rect);
    expect(m.calibration.x0).toBeCloseTo(0.25);
    const tiny = new CalibrationRecorder();
    for (let i = 0; i < 40; i++) tiny.add(0.5, 0.5);
    expect(tiny.result()).toBeNull();
  });
});

describe('filters and detectors', () => {
  it('smooths jitter at rest but follows fast motion', () => {
    const f = new OneEuroFilter(1.4, 0.6);
    let t = 0;
    let maxDev = 0;
    for (let i = 0; i < 60; i++) {
      const v = f.filter(0.5 + (i % 2 ? 0.01 : -0.01), (t += 1 / 30));
      if (i > 10) maxDev = Math.max(maxDev, Math.abs(v - 0.5));
    }
    expect(maxDev).toBeLessThan(0.006);
    let v = 0;
    for (let i = 0; i < 10; i++) v = f.filter(0.5 + i * 0.05, (t += 1 / 30));
    expect(v).toBeGreaterThan(0.8);
  });

  it('pinch needs a stable hold and releases exactly once despite jitter', () => {
    const p = new PinchDetector();
    expect(p.update(0.1, 0)).toBe('none'); // a single frame is not a pinch
    expect(p.update(0.6, 0.033)).toBe('none');
    expect(p.update(0.1, 0.066)).toBe('none');
    expect(p.update(0.1, 0.1)).toBe('none');
    expect(p.update(0.12, 0.15)).toBe('start');
    // Jitter around the threshold while held: no extra events.
    const events: string[] = [];
    for (let i = 0; i < 20; i++) events.push(p.update(i % 2 ? 0.35 : 0.42, 0.2 + i * 0.033));
    expect(events.every((e) => e === 'none')).toBe(true);
    const out: string[] = [];
    for (let i = 0; i < 10; i++) out.push(p.update(0.55, 1 + i * 0.033));
    expect(out.filter((e) => e === 'release')).toHaveLength(1);
  });

  it('detects a swipe once per stroke with a cooldown', () => {
    const s = new SwipeDetector({ minSpeed: 2, cooldown: 0.5, dominance: 1.3 });
    expect(s.update(1, 0, 0, true).fired).toBe(false);
    expect(s.update(3, 0.2, 0.1, true).fired).toBe(true);
    expect(s.result.dirX).toBeGreaterThan(0.9);
    // Still fast: same stroke, no re-fire.
    expect(s.update(3.5, 0, 0.2, true).fired).toBe(false);
    // Slow down (re-arm), fast again but inside cooldown.
    s.update(0.2, 0, 0.3, true);
    expect(s.update(-3, 0, 0.35, true).fired).toBe(false);
    s.update(0.2, 0, 0.6, true);
    expect(s.update(-3, 0, 0.7, true).fired).toBe(true);
    expect(s.result.dirX).toBeLessThan(-0.9);
    // Mostly vertical motion is not a sideways swipe; disabled detectors never fire.
    s.update(0, 0, 2, true);
    expect(s.update(0.5, 3, 2.1, true).fired).toBe(false);
    s.update(0, 0, 3, true);
    expect(s.update(3, 0, 3.1, false).fired).toBe(false);
  });

  it('emits compression pulses with the sign of the motion', () => {
    const c = new CompressionDetector({ minRate: 0.3, interval: 0.09 });
    let t = 0;
    const rates: number[] = [];
    for (let i = 0; i < 30; i++) {
      const gap = 1 - i * 0.03;
      const r = c.update(0.5 - gap / 2, 0.5, 0.5 + gap / 2, 0.5, (t += 1 / 30));
      if (r !== 0) rates.push(r);
    }
    expect(rates.length).toBeGreaterThan(3);
    expect(rates.length).toBeLessThan(15); // rate limited
    expect(rates.every((r) => r < 0)).toBe(true);
  });
});

describe('gesture classifier', () => {
  it('turns extended fingertips into separate contacts and curled ones into none', () => {
    const { sink, classifier } = setup();
    feed(classifier, 0, 3, () => [hand({ cx: 0.5, cy: 0.45, curled: [3, 4] })]);
    const starts = sink.of('contactStart');
    // Thumb, index and middle are in the water; ring and little are curled.
    expect(new Set(starts.map((s) => s.id)).size).toBe(3);
    expect(starts.every((s) => s.source === 'hand')).toBe(true);
    // Separate fingertips map to separate screen positions.
    const xs = starts.map((s) => s.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.05);
  });

  it('moves the contacts with the hand and does nothing new when the hand is held still', () => {
    const { sink, classifier } = setup();
    let t = feed(classifier, 0, 5, (i) => [hand({ cx: 0.4 + i * 0.01, cy: 0.45 })]);
    expect(sink.count('contactMove')).toBeGreaterThan(5);
    sink.clear();
    t = feed(classifier, t, 20, () => [hand({ cx: 0.44, cy: 0.45 })]);
    // Contacts are maintained (moves at ~zero speed) but no new contacts start and no waves are pushed.
    expect(sink.count('contactStart')).toBe(0);
    expect(sink.count('push')).toBe(0);
    expect(sink.count('compress')).toBe(0);
    const indexId = GestureClassifier.contactId(0, 1);
    const last = sink.of('contactMove').filter((m) => m.id === indexId).slice(-10);
    const spread = Math.max(...last.map((m) => m.x)) - Math.min(...last.map((m) => m.x));
    expect(spread).toBeLessThan(0.01);
  });

  it('pinch, carry and release produces exactly one pebble grab and one release', () => {
    const { sink, classifier } = setup();
    let t = feed(classifier, 0, 4, () => [hand({ cx: 0.5, cy: 0.45 })]);
    t = feed(classifier, t, 12, (i) => [hand({ cx: 0.5 + i * 0.01, cy: 0.45, pinch: true })]);
    expect(sink.count('pebbleGrab')).toBe(1);
    expect(sink.count('pebbleMove')).toBeGreaterThan(5);
    // While pinched, thumb and index are lifted out of the water.
    const ends = sink.of('contactEnd').map((e) => e.id);
    expect(ends).toContain(GestureClassifier.contactId(0, 0));
    expect(ends).toContain(GestureClassifier.contactId(0, 1));
    t = feed(classifier, t, 10, () => [hand({ cx: 0.62, cy: 0.45 })]);
    expect(sink.count('pebbleRelease')).toBe(1);
    const rel = sink.of('pebbleRelease')[0];
    expect(rel.id).toBe(GestureClassifier.pebbleOwner(0));
    expect(Number.isFinite(rel.vx)).toBe(true);
  });

  it('a fast open-hand swipe pushes one broad wave; repeated jitter does not', () => {
    const { sink, classifier } = setup();
    let t = feed(classifier, 0, 5, () => [hand({ cx: 0.7, cy: 0.45 })]);
    t = feed(classifier, t, 8, (i) => [hand({ cx: 0.7 - i * 0.06, cy: 0.45 })]);
    expect(sink.count('push')).toBe(1);
    const push = sink.of('push')[0];
    // Hand moved left in the raw (unmirrored) image → right on the mirrored screen.
    expect(push.dirX).toBeGreaterThan(0);
    expect(Math.abs(push.dirY)).toBeLessThan(Math.abs(push.dirX));
    sink.clear();
    feed(classifier, t, 30, (i) => [hand({ cx: 0.25 + (i % 2) * 0.004, cy: 0.45 })]);
    expect(sink.count('push')).toBe(0);
  });

  it('a fist never pushes waves or dips fingers', () => {
    const { sink, classifier } = setup();
    feed(classifier, 0, 12, (i) => [hand({ cx: 0.7 - i * 0.06, cy: 0.45, fist: true })]);
    expect(sink.count('push')).toBe(0);
    expect(sink.count('contactStart')).toBe(0);
  });

  it('two open hands closing then opening emit compression of both signs', () => {
    const { sink, classifier } = setup();
    let t = feed(classifier, 0, 4, () => [hand({ cx: 0.25, cy: 0.45 }, 'Left'), hand({ cx: 0.75, cy: 0.45 }, 'Right')]);
    t = feed(classifier, t, 12, (i) => [hand({ cx: 0.25 + i * 0.015, cy: 0.45 }, 'Left'), hand({ cx: 0.75 - i * 0.015, cy: 0.45 }, 'Right')]);
    const closing = sink.of('compress');
    expect(closing.length).toBeGreaterThan(0);
    expect(closing.every((c) => c.rate < 0)).toBe(true);
    sink.clear();
    feed(classifier, t, 14, (i) => [hand({ cx: 0.43 - i * 0.015, cy: 0.45 }, 'Left'), hand({ cx: 0.57 + i * 0.015, cy: 0.45 }, 'Right')]);
    const opening = sink.of('compress');
    expect(opening.length).toBeGreaterThan(0);
    expect(opening.some((c) => c.rate > 0)).toBe(true);
  });

  it('ignores low-confidence and malformed hands', () => {
    const { sink, classifier } = setup();
    const broken = hand({ cx: 0.5, cy: 0.5 });
    (broken.landmarks as unknown as { x: number }[])[4].x = Number.NaN;
    feed(classifier, 0, 10, () => [hand({ cx: 0.5, cy: 0.5 }, 'Right', 0.2), broken, { landmarks: [], handedness: 'Left', score: 0.99 }]);
    expect(sink.calls).toHaveLength(0);
    expect(classifier.handsPresent).toBe(0);
  });

  it('survives brief tracking loss, and lets go after a long one', () => {
    const { sink, classifier } = setup();
    let t = feed(classifier, 0, 4, () => [hand({ cx: 0.5, cy: 0.45 })]);
    t = feed(classifier, t, 6, () => [hand({ cx: 0.5, cy: 0.45, pinch: true })]);
    expect(sink.count('pebbleGrab')).toBe(1);
    // 200 ms dropout: within the grace period, nothing is released.
    t = feed(classifier, t, 6, () => []);
    expect(sink.count('pebbleRelease')).toBe(0);
    // Recovery: still pinching, still the same pebble.
    t = feed(classifier, t, 3, () => [hand({ cx: 0.5, cy: 0.45, pinch: true })]);
    expect(sink.count('pebbleGrab')).toBe(1);
    // Long dropout: the pebble is dropped (never left floating) and contacts end.
    t = feed(classifier, t, 15, () => []);
    expect(sink.count('pebbleRelease')).toBe(1);
    expect(classifier.handsPresent).toBe(0);
    // A new hand starts cleanly.
    sink.clear();
    feed(classifier, t, 3, () => [hand({ cx: 0.3, cy: 0.45 })]);
    expect(sink.count('contactStart')).toBe(5);
  });

  it('treats a sudden jump as re-acquisition instead of a wake across the screen', () => {
    const { sink, classifier } = setup();
    let t = feed(classifier, 0, 4, () => [hand({ cx: 0.2, cy: 0.45 })]);
    sink.clear();
    t = feed(classifier, t, 1, () => [hand({ cx: 0.8, cy: 0.45 })]);
    // Old contacts end first, then new ones start at the new position.
    const kinds = sink.calls.map((c) => c.kind);
    expect(kinds.indexOf('contactEnd')).toBeLessThan(kinds.indexOf('contactStart'));
    expect(sink.count('push')).toBe(0);
  });

  it('releases everything when the camera stops', () => {
    const { sink, classifier } = setup();
    let t = feed(classifier, 0, 4, () => [hand({ cx: 0.5, cy: 0.45 })]);
    t = feed(classifier, t, 6, () => [hand({ cx: 0.5, cy: 0.45, pinch: true })]);
    classifier.releaseAll();
    expect(sink.count('pebbleRelease')).toBe(1);
    const starts = new Set(sink.of('contactStart').map((c) => c.id));
    const ends = new Set(sink.of('contactEnd').map((c) => c.id));
    for (const id of starts) expect(ends.has(id)).toBe(true);
    expect(classifier.handsPresent).toBe(0);
    void t;
  });
});

describe('slow trackers', () => {
  it('extend the tracking-loss grace so one missed result does not drop the hand', () => {
    const { sink, classifier } = setup();
    // Results every 250 ms (a slow device).
    let t = 0;
    for (let i = 0; i < 6; i++) classifier.process(frame((t += 250), hand({ cx: 0.5, cy: 0.45, pinch: i > 1 })));
    expect(sink.count('pebbleGrab')).toBe(1);
    classifier.process(frame((t += 250)));
    classifier.process(frame((t += 250), hand({ cx: 0.5, cy: 0.45, pinch: true })));
    expect(sink.count('pebbleRelease')).toBe(0);
    expect(sink.count('pebbleGrab')).toBe(1);
  });
});
