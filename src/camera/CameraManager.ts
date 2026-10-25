/**
 * Owns the webcam stream. Frames never leave the browser: the stream is attached to a local
 * <video> element that the hand tracker reads from.
 */

export type CameraErrorKind = 'denied' | 'not-found' | 'in-use' | 'unsupported' | 'disconnected' | 'unknown';

export class CameraError extends Error {
  constructor(
    readonly kind: CameraErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

export interface CameraManagerOptions {
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'> | undefined;
  createVideo?: () => HTMLVideoElement;
}

export class CameraManager {
  private stream: MediaStream | null = null;
  private pending: Promise<HTMLVideoElement> | null = null;
  private generation = 0;
  private videoEl: HTMLVideoElement | null = null;
  private readonly onTrackEnded = () => {
    if (!this.stream) return;
    this.stop();
    this.onDisconnect?.();
  };
  /** Called when the camera is unplugged or the stream is ended by the OS / browser. */
  onDisconnect: (() => void) | null = null;

  constructor(private readonly options: CameraManagerOptions = {}) {}

  get video(): HTMLVideoElement | null {
    return this.videoEl;
  }

  get active(): boolean {
    return this.stream !== null;
  }

  get aspect(): number {
    const v = this.videoEl;
    return v && v.videoWidth > 0 && v.videoHeight > 0 ? v.videoWidth / v.videoHeight : 4 / 3;
  }

  /** Requests the camera. Safe to call repeatedly; concurrent calls share one request. */
  start(): Promise<HTMLVideoElement> {
    if (this.stream && this.videoEl) return Promise.resolve(this.videoEl);
    if (this.pending) return this.pending;
    const generation = ++this.generation;
    this.pending = this.open(generation).finally(() => {
      if (this.generation === generation) this.pending = null;
    });
    return this.pending;
  }

  /** Stops every media track and detaches the stream. Idempotent. */
  stop(): void {
    this.generation++;
    this.pending = null;
    const stream = this.stream;
    this.stream = null;
    if (stream) {
      for (const track of stream.getTracks()) {
        track.removeEventListener('ended', this.onTrackEnded);
        track.stop();
      }
    }
    if (this.videoEl) {
      try {
        this.videoEl.pause();
      } catch {
        /* ignore */
      }
      this.videoEl.srcObject = null;
    }
  }

  private async open(generation: number): Promise<HTMLVideoElement> {
    const md = 'mediaDevices' in this.options ? this.options.mediaDevices : typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getUserMedia !== 'function') {
      throw new CameraError('unsupported', 'Camera access is not available in this browser (a secure context such as https:// or localhost is required).');
    }
    let stream: MediaStream;
    try {
      stream = await md.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
      });
    } catch (err) {
      throw toCameraError(err);
    }
    if (generation !== this.generation) {
      // stop() was called while the permission prompt was open.
      for (const t of stream.getTracks()) t.stop();
      throw new CameraError('unknown', 'Camera start was cancelled.');
    }
    this.stream = stream;
    for (const track of stream.getTracks()) track.addEventListener('ended', this.onTrackEnded);

    const video = this.videoEl ?? this.createVideo();
    this.videoEl = video;
    video.srcObject = stream;
    try {
      await video.play();
    } catch (err) {
      if (generation !== this.generation) throw new CameraError('unknown', 'Camera start was cancelled.');
      this.stop();
      throw new CameraError('unknown', `The camera stream could not be played: ${(err as Error)?.message ?? err}`);
    }
    if (generation !== this.generation) throw new CameraError('unknown', 'Camera start was cancelled.');
    return video;
  }

  private createVideo(): HTMLVideoElement {
    if (this.options.createVideo) return this.options.createVideo();
    const v = document.createElement('video');
    v.playsInline = true;
    v.muted = true;
    v.autoplay = true;
    v.setAttribute('aria-hidden', 'true');
    return v;
  }
}

export function toCameraError(err: unknown): CameraError {
  if (err instanceof CameraError) return err;
  const name = (err as { name?: string } | null)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new CameraError('denied', 'Camera permission was denied. Allow camera access in the browser’s site settings to use your hands.');
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new CameraError('not-found', 'No camera was found.');
    case 'NotSupportedError':
      return new CameraError('unsupported', 'Camera access is not supported here. Open the page over https:// or http://localhost in a current browser.');
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new CameraError('in-use', 'The camera is in use by another application or could not be started.');
    default:
      return new CameraError('unknown', `The camera could not be started${(err as Error)?.message ? `: ${(err as Error).message}` : '.'}`);
  }
}
