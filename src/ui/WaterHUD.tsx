import type { EngineUiState } from '../app/RippleEngine';
import { CameraStatus } from './CameraStatus';

interface WaterHUDProps {
  ui: EngineUiState;
  onToggleCamera: () => void;
  onCalibrate: () => void;
  onToggleMute: () => void;
  onReset: () => void;
  debug: boolean;
}

/** Discreet controls in one corner. Dimmed until hovered or focused. */
export function WaterHUD({ ui, onToggleCamera, onCalibrate, onToggleMute, onReset, debug }: WaterHUDProps) {
  const cameraOn = ui.camera === 'active' || ui.camera === 'starting' || ui.camera === 'loading-model';
  return (
    <div className="hud">
      <CameraStatus status={ui.camera} handsVisible={ui.handsVisible} message={ui.cameraMessage} />
      <div className="hud__buttons">
        <button type="button" className={`hud__button ${cameraOn ? 'hud__button--on' : ''}`} onClick={onToggleCamera} aria-pressed={cameraOn} title={cameraOn ? 'Turn camera off (C)' : 'Use your hands — enables the camera (C)'} aria-label={cameraOn ? 'Turn camera off' : 'Use your hands (enable camera)'}>
          <HandIcon />
          {!cameraOn && <span className="hud__button-text">Use hands</span>}
        </button>
        {ui.camera === 'active' && (
          <button type="button" className="hud__button" onClick={onCalibrate} disabled={ui.calibrating} title="Calibrate your reach" aria-label="Calibrate hand reach">
            <TargetIcon />
          </button>
        )}
        <button type="button" className="hud__button" onClick={onToggleMute} aria-pressed={ui.muted} title={ui.muted ? 'Unmute (M)' : 'Mute (M)'} aria-label={ui.muted ? 'Unmute sound' : 'Mute sound'}>
          {ui.muted ? <MutedIcon /> : <SoundIcon />}
        </button>
        <button type="button" className="hud__button" onClick={onReset} title="Still the water (R)" aria-label="Reset the water">
          <ResetIcon />
        </button>
      </div>
      {debug && (
        <div className="hud__stats">
          {ui.stats.fps} fps · {ui.stats.simulation} {ui.stats.grid} · q{ui.stats.quality}
          {ui.camera === 'active' ? ` · hands ${ui.stats.tracker} ${ui.stats.inferenceMs} ms` : ''}
        </div>
      )}
    </div>
  );
}

const iconProps = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

function HandIcon() {
  return (
    <svg {...iconProps}>
      <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12" />
      <path d="M11 11.5V4a1.5 1.5 0 0 1 3 0v7.5" />
      <path d="M14 11.5V5.5a1.5 1.5 0 0 1 3 0V14" />
      <path d="M17 9.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.6-2.8L3.3 15.5a1.6 1.6 0 0 1 2.5-2L8 15.5" />
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  );
}

function SoundIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 9.5h3l5-4v13l-5-4H4z" />
      <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" />
    </svg>
  );
}

function MutedIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 9.5h3l5-4v13l-5-4H4z" />
      <path d="M16.5 9.5l5 5M21.5 9.5l-5 5" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 4v4.5h4.5" />
    </svg>
  );
}
