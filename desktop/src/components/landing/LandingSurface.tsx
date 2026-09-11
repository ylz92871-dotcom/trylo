// Trylo Desktop — unified Landing Surface (Code / Work empty state).
//
// 2026-08-29 refactor: Code and Work no longer ship two different
// first-run home pages. They share ONE skeleton:
//
//        [ oversized, faint, neutral background watermark ]
//
//                 Primary headline
//                Secondary sentence (1 line)
//
//          suggestion  suggestion  suggestion
//
// The composer (rendered outside this surface, at the bottom)
// is the real interaction core; this surface only guides.
//
// Differences between modes are purely semantic — headline,
// subtitle, suggestion set — never extra UI modules. The brand
// mark is an environment layer (background watermark), not a
// content element. Whitespace is intentional, not unfinished.

import type { ReactElement } from 'react';
import { Logo } from '../brand/Logo';

export interface LandingSuggestion {
  /** Visible pill label. */
  readonly label: string;
  /** Text seeded into the agent when picked. */
  readonly value: string;
  /** Optional capability id (Work seeds per-capability). */
  readonly id?: string;
}

export interface LandingSurfaceProps {
  readonly headline: string;
  readonly subtitle?: string;
  /**
   * Optional suggestion pills. The 2026-08-29 refactor unified Code /
   * Work / Team behind one landing skeleton (watermark + headline +
   * subtitle). The pills are kept on the type for future re-introduction
   * (spec calls for them, but the current skeleton is intentionally
   * quiet — pills live in the composer instead). Callers that don't
   * want them simply omit both fields.
   */
  readonly suggestions?: readonly LandingSuggestion[];
  readonly onSuggestion?: (suggestion: LandingSuggestion) => void;
}

export function LandingSurface(props: LandingSurfaceProps): ReactElement {
  return (
    <div className="landing-surface" role="presentation">
      {/* Background-layer brand watermark: oversized, neutral
          (paper-white, not gold), very low opacity. It sits
          behind the words, is out of the document flow, ignores
          pointer events, and may bleed past the hero bounds. */}
      <div className="landing-surface__watermark" aria-hidden="true">
        <Logo size={600} decorative variant="solid" tone="ink" />
      </div>
      <div className="landing-surface__content">
        <h1 className="landing-surface__headline">{props.headline}</h1>
        {props.subtitle !== undefined && (
          <p className="landing-surface__subtitle">{props.subtitle}</p>
        )}
      </div>
    </div>
  );
}
