import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInteractionState } from '../app/interactionState';
import { DisturbanceQueue } from '../interaction/DisturbanceQueue';
import { InteractionController, type SplashEffects } from '../interaction/InteractionController';
import { PointerController, type PointerLike } from '../interaction/PointerController';
import { DisturbanceKind } from '../water/disturbance';
import { linearMapping, RecordingSink } from './helpers';

function makeController() {
  const state = createInteractionState();
  const queue = new DisturbanceQueue(4096);
  const effects: SplashEffects & { splashes: number; bubbles: number } = {
    splashes: 0,
    bubbles: 0,
    splash() {
      this.splashes++;
    },
    bubble() {
      this.bubbles++;
    },
  };
  const impacts: number[] = [];
  const controller = new InteractionController(state, queue, linearMapping(), effects, { onImpact: (s) => impacts.push(s) });
  return { state, queue, controller, effects, impacts };
}

function kinds(queue: DisturbanceQueue) {
  return queue.items.slice(0, queue.count).map((d) => d.kind);
}

/** Moves contact `id` from x0 to x1 over `seconds`, at `fps`, returning the number of wake disturbances. */
function sweep(fps: number, seconds = 0.5) {
  const { controller, queue } = makeController();
  controller.contactStart(1, 0.2, 0.5, 'pointer');
  queue.clear();
  const frames = Math.round(fps * seconds);
  let wakes = 0;
  for (let i = 1; i <= frames; i++) {
    controller.contactMove(1, 0.2 + (0.5 * i) / frames, 0.5);
    controller.update(1 / fps, i / fps);
    wakes += kinds(queue).filter((k) => k === DisturbanceKind.Wake).length;
    queue.clear();
  }
  return wakes;
}

describe('interaction controller', () => {
  it('a touch dips the water at the mapped position', () => {
    const { controller, queue } = makeController();
    controller.contactStart(1, 0.25, 0.4, 'pointer');
    expect(queue.count).toBe(1);
    const d = queue.items[0];
    expect(d.kind).toBe(DisturbanceKind.Drop);
    expect(d.strength).toBeLessThan(0);
    expect(d.x).toBeCloseTo(0.25);
    expect(d.y).toBeCloseTo(0.6);
  });

  it('pointer and hand contacts drive the same disturbance pipeline', () => {
    const { controller, queue } = makeController();
    controller.contactStart(1, 0.3, 0.5, 'pointer');
    controller.contactStart(2, 0.7, 0.5, 'hand');
    expect(kinds(queue)).toEqual([DisturbanceKind.Drop, DisturbanceKind.Drop]);
  });

  it('drags leave a continuous wake whose density does not depend on frame rate', () => {
    const at30 = sweep(30);
    const at120 = sweep(120);
    expect(at30).toBeGreaterThan(20);
    expect(Math.abs(at30 - at120) / at120).toBeLessThan(0.35);
  });

  it('faster movement makes broader, stronger wakes', () => {
    const measure = (seconds: number) => {
      const { controller, queue } = makeController();
      controller.contactStart(1, 0.2, 0.5, 'pointer');
      queue.clear();
      let maxR = 0;
      let maxS = 0;
      const frames = Math.round(60 * seconds);
      for (let i = 1; i <= frames; i++) {
        controller.contactMove(1, 0.2 + (0.6 * i) / frames, 0.5);
        controller.update(1 / 60, i / 60);
        for (let k = 0; k < queue.count; k++) {
          maxR = Math.max(maxR, queue.items[k].radius);
          maxS = Math.max(maxS, queue.items[k].strength);
        }
        queue.clear();
      }
      return { maxR, maxS };
    };
    const slow = measure(3);
    const fast = measure(0.25);
    expect(fast.maxR).toBeGreaterThan(slow.maxR);
    expect(fast.maxS).toBeGreaterThan(slow.maxS);
  });

  it('holding still adds no new energy', () => {
    const { controller, queue } = makeController();
    controller.contactStart(1, 0.5, 0.5, 'hand');
    for (let i = 0; i < 10; i++) {
      controller.contactMove(1, 0.5 + i * 0.01, 0.5);
      controller.update(1 / 60, i / 60);
    }
    for (let i = 0; i < 30; i++) controller.update(1 / 60, (10 + i) / 60);
    queue.clear();
    for (let i = 0; i < 60; i++) {
      controller.contactMove(1, 0.59 + (i % 2) * 0.0002, 0.5); // tracker jitter
      controller.update(1 / 60, (40 + i) / 60);
    }
    expect(queue.count).toBe(0);
  });

  it('several contacts each make their own wake', () => {
    const { controller, queue } = makeController();
    for (let id = 1; id <= 4; id++) controller.contactStart(id, 0.2 * id, 0.3, 'hand');
    queue.clear();
    for (let i = 1; i <= 20; i++) {
      for (let id = 1; id <= 4; id++) controller.contactMove(id, 0.2 * id, 0.3 + i * 0.01);
      controller.update(1 / 30, i / 30);
    }
    const xs = new Set(queue.items.slice(0, queue.count).map((d) => Math.round(d.x * 5)));
    expect(xs.size).toBe(4);
  });

  it('a tracking jump does not draw a wake across the pond', () => {
    const { controller, queue } = makeController();
    controller.contactStart(1, 0.05, 0.5, 'hand');
    queue.clear();
    controller.contactMove(1, 0.95, 0.5);
    for (let i = 0; i < 5; i++) controller.update(1, i);
    expect(queue.count).toBe(0);
  });

  it('a released pebble falls, makes exactly one impact, splashes and sinks out of sight', () => {
    const { controller, queue, state, effects, impacts } = makeController();
    controller.pebbleGrab(7, 0.5, 0.5);
    controller.pebbleGrab(7, 0.5, 0.5); // a duplicate grab is ignored
    expect(state.pebbles.filter((p) => p.phase !== 'idle')).toHaveLength(1);
    for (let i = 0; i < 20; i++) controller.update(1 / 60, i / 60);
    expect(state.pebbles[0].phase).toBe('held');
    expect(state.pebbles[0].y).toBeGreaterThan(0.1);
    controller.pebbleRelease(7, 0.6, 0.5, 0, 0);
    controller.pebbleRelease(7, 0.6, 0.5, 0, 0); // second release: nothing held any more
    queue.clear();
    let t = 20;
    for (let i = 0; i < 600; i++) controller.update(1 / 60, t++ / 60);
    expect(impacts).toHaveLength(1);
    expect(effects.splashes).toBe(1);
    expect(effects.bubbles).toBeGreaterThan(0);
    expect(kinds(queue).filter((k) => k === DisturbanceKind.Impact)).toHaveLength(1);
    const impact = queue.items.find((d) => d.kind === DisturbanceKind.Impact)!;
    expect(impact.x).toBeCloseTo(0.6, 1);
    // Never left floating.
    expect(state.pebbles.every((p) => p.phase === 'idle')).toBe(true);
  });

  it('a fast throw hits harder than a gentle drop', () => {
    const strike = (vx: number) => {
      const { controller, impacts } = makeController();
      controller.pebbleGrab(1, 0.5, 0.5);
      for (let i = 0; i < 20; i++) controller.update(1 / 60, i / 60);
      controller.pebbleRelease(1, 0.5, 0.5, vx, 0);
      for (let i = 0; i < 120; i++) controller.update(1 / 60, (20 + i) / 60);
      return impacts[0];
    };
    expect(strike(3)).toBeGreaterThan(strike(0) * 1.5);
  });

  it('pushes and compressions become directional travelling waves', () => {
    const { controller, queue } = makeController();
    controller.push(0.5, 0.5, 1, 0, 3);
    const push = queue.items[0];
    expect(push.kind).toBe(DisturbanceKind.Push);
    expect(push.dirX).toBeGreaterThan(0.99);
    queue.clear();
    controller.compress(0.3, 0.5, 0.7, 0.5, -1);
    const ds = queue.items.slice(0, queue.count);
    const pushes = ds.filter((d) => d.kind === DisturbanceKind.Push);
    expect(pushes).toHaveLength(2);
    // Closing: each hand's wave travels towards the other.
    const left = pushes.find((d) => d.x < 0.5)!;
    const right = pushes.find((d) => d.x > 0.5)!;
    expect(left.dirX).toBeGreaterThan(0);
    expect(right.dirX).toBeLessThan(0);
    queue.clear();
    controller.compress(0.3, 0.5, 0.7, 0.5, 1);
    const opening = queue.items.slice(0, queue.count).filter((d) => d.kind === DisturbanceKind.Push);
    expect(opening.find((d) => d.x < 0.5)!.dirX).toBeLessThan(0);
  });

  it('ignores invalid input', () => {
    const { controller, queue } = makeController();
    controller.contactStart(1, Number.NaN, 0.5, 'hand');
    controller.push(0.5, 0.5, 0, 0, 3);
    controller.push(0.5, 0.5, Number.NaN, 1, 3);
    controller.compress(0.5, 0.5, 0.5, 0.5, -1);
    controller.pebbleGrab(1, Infinity, 0);
    expect(queue.count).toBe(0);
  });

  it('reset clears contacts, pebbles and pending disturbances', () => {
    const { controller, queue, state } = makeController();
    controller.contactStart(1, 0.5, 0.5, 'pointer');
    controller.pebbleGrab(2, 0.5, 0.5);
    controller.reset();
    expect(queue.count).toBe(0);
    expect(state.contacts.some((c) => c.active)).toBe(false);
    expect(state.pebbles.every((p) => p.phase === 'idle')).toBe(true);
  });
});

describe('pointer and touch fallback', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const rect = () => ({ left: 0, top: 0, width: 1000, height: 500 });
  let ts = 0;
  const ev = (pointerId: number, x: number, y: number, pointerType = 'mouse', advance = 16): PointerLike => {
    ts += advance;
    return { pointerId, pointerType, clientX: x, clientY: y, timeStamp: ts, button: 0 };
  };

  function make() {
    const sink = new RecordingSink();
    const pc = new PointerController(sink, rect, (cb) => cb());
    return { sink, pc };
  }

  it('click → one touch that dips and lifts', () => {
    const { sink, pc } = make();
    pc.onDown(ev(1, 500, 250));
    pc.onUp(ev(1, 500, 250));
    expect(sink.count('contactStart')).toBe(1);
    expect(sink.count('contactEnd')).toBe(1);
    expect(sink.of('contactStart')[0]).toMatchObject({ x: 0.5, y: 0.5, source: 'pointer' });
    vi.advanceTimersByTime(1000);
    expect(sink.count('pebbleGrab')).toBe(0);
  });

  it('drag → contact moves (wake); a fast flick also pushes a broad wave', () => {
    const { sink, pc } = make();
    pc.onDown(ev(1, 100, 250));
    for (let i = 1; i <= 10; i++) pc.onMove(ev(1, 100 + i * 8, 250, 'mouse', 30));
    expect(sink.count('contactMove')).toBe(10);
    expect(sink.count('push')).toBe(0);
    for (let i = 1; i <= 8; i++) pc.onMove(ev(1, 180 + i * 60, 250, 'mouse', 10));
    expect(sink.count('push')).toBe(1);
    // Direction is in normalised screen units (x scaled by 1/aspect); it must point right.
    const push = sink.of('push')[0];
    expect(push.dirX).toBeGreaterThan(0);
    expect(Math.abs(push.dirY)).toBeLessThan(push.dirX * 0.1);
    pc.onUp(ev(1, 660, 250));
    vi.advanceTimersByTime(1000);
    expect(sink.count('pebbleGrab')).toBe(0);
  });

  it('press and hold → pebble; release → exactly one drop with release velocity', () => {
    const { sink, pc } = make();
    pc.onDown(ev(1, 500, 250));
    vi.advanceTimersByTime(450);
    expect(sink.count('pebbleGrab')).toBe(1);
    expect(sink.count('contactEnd')).toBe(1); // the finger lifted out, holding the pebble
    pc.onMove(ev(1, 520, 250));
    pc.onMove(ev(1, 560, 250));
    expect(sink.count('pebbleMove')).toBe(2);
    pc.onUp(ev(1, 600, 250));
    pc.onCancel(ev(1, 600, 250));
    expect(sink.count('pebbleRelease')).toBe(1);
    expect(sink.of('pebbleRelease')[0].vx).toBeGreaterThan(0);
  });

  it('a cancelled pointer still lets go of its pebble', () => {
    const { sink, pc } = make();
    pc.onDown(ev(1, 500, 250, 'touch'));
    vi.advanceTimersByTime(450);
    pc.onCancel(ev(1, 500, 250, 'touch'));
    expect(sink.of('pebbleRelease')).toHaveLength(1);
    expect(sink.of('pebbleRelease')[0]).toMatchObject({ vx: 0, vy: 0 });
  });

  it('two touches pinching together and apart → compression both ways', () => {
    const { sink, pc } = make();
    pc.onDown(ev(1, 200, 250, 'touch'));
    pc.onDown(ev(2, 800, 250, 'touch', 0));
    for (let i = 1; i <= 15; i++) {
      pc.onMove(ev(1, 200 + i * 15, 250, 'touch', 16));
      pc.onMove(ev(2, 800 - i * 15, 250, 'touch', 0));
    }
    const closing = sink.of('compress');
    expect(closing.length).toBeGreaterThan(0);
    expect(closing.every((c) => c.rate < 0)).toBe(true);
    for (let i = 1; i <= 15; i++) {
      pc.onMove(ev(1, 425 - i * 15, 250, 'touch', 16));
      pc.onMove(ev(2, 575 + i * 15, 250, 'touch', 0));
    }
    expect(sink.of('compress').some((c) => c.rate > 0)).toBe(true);
    // Both fingers also touch the water.
    expect(sink.count('contactStart')).toBe(2);
  });

  it('detach cancels every active pointer', () => {
    const { sink, pc } = make();
    pc.onDown(ev(1, 100, 100));
    pc.onDown(ev(2, 300, 100, 'touch'));
    pc.detach();
    expect(pc.activeCount).toBe(0);
    expect(sink.count('contactEnd')).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(sink.count('pebbleGrab')).toBe(0);
  });
});
