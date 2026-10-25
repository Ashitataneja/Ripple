import type * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Loop, type FrameScheduler } from '../app/Loop';
import { CameraError, CameraManager, toCameraError } from '../camera/CameraManager';
import { HandTracker } from '../camera/HandTracker';
import { DisturbanceQueue } from '../interaction/DisturbanceQueue';
import { PerformanceMonitor, QUALITY_LEVELS } from '../performance/PerformanceMonitor';
import { DisturbanceKind } from '../water/disturbance';
import { WaterSimulation } from '../water/WaterSimulation';

// ------------------------------------------------------------------ fakes

class FakeTrack extends EventTarget {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

function fakeStream(n = 1) {
  const tracks = Array.from({ length: n }, () => new FakeTrack());
  return { tracks, stream: { getTracks: () => tracks } as unknown as MediaStream };
}

function fakeVideo() {
  return {
    srcObject: null as unknown,
    paused: true,
    play: vi.fn(async function (this: { paused: boolean }) {
      this.paused = false;
    }),
    pause: vi.fn(),
  } as unknown as HTMLVideoElement;
}

class ManualScheduler implements FrameScheduler {
  private next = 1;
  pending = new Map<number, (now: number) => void>();
  request(cb: (now: number) => void) {
    const id = this.next++;
    this.pending.set(id, cb);
    return id;
  }
  cancel(id: number) {
    this.pending.delete(id);
  }
  tick(now: number) {
    const cbs = [...this.pending.values()];
    this.pending.clear();
    for (const cb of cbs) cb(now);
  }
}

// ------------------------------------------------------------------ camera

describe('camera manager', () => {
  it('stops every media track on shutdown and detaches the stream', async () => {
    const { tracks, stream } = fakeStream(2);
    const video = fakeVideo();
    const cam = new CameraManager({ mediaDevices: { getUserMedia: vi.fn(async () => stream) }, createVideo: () => video });
    await cam.start();
    expect(cam.active).toBe(true);
    expect(video.srcObject).toBe(stream);
    cam.stop();
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(video.srcObject).toBeNull();
    expect(cam.active).toBe(false);
    cam.stop(); // idempotent
  });

  it('shares one request between concurrent starts', async () => {
    const { stream } = fakeStream();
    const getUserMedia = vi.fn(async () => stream);
    const cam = new CameraManager({ mediaDevices: { getUserMedia }, createVideo: fakeVideo });
    const [a, b] = await Promise.all([cam.start(), cam.start()]);
    expect(a).toBe(b);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await cam.start();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    cam.stop();
  });

  it('releases a stream that arrives after stop() was called', async () => {
    const { tracks, stream } = fakeStream();
    let resolve!: (s: MediaStream) => void;
    const cam = new CameraManager({ mediaDevices: { getUserMedia: () => new Promise((r) => (resolve = r)) }, createVideo: fakeVideo });
    const pending = cam.start();
    cam.stop();
    resolve(stream);
    await expect(pending).rejects.toBeInstanceOf(CameraError);
    expect(tracks[0].stopped).toBe(true);
    expect(cam.active).toBe(false);
  });

  it('reports permission denial and missing devices clearly', async () => {
    const denied = new CameraManager({ mediaDevices: { getUserMedia: async () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })) }, createVideo: fakeVideo });
    await expect(denied.start()).rejects.toMatchObject({ kind: 'denied' });
    expect(toCameraError({ name: 'NotFoundError' }).kind).toBe('not-found');
    expect(toCameraError({ name: 'NotReadableError' }).kind).toBe('in-use');
    const none = new CameraManager({ mediaDevices: undefined, createVideo: fakeVideo });
    await expect(none.start()).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('notices a disconnected camera', async () => {
    const { tracks, stream } = fakeStream();
    const cam = new CameraManager({ mediaDevices: { getUserMedia: async () => stream }, createVideo: fakeVideo });
    const onDisconnect = vi.fn();
    cam.onDisconnect = onDisconnect;
    await cam.start();
    tracks[0].dispatchEvent(new Event('ended'));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(cam.active).toBe(false);
  });
});

// ------------------------------------------------------------------ hand tracker loop

describe('hand tracker scheduling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const tracker = new HandTracker({ modelUrl: '/m', wasmBaseUrl: '/w', targetHz: 30 });
    const detectForVideo = vi.fn(() => ({ landmarks: [], handedness: [], handednesses: [], worldLandmarks: [] }));
    const close = vi.fn();
    (tracker as unknown as { landmarker: unknown }).landmarker = { detectForVideo, close };
    const callbacks = new Map<number, () => void>();
    let id = 0;
    const video = {
      readyState: 4,
      videoWidth: 640,
      videoHeight: 480,
      requestVideoFrameCallback: (cb: () => void) => {
        callbacks.set(++id, cb);
        return id;
      },
      cancelVideoFrameCallback: (h: number) => callbacks.delete(h),
    } as unknown as HTMLVideoElement;
    const fire = () => {
      const cbs = [...callbacks.entries()];
      callbacks.clear();
      for (const [, cb] of cbs) cb();
    };
    return { tracker, detectForVideo, close, callbacks, video, fire };
  }

  it('restarting never creates a second detection loop', () => {
    const { tracker, callbacks, video, fire, detectForVideo } = setup();
    const onFrame = vi.fn();
    tracker.start(video, onFrame);
    tracker.start(video, onFrame);
    tracker.start(video, onFrame);
    expect(callbacks.size).toBe(1);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(40);
      fire();
      expect(callbacks.size).toBe(1);
    }
    expect(detectForVideo.mock.calls.length).toBeLessThanOrEqual(5);
    expect(onFrame).toHaveBeenCalled();
  });

  it('timestamps passed to the model are strictly increasing', () => {
    const { tracker, video, fire, detectForVideo } = setup();
    tracker.start(video, () => undefined);
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(40);
      fire();
    }
    const ts = detectForVideo.mock.calls.map((c) => (c as unknown as [unknown, number])[1]);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
  });

  it('stop cancels callbacks and timers; dispose closes the model', () => {
    const { tracker, callbacks, video, fire, detectForVideo, close } = setup();
    tracker.start(video, () => undefined);
    tracker.stop();
    expect(callbacks.size).toBe(0);
    const calls = detectForVideo.mock.calls.length;
    vi.advanceTimersByTime(2000);
    fire();
    expect(detectForVideo.mock.calls.length).toBe(calls);
    tracker.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    expect(tracker.ready).toBe(false);
  });
});

// ------------------------------------------------------------------ render loop

describe('render loop', () => {
  it('start is idempotent and stop really stops', () => {
    const sched = new ManualScheduler();
    const frames: number[] = [];
    const loop = new Loop((dt) => frames.push(dt), sched);
    loop.start();
    loop.start();
    expect(sched.pending.size).toBe(1);
    sched.tick(16);
    sched.tick(32);
    expect(frames).toHaveLength(2);
    loop.stop();
    expect(loop.running).toBe(false);
    sched.tick(48);
    expect(frames).toHaveLength(2);
  });

  it('restarts cleanly with a single loop and clamps long gaps', () => {
    const sched = new ManualScheduler();
    const frames: number[] = [];
    const loop = new Loop((dt) => frames.push(dt), sched);
    loop.start();
    sched.tick(0);
    loop.stop();
    loop.start();
    loop.start();
    expect(sched.pending.size).toBe(1);
    sched.tick(10_000);
    sched.tick(20_000);
    expect(frames.every((dt) => dt <= 0.1)).toBe(true);
  });
});

// ------------------------------------------------------------------ performance

describe('performance monitor', () => {
  it('steps quality down when frames are slow and back up with hysteresis', () => {
    const perf = new PerformanceMonitor(0, { settleTime: 0.5, downgradeAfter: 1, upgradeAfter: 2 });
    const changes: number[] = [];
    perf.onChange = (lvl) => changes.push(lvl);
    for (let i = 0; i < 200; i++) perf.sample(0.035);
    expect(perf.level).toBeGreaterThan(0);
    const low = perf.level;
    for (let i = 0; i < 1200; i++) perf.sample(0.008);
    expect(perf.level).toBeLessThan(low);
    expect(changes.length).toBeGreaterThan(1);
    expect(perf.level).toBeLessThan(QUALITY_LEVELS.length);
  });

  it('ignores hidden-tab gaps and stays pinned when not adaptive', () => {
    const perf = new PerformanceMonitor(1);
    perf.adaptive = false;
    for (let i = 0; i < 500; i++) perf.sample(0.05);
    perf.sample(5);
    expect(perf.level).toBe(1);
  });
});

// ------------------------------------------------------------------ simulation resources

describe('simulation resources (CPU fallback)', () => {
  const renderer = { extensions: { has: () => false } } as unknown as THREE.WebGLRenderer;

  it('advances with a fixed timestep and consumes the queue', () => {
    const sim = new WaterSimulation(renderer, { resolution: 128, boundary: 'absorb', forceCpu: true });
    expect(sim.kind).toBe('cpu');
    sim.setDomain(2, 1);
    expect(sim.gridWidth).toBe(128);
    expect(sim.gridHeight).toBe(64);
    const q = new DisturbanceQueue();
    q.push(DisturbanceKind.Drop, 0.5, 0.5, 0.05, 0.5);
    sim.update(1 / 60, q);
    expect(q.count).toBe(0);
    let steps = 0;
    for (let i = 0; i < 60; i++) {
      sim.update(1 / 60, q);
      steps += sim.stepsLastFrame;
    }
    // ~1 simulated second at the resolution-scaled step rate (180 · 128/512 = 45 steps/s).
    expect(steps).toBeGreaterThanOrEqual(43);
    expect(steps).toBeLessThanOrEqual(47);
    sim.dispose();
  });

  it('disposes textures it replaces and the one it holds', () => {
    const sim = new WaterSimulation(renderer, { resolution: 128, boundary: 'absorb', forceCpu: true });
    sim.setDomain(1, 1);
    const first = sim.texture;
    const disposed = vi.fn();
    first.addEventListener('dispose', disposed);
    sim.setResolution(96);
    expect(sim.texture).not.toBe(first);
    expect(disposed).toHaveBeenCalledTimes(1);
    const second = sim.texture;
    const disposed2 = vi.fn();
    second.addEventListener('dispose', disposed2);
    sim.dispose();
    expect(disposed2).toHaveBeenCalledTimes(1);
  });
});
