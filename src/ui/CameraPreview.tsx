import { useEffect, useRef } from 'react';

interface CameraPreviewProps {
  video: HTMLVideoElement | null;
  mirrored: boolean;
  onCanvas: (canvas: HTMLCanvasElement | null) => void;
}

/**
 * A small mirrored webcam thumbnail with tracked landmarks, so the user can see what the
 * tracker sees. The video element is owned by the CameraManager; we only mount it here.
 */
export function CameraPreview({ video, mirrored, onCanvas }: CameraPreviewProps) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = holder.current;
    if (!el || !video) return;
    video.className = `camera-preview__video ${mirrored ? 'camera-preview__video--mirrored' : ''}`;
    el.prepend(video);
    return () => {
      if (video.parentElement === el) el.removeChild(video);
    };
  }, [video, mirrored]);

  useEffect(() => {
    onCanvas(canvas.current);
    return () => onCanvas(null);
  }, [onCanvas]);

  return (
    <div className="camera-preview" ref={holder} aria-label="Camera preview with tracked hand points">
      <canvas ref={canvas} width={192} height={144} className="camera-preview__overlay" />
    </div>
  );
}
