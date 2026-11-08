// Trylo Desktop — Trylo brand mark.
//
// The mark is made from three bent strokes. One Trylo = one mark:
// the geometry below is the SAME as the mobile launcher foreground
// (`mobile-app/.../trylo_launcher_foreground.xml`) — path box
// 378×367 units of the 1024 viewBox, stroke 60.
//
// 2026-10-14 unification: the desktop used to carry its own
// coordinates (550-unit box, stroke 64) while the shipped mobile
// icon used the numbers above — two "same" marks that were not.
// The mobile numbers won (they are what ships and what the owner
// approved for the left-rail brand); the gradient direction was
// kept diagonal across the new box.
//
// Tones:
//   * `aurora` (default) — gold gradient stroke.
//   * `ink` — paper-white stroke for dark canvases.
//   * `cream` (#F3E3A6) — the mobile launcher's stroke colour;
//     pairs with `withBg` for the left-rail brand: cream on #111318
//     in both themes, as approved with the startup handoff.
//
// `withBg` keeps a themed rounded chip's layout slot.
// Inside that slot the mark renders at 82% ink-box coverage,
// which makes the SVG canvas larger than
// the chip; `logo.css` pins `flex-shrink: 0` so the flex chip
// cannot squash it back down.
import { useId, type CSSProperties, type ReactElement } from 'react';

export type LogoVariant = 'gradient' | 'solid';
export type LogoTone = 'aurora' | 'ink' | 'cream';

export interface LogoProps {
  /** Pixel size of the rendered svg square (chip size when `withBg`). Defaults to 48. */
  readonly size?: number;
  /** Decorative-only when true (no a11y title). */
  readonly decorative?: boolean;
  /** Stroke treatment. `solid` is single-colour (installer icon). */
  readonly variant?: LogoVariant;
  /** `aurora` (default) gold gradient; `ink` paper-white; `cream` mobile launcher cream. */
  readonly tone?: LogoTone;
  /** Show a soft warm halo behind the mark. */
  readonly glow?: boolean;
  /** Keep the approved dark rounded chip in both themes. */
  readonly withBg?: boolean;
  /** Opacity of the SVG only (does not touch the chip background). */
  readonly opacity?: number;
}

const GRADIENT_STOPS: Readonly<{ offset: string; color: string }[]> = [
  { offset: '0', color: '#F0DE91' },
  { offset: '0.55', color: '#DEC86F' },
  { offset: '1', color: '#C6AB50' },
];

const SOLID_COLOR_AURORA = '#DEC86F';
const SOLID_COLOR_INK = '#ECEEF2';
/** The mobile launcher's stroke colour (`trylo_launcher_foreground.xml`). */
const SOLID_COLOR_CREAM = '#F3E3A6';
/** The app-icon tile (`@color/ic_launcher_background`). */
const CHIP_COLOR = '#111318';

/** Mark geometry — identical to the mobile launcher foreground. */
const MARK_PATHS: readonly string[] = [
  'M475 308 L475 444 L595 444',
  'M337 675 L447 610 L397 512',
  'M533 633 L593 537 L715 607',
];
/** INK box (path bbox 378x367 plus the round caps' stroke 60) in
 *  viewBox units. This — not the path bbox — is what the eye
 *  measures, so coverage math must use it. (Getting this wrong
 *  is what shipped the mark 6% off-centre in the first icon pass:
 *  the real x range is 337..715.) */
const MARK_INK_BOX = 438;
/** Placement starts from the ink-box centre. The user chose a small
 *  right/up correction after comparing the mark inside its dark tile;
 *  this is a visual adjustment, not full ink-centroid compensation.
 *  Relative to translate(-14, 17.5), it moves 9 units right and 14 up. */
const MARK_BBOX_CX = 526;
const MARK_BBOX_CY = 491.5;
const MARK_OPTICAL_SHIFT_X = 9;
const MARK_OPTICAL_LIFT = 17;
const MARK_STROKE = 60;

/** Ink coverage of the chip when `withBg` — the owner's pick from the
 *  four-way comparison sheet (73 / 78 / 82 / 86, phone icon at 76).
 *  82% is full but keeps a visible margin; 86% crowded the corners. */
const CHIP_INK_RATIO = 0.82;

export function Logo(props: LogoProps): ReactElement {
  const instanceId = useId().replaceAll(':', '');
  const size = props.size ?? 48;
  const titleId = props.decorative ? undefined : `trilo-logo-title-${instanceId}`;
  const variant = props.variant ?? 'gradient';
  const tone = props.tone ?? 'aurora';
  const themedChipInk = props.withBg && !props.glow && variant === 'solid' && tone === 'cream';
  // SVG paint IDs are document-wide; instances may inherit different theme colours.
  const gradId = `trilo-aurora-${tone}-${instanceId}`;

  // Inside a chip the mark's INK box covers CHIP_INK_RATIO of the
  // chip. Round caps already counted in MARK_INK_BOX, so this is a
  // single clean scale factor; without `withBg` the canvas is the
  // chip size and the mark simply fills the square.
  //   ink box at width W = MARK_INK_BOX * W / 1024 = ratio * size
  const svgSize = props.withBg
    ? Math.round((1024 * CHIP_INK_RATIO * size) / MARK_INK_BOX)
    : size;

  const svg = (
    <svg
      width={svgSize}
      height={svgSize}
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
            <stop
              offset="0"
              stopColor={
                tone === 'ink'
                  ? SOLID_COLOR_INK
                  : tone === 'cream'
                    ? themedChipInk ? `var(--logo-chip-ink, ${SOLID_COLOR_CREAM})` : SOLID_COLOR_CREAM
                    : SOLID_COLOR_AURORA
              }
            />
          )}
        </linearGradient>
      </defs>
      <g
        stroke={`url(#${gradId})`}
        strokeWidth={MARK_STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        transform={`translate(${512 - MARK_BBOX_CX + MARK_OPTICAL_SHIFT_X} ${512 - MARK_BBOX_CY - MARK_OPTICAL_LIFT})`}
      >
        {MARK_PATHS.map((d, i) => (
          <path key={i} d={d} />
        ))}
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
      style={{
        ...wrapStyle,
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.275),
        background: `var(--logo-chip-bg, ${CHIP_COLOR})`,
      }}
    >
      {svg}
    </span>
  );
}
