import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CameraPreview } from '../ui/CameraPreview';
import { ErrorState } from '../ui/ErrorState';
import { Hint } from '../ui/Hint';
import { LandingScreen } from '../ui/LandingScreen';
import { WaterHUD } from '../ui/WaterHUD';
import { RippleEngine, type EngineOptions, type EngineUiState } from './RippleEngine';

function readOptions(): EngineOptions & { debug: boolean } {
  const params = new URLSearchParams(window.location.search);
  const quality = params.get('quality');
  return {
    boundary: params.get('boundary') === 'reflect' ? 'reflect' : 'absorb',
    forceCpuSimulation: params.get('sim') === 'cpu',
    quality: quality !== null && quality !== '' ? Number(quality) : undefined,
    debug: params.has('debug'),
    look: params.get('mood') === 'night' ? 'night' : 'day',
  };
}

export function App() {
  const container = useRef<HTMLDivElement>(null);
  const engineRef = useRef<RippleEngine | null>(null);
  const [ui, setUi] = useState<EngineUiState | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const options = useMemo(readOptions, []);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    let engine: RippleEngine;
    try {
      engine = new RippleEngine(el, options);
    } catch (err) {
      console.error(err);
      setFatal((err as Error)?.message ?? String(err));
      return;
    }
    engineRef.current = engine;
    // Handy for debugging and automated checks; not exposed in normal production use.
    if (import.meta.env.DEV || options.debug) (window as unknown as { __ripple?: RippleEngine }).__ripple = engine;
    const unsubscribe = engine.subscribe(setUi);
    return () => {
      unsubscribe();
      engine.dispose();
      engineRef.current = null;
    };
  }, [options]);

  const enter = useCallback(() => engineRef.current?.enter(), []);
  const toggleCamera = useCallback(() => {
    const e = engineRef.current;
    if (!e) return;
    const s = e.uiState.camera;
    if (s === 'active' || s === 'starting' || s === 'loading-model') e.disableCamera();
    else void e.enableCamera();
  }, []);
  const calibrate = useCallback(() => engineRef.current?.startCalibration(), []);
  const toggleMute = useCallback(() => {
    const e = engineRef.current;
    if (e) e.setMuted(!e.uiState.muted);
  }, []);
  const reset = useCallback(() => engineRef.current?.resetWater(), []);
  const onPreviewCanvas = useCallback((c: HTMLCanvasElement | null) => engineRef.current?.setPreviewCanvas(c), []);

  const message = fatal ?? ui?.fatal ?? null;
  const entered = ui?.entered ?? false;
  const video = ui?.camera === 'active' ? (engineRef.current?.cameraVideo ?? null) : null;

  return (
    <main className="app">
      <div ref={container} className="water" />
      {message ? (
        <ErrorState message={message} />
      ) : (
        <>
          <LandingScreen visible={!entered} onEnter={enter} />
          {entered && ui && (
            <>
              <Hint text={ui.hint} />
              <WaterHUD ui={ui} onToggleCamera={toggleCamera} onCalibrate={calibrate} onToggleMute={toggleMute} onReset={reset} debug={options.debug} />
              {video && <CameraPreview video={video} mirrored={engineRef.current?.mirrored ?? true} onCanvas={onPreviewCanvas} />}
            </>
          )}
        </>
      )}
    </main>
  );
}
