/**
 * Procedural water sound with the Web Audio API — no audio files.
 * Created only after a user gesture (autoplay policy). Every sound has an envelope and the
 * whole graph passes through a gentle compressor, so stacked events never get loud.
 */
export class AudioController {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private white: AudioBuffer | null = null;
  private brown: AudioBuffer | null = null;
  private dragGain: GainNode | null = null;
  private dragFilter: BiquadFilterNode | null = null;
  private ambienceSources: AudioScheduledSourceNode[] = [];
  private dripTimer: ReturnType<typeof setTimeout> | null = null;
  private voices = 0;
  private lastDroplet = 0;
  private lastDragTarget = -1;
  private _muted = false;
  private readonly maxVoices = 14;

  get muted(): boolean {
    return this._muted;
  }

  get ready(): boolean {
    return this.ctx !== null;
  }

  /** Must be called from a user gesture. Safe to call more than once. */
  async init(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => undefined);
      return;
    }
    const Ctor: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.white = makeNoise(ctx, 2, 'white');
    this.brown = makeNoise(ctx, 6, 'brown');

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.25;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(comp);
    this.master.gain.setTargetAtTime(this._muted ? 0 : 0.9, ctx.currentTime, 0.6);

    this.startAmbience();
    this.startDrag();
    this.scheduleDrip();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : 0.9, this.ctx.currentTime, 0.08);
  }

  /** Pebble impact: a light plink for gentle drops, a deeper splash for throws. */
  impact(strength: number): void {
    const s = clamp(strength, 0, 1.6);
    if (s < 0.75) this.plink(0.06 + s * 0.16, 1);
    else this.splash(s);
  }

  /** Broad wave: a low, brief swell. */
  swell(strength: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.brown || !this.claimVoice(1.6)) return;
    const t = ctx.currentTime;
    const s = clamp(strength, 0, 1);
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    src.playbackRate.value = 0.9;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.8;
    lp.frequency.setValueAtTime(180, t);
    lp.frequency.linearRampToValueAtTime(520 + 300 * s, t + 0.28);
    lp.frequency.exponentialRampToValueAtTime(160, t + 1.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16 + 0.22 * s, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t, Math.random() * 3);
    src.stop(t + 1.6);
  }

  /** Two-hand squeeze: a softer variant of the swell. */
  squeeze(strength: number): void {
    if (Math.random() < 0.35) this.swell(strength * 0.4);
  }

  /** Splash droplets landing back on the surface. Rate limited. */
  droplet(size: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - this.lastDroplet < 0.045) return;
    this.lastDroplet = now;
    this.plink(0.015 + size * 0.04, 1.8 + Math.random());
  }

  /** Called every frame with the fastest wake speed. Drives one continuous swish, never per-frame sounds. */
  dragSpeed(speed: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.dragGain || !this.dragFilter) return;
    const target = speed < 0.05 ? 0 : Math.min(0.14, 0.025 + speed * 0.05);
    if (Math.abs(target - this.lastDragTarget) < 0.004) return;
    this.lastDragTarget = target;
    const t = ctx.currentTime;
    this.dragGain.gain.setTargetAtTime(target, t, target > 0 ? 0.06 : 0.25);
    this.dragFilter.frequency.setTargetAtTime(500 + Math.min(1800, speed * 700), t, 0.1);
  }

  /** A soft touch of the water. */
  touch(): void {
    this.plink(0.03, 1.3);
  }

  dispose(): void {
    if (this.dripTimer !== null) clearTimeout(this.dripTimer);
    this.dripTimer = null;
    for (const s of this.ambienceSources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.ambienceSources = [];
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.dragGain = null;
    this.dragFilter = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }

  // ----------------------------------------------------------------------------------------

  /** A water drop: a short sine whose pitch rises (the resonance of the trapped air bubble). */
  private plink(volume: number, pitch: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.claimVoice(0.3)) return;
    const t = ctx.currentTime + 0.003;
    const f0 = (520 + Math.random() * 380) * pitch;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * (1.9 + Math.random() * 0.5), t + 0.07);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.2);
    this.noiseBurst(volume * 0.35, 2600 * pitch, 2.5, 0.03, t);
  }

  private splash(strength: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + 0.003;
    const s = clamp(strength, 0.75, 1.6);
    this.noiseBurst(0.12 + 0.12 * s, 1400, 0.7, 0.32 + 0.1 * s, t);
    this.noiseBurst(0.2 + 0.1 * s, 260, 0.9, 0.16, t, 'lowpass');
    this.plink(0.12 + 0.05 * s, 0.6);
    const drops = 2 + Math.round(s * 2);
    for (let i = 0; i < drops; i++) {
      setTimeout(() => this.plink(0.02 + Math.random() * 0.03, 1.4 + Math.random()), 120 + Math.random() * 380);
    }
  }

  private noiseBurst(volume: number, freq: number, q: number, duration: number, t: number, type: BiquadFilterType = 'bandpass'): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.white || !this.claimVoice(duration + 0.05)) return;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + duration + 0.02);
  }

  private startAmbience(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.brown) return;
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    // Slow breathing of the ambience.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.015;
    lfo.connect(lfoGain).connect(g.gain);
    src.connect(lp).connect(g).connect(this.master);
    src.start();
    lfo.start();
    this.ambienceSources.push(src, lfo);
  }

  private startDrag(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.white) return;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    src.loop = true;
    this.dragFilter = ctx.createBiquadFilter();
    this.dragFilter.type = 'bandpass';
    this.dragFilter.frequency.value = 700;
    this.dragFilter.Q.value = 0.6;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    this.dragGain = ctx.createGain();
    this.dragGain.gain.value = 0;
    src.connect(this.dragFilter).connect(lp).connect(this.dragGain).connect(this.master);
    src.start();
    this.ambienceSources.push(src);
  }

  /** Very quiet, occasional distant drips keep the pond alive when untouched. */
  private scheduleDrip(): void {
    this.dripTimer = setTimeout(() => {
      this.plink(0.008 + Math.random() * 0.01, 1.2 + Math.random() * 0.8);
      this.scheduleDrip();
    }, 4000 + Math.random() * 7000);
  }

  private claimVoice(seconds: number): boolean {
    if (this.voices >= this.maxVoices) return false;
    this.voices++;
    setTimeout(() => {
      this.voices--;
    }, seconds * 1000 + 50);
    return true;
  }
}

function makeNoise(ctx: AudioContext, seconds: number, kind: 'white' | 'brown'): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'white') data[i] = w * 0.5;
    else {
      last = (last + 0.02 * w) / 1.02;
      data[i] = last * 3.5;
    }
  }
  return buffer;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
