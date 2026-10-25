import type { CameraStatus as Status } from '../app/RippleEngine';

const LABELS: Record<Status, string> = {
  off: 'Hands off',
  starting: 'Waiting for camera…',
  'loading-model': 'Loading hand tracking…',
  active: 'Hands on',
  error: 'Camera unavailable',
};

interface CameraStatusProps {
  status: Status;
  handsVisible: number;
  message: string | null;
}

export function CameraStatus({ status, handsVisible, message }: CameraStatusProps) {
  const label = status === 'active' ? (handsVisible > 0 ? `${handsVisible === 1 ? 'One hand' : 'Two hands'} in view` : 'Show your hands') : LABELS[status];
  return (
    <div className="camera-status" role="status" aria-live="polite">
      <span className={`camera-status__dot camera-status__dot--${status} ${status === 'active' && handsVisible > 0 ? 'camera-status__dot--tracking' : ''}`} />
      <span className="camera-status__label">{label}</span>
      {message && <p className="camera-status__message">{message}</p>}
    </div>
  );
}
