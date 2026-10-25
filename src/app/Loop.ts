export type FrameCallback = (dt: number, now: number) => void;

export interface FrameScheduler {
  request(cb: (now: number) => void): number;
  cancel(handle: number): void;
}

const browserScheduler: FrameScheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (h) => cancelAnimationFrame(h),
};

/**
 * A single requestAnimationFrame loop. start() while running is a no-op, so remounts,
 * restarts and React StrictMode can never create a second loop.
 */
export class Loop {
  private handle: number | null = null;
  private last = 0;
  private generation = 0;

  constructor(
    private readonly callback: FrameCallback,
    private readonly scheduler: FrameScheduler = browserScheduler,
  ) {}

  get running(): boolean {
    return this.handle !== null;
  }

  start(): void {
    if (this.handle !== null) return;
    const generation = ++this.generation;
    this.last = -1;
    const frame = (now: number) => {
      if (generation !== this.generation) return;
      const dt = this.last < 0 ? 1 / 60 : Math.min(0.1, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      this.handle = this.scheduler.request(frame);
      this.callback(dt, now);
    };
    this.handle = this.scheduler.request(frame);
  }

  stop(): void {
    this.generation++;
    if (this.handle !== null) this.scheduler.cancel(this.handle);
    this.handle = null;
  }
}
