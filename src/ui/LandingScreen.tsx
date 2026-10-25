interface LandingScreenProps {
  visible: boolean;
  onEnter: () => void;
}

/** The only thing on screen at first: a title over still water, and one way in. */
export function LandingScreen({ visible, onEnter }: LandingScreenProps) {
  return (
    <div className={`landing ${visible ? '' : 'landing--gone'}`} aria-hidden={!visible}>
      <h1 className="landing__title">RIPPLE</h1>
      <p className="landing__subtitle">Touch a world made of water.</p>
      <button type="button" className="landing__enter" onClick={onEnter} tabIndex={visible ? 0 : -1} autoFocus>
        ENTER THE WATER
      </button>
    </div>
  );
}
