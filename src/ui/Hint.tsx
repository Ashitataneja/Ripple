import { useEffect, useState } from 'react';

/** A single, quiet contextual hint that fades in and out. */
export function Hint({ text }: { text: string | null }) {
  const [shown, setShown] = useState<string | null>(text);
  useEffect(() => {
    if (text) setShown(text);
  }, [text]);
  return (
    <div className={`hint ${text ? 'hint--visible' : ''}`} role="status" aria-live="polite">
      {shown}
    </div>
  );
}
