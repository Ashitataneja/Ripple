interface ErrorStateProps {
  title?: string;
  message: string;
}

/** Full-screen failure state (no WebGL 2, lost GPU context, shader failure). */
export function ErrorState({ title = 'The water cannot be shown', message }: ErrorStateProps) {
  return (
    <div className="error-state" role="alert">
      <h2>{title}</h2>
      <p>{message}</p>
      <p className="error-state__help">Try an up-to-date desktop Chrome with hardware acceleration enabled.</p>
      <button type="button" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
