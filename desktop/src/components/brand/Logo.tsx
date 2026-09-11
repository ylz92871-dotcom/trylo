// Trylo Desktop — Trilo brand mark.
//
// The mark is a 4-stroke X (Z-up / S-down). It's the SAME shape
// on the desktop top bar, the empty state, the Work starters,
// the in-app logo, the desktop installer icon, the mobile app
// launcher and every other surface: one Trylo = one mark.
//
// 2026-08-29 polish pass:
//   * Slightly thinner stroke (76 → 64 at the 1024 viewBox) so
//     the mark reads cleaner at small sizes (16–28px).
//   * Smoother gradient endpoints: top is the warm gold
//     (#DBC97F), bottom is the deep bronze (#7C6A2A) — no
//     harsh stops in between.
//   * New `variant="solid"` for full-saturation usage (the
//     desktop installer, mobile launcher) — the installer
//     needs 100% opacity on macOS / Windows taskbars where the
//     dark mode canvas fights soft marks.
//   * New `withBg` for surfaces that want a round chip behind
//     the mark (the remote-access quick toggle, etc.).
//   * `tone="aurora"` (default) keeps the gold gradient;
//     `tone="ink"` drops to a paper-white stroke on dark
//     canvases when gold would clash.
//   * `glow` paints a soft warm halo behind the mark for the
//     empty state.
import type { CSSProperties, ReactElement } from 'react';

export type LogoVariant = 'gradient' | 'solid';
export type LogoTone = 'aurora' | 'ink';

export interface LogoProps {
  /** Pixel size of the rendered svg square. Defaults to 48. */
  readonly size?: number;
  /** Decorative-only when true (no a11y title). */
  readonly decorative?: boolean;
  /** Stroke treatment. `solid` is single-colour (installer icon). */
  readonly variant?: LogoVariant;
  /** `aurora` (default) gold gradient; `ink` paper-white stroke. */
  readonly tone?: LogoTone;
  /** Show a soft warm halo behind the mark. */
  readonly glow?: boolean;
  /** Wrap the SVG in a rounded square chip background. */
  readonly withBg?: boolean;
  /** Opacity of the SVG only (does not touch the chip background). */
  readonly opacity?: number;
}

const GRADIENT_STOPS: Readonly<{ offset: string; color: string }[]> = [
  { offset: '0',   color: '#F0DE91' },
  { offset: '0.55', color: '#DEC86F' },
  { offset: '1',   color: '#C6AB50' },
];

const SOLID_COLOR_AURORA = '#DEC86F';
const SOLID_COLOR_INK = '#ECEEF2';

export function Logo(props: LogoProps): ReactElement {
  const size = props.size ?? 48;
  const titleId = props.decorative ? undefined : 'trilo-logo-title';
  const variant = props.variant ?? 'gradient';
  const tone = props.tone ?? 'aurora';
  const gradId = `trilo-aurora-${tone}`;

  const svg = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={props.decorative ? 'presentation' : 'img'}
      aria-labelledby={titleId}
      aria-hidden={props.decorative ? 'true' : undefined}
      style={{ display: 'block', opacity: props.opacity }}
    >
      {!props.decorative && <title id={titleId}>Trylo</title>}
      <defs>
        <linearGradient
          id={gradId}
          x1="232"
          y1="220"
          x2="812"
          y2="804"
          gradientUnits="userSpaceOnUse"
        >
          {variant === 'gradient' ? (
            GRADIENT_STOPS.map((stop, i) => (
              <stop key={i} offset={stop.offset} stopColor={stop.color} />
            ))
          ) : (
            <stop offset="0" stopColor={tone === 'ink' ? SOLID_COLOR_INK : SOLID_COLOR_AURORA} />
          )}
        </linearGradient>
      </defs>
      <g
        stroke={`url(#${gradId})`}
        strokeWidth="64"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        <path d="M462 236 L462 420 L624 420" />
        <path d="M276 732 L424 644 L356 512" />
        <path d="M540 676 L622 546 L786 640" />
      </g>
    </svg>
  );

  if (!props.withBg && !props.glow) return svg;

  const wrapStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  };

  if (props.glow) {
    return (
      <span
        className="trilo-mark trilo-mark--glow"
        aria-hidden={props.decorative ? 'true' : undefined}
        style={wrapStyle}
      >
        <span
          className="trilo-mark__halo"
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: `-${size * 0.55}px`,
            background:
              'radial-gradient(closest-side, rgba(219, 201, 127, 0.22), rgba(219, 201, 127, 0.0) 70%)',
            pointerEvents: 'none',
          }}
        />
        {svg}
      </span>
    );
  }

  return (
    <span
      className="trilo-mark trilo-mark--chip"
      aria-hidden={props.decorative ? 'true' : undefined}
      style={wrapStyle}
    >
      {svg}
    </span>
  );
}
