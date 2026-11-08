import type { ReactElement } from 'react';
import { Logo } from '../brand/Logo';

export interface LandingSurfaceProps {
  readonly headline: string;
  readonly subtitle?: string;
}

export function LandingSurface(props: LandingSurfaceProps): ReactElement {
  return <header className="landing-surface">
    <div className="landing-surface__lockup">
      <span className="landing-surface__mark" aria-hidden="true"><Logo size={44} withBg tone="cream" variant="solid" decorative /></span>
      <h1 className="landing-surface__headline">{props.headline}</h1>
    </div>
    {props.subtitle && <p className="landing-surface__subtitle">{props.subtitle}</p>}
  </header>;
}
