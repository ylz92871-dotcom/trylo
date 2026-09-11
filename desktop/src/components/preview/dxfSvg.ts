// Trylo Desktop — DXF entities → SVG projection (pure).
//
// dxf-parser (MIT) does the format work; this module owns OUR policy:
// which entities become SVG, Y-up→Y-down mirroring, bbox fit, and
// honest accounting (rendered vs skipped vs approximated). The React
// side only injects the string. Fully unit-tested with inline DXF.

import DxfParser, {
  type IArcEntity,
  type ICircleEntity,
  type IEllipseEntity,
  type ILineEntity,
  type ILwpolylineEntity,
  type IMtextEntity,
  type IPolylineEntity,
  type ITextEntity,
} from 'dxf-parser';

const MAX_CHARS = 2 * 1024 * 1024;
const MAX_ENTITIES = 20000;

export interface DxfSvg {
  readonly svg: string;
  readonly rendered: number;
  readonly skipped: number;
  readonly approximated: boolean;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '0';
}

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function emptyBBox(): BBox {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function track(box: BBox, x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  // SVG is Y-down; DXF is Y-up — mirror once, here, for every point.
  const sy = -y;
  if (x < box.minX) box.minX = x;
  if (x > box.maxX) box.maxX = x;
  if (sy < box.minY) box.minY = sy;
  if (sy > box.maxY) box.maxY = sy;
}

function arcPath(
  cx: number, cy: number, r: number,
  startDeg: number, endDeg: number,
): string {
  const sweep = ((endDeg - startDeg) % 360 + 360) % 360;
  const a0 = (startDeg * Math.PI) / 180;
  const a1 = ((startDeg + sweep) * Math.PI) / 180;
  const x0 = cx + r * Math.cos(a0);
  const y0 = -(cy + r * Math.sin(a0));
  const x1 = cx + r * Math.cos(a1);
  const y1 = -(cy + r * Math.sin(a1));
  // The Y-mirror flips orientation: a DXF CCW arc arrives as a SVG
  // counter-clockwise (screen) arc, i.e. sweep-flag 0. (Getting this
  // backwards renders the complementary half — caught by E2E.)
  const large = sweep > 180 ? 1 : 0;
  if (sweep >= 360 - 1e-6) {
    return `<circle cx="${num(cx)}" cy="${num(-cy)}" r="${num(r)}"/>`;
  }
  return `<path d="M ${num(x0)} ${num(y0)} A ${num(r)} ${num(r)} 0 ${large} 0 ${num(x1)} ${num(y1)}"/>`;
}

/** Parse DXF text into an SVG string. Never throws. */
export function dxfToSvg(content: string): DxfSvg {
  const fail = (rendered: number, skipped: number): DxfSvg => ({
    svg: '',
    rendered,
    skipped,
    approximated: false,
  });
  if (content.length > MAX_CHARS) return fail(0, 0);
  let parsed;
  try {
    parsed = new DxfParser().parseSync(content);
  } catch {
    return fail(0, 0);
  }
  if (!parsed) return fail(0, 0);

  const parts: string[] = [];
  const box = emptyBBox();
  let rendered = 0;
  let skipped = 0;
  let approximated = false;

  for (const entity of parsed.entities.slice(0, MAX_ENTITIES)) {
    switch (entity.type) {
      case 'LINE': {
        const e = entity as ILineEntity;
        const [a, b] = [e.vertices[0], e.vertices[1]];
        if (!a || !b) {
          skipped += 1;
          break;
        }
        track(box, a.x, a.y);
        track(box, b.x, b.y);
        parts.push(`<line x1="${num(a.x)}" y1="${num(-a.y)}" x2="${num(b.x)}" y2="${num(-b.y)}"/>`);
        rendered += 1;
        break;
      }
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const e = entity as ILwpolylineEntity | IPolylineEntity;
        if (e.vertices.length === 0) {
          skipped += 1;
          break;
        }
        for (const v of e.vertices) track(box, v.x, v.y);
        // Bulged (arc) segments are straightened — disclosed, not faked.
        // NOTE: absent bulge parses as undefined, not 0 — compare
        // nullish-aware or every straight polyline cries wolf.
        if (entity.type === 'LWPOLYLINE' && (entity as ILwpolylineEntity).vertices.some((v) => (v.bulge ?? 0) !== 0)) {
          approximated = true;
        }
        const d = e.vertices
          .map((v, i) => `${i === 0 ? 'M' : 'L'} ${num(v.x)} ${num(-v.y)}`)
          .join(' ');
        const closed = 'shape' in e && e.shape === true ? ' Z' : '';
        parts.push(`<path d="${d}${closed}"/>`);
        rendered += 1;
        break;
      }
      case 'CIRCLE': {
        const e = entity as ICircleEntity;
        track(box, e.center.x - e.radius, e.center.y - e.radius);
        track(box, e.center.x + e.radius, e.center.y + e.radius);
        parts.push(`<circle cx="${num(e.center.x)}" cy="${num(-e.center.y)}" r="${num(e.radius)}"/>`);
        rendered += 1;
        break;
      }
      case 'ARC': {
        const e = entity as IArcEntity;
        track(box, e.center.x - e.radius, e.center.y - e.radius);
        track(box, e.center.x + e.radius, e.center.y + e.radius);
        // NOTE: dxf-parser hands ARC angles in RADIANS (a 180° file
        // arrives as π — E2E once rendered it as a 3° dash). arcPath
        // works in degrees.
        const toDeg = 180 / Math.PI;
        parts.push(arcPath(
          e.center.x, e.center.y, e.radius,
          e.startAngle * toDeg, e.endAngle * toDeg,
        ));
        rendered += 1;
        break;
      }
      case 'ELLIPSE': {
        const e = entity as IEllipseEntity;
        const mx = e.majorAxisEndPoint.x;
        const my = e.majorAxisEndPoint.y;
        const major = Math.hypot(mx, my);
        const minor = major * e.axisRatio;
        const rot = (Math.atan2(my, mx) * 180) / Math.PI;
        track(box, e.center.x - major, e.center.y - major);
        track(box, e.center.x + major, e.center.y + major);
        parts.push(
          `<ellipse cx="${num(e.center.x)}" cy="${num(-e.center.y)}" rx="${num(major)}" ry="${num(minor)}" transform="rotate(${num(-rot)} ${num(e.center.x)} ${num(-e.center.y)})"/>`,
        );
        rendered += 1;
        break;
      }
      case 'TEXT': {
        const e = entity as ITextEntity;
        track(box, e.startPoint.x, e.startPoint.y);
        parts.push(
          `<text x="${num(e.startPoint.x)}" y="${num(-e.startPoint.y)}" font-size="${num(e.textHeight || 2.5)}">${escapeXml(e.text)}</text>`,
        );
        rendered += 1;
        break;
      }
      case 'MTEXT': {
        const e = entity as IMtextEntity;
        track(box, e.position.x, e.position.y);
        parts.push(
          `<text x="${num(e.position.x)}" y="${num(-e.position.y)}" font-size="${num(e.height || 2.5)}">${escapeXml(e.text)}</text>`,
        );
        rendered += 1;
        break;
      }
      default:
        // INSERT (needs block resolution), DIMENSION, HATCH, SPLINE,
        // 3D solids and friends: counted, never silently dropped.
        skipped += 1;
        break;
    }
  }
  skipped += Math.max(0, parsed.entities.length - MAX_ENTITIES);

  if (rendered === 0 || box.minX === Infinity) return fail(0, skipped);
  const padX = Math.max((box.maxX - box.minX) * 0.05, 1);
  const padY = Math.max((box.maxY - box.minY) * 0.05, 1);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="${num(box.minX - padX)} ${num(box.minY - padY)} ${num(box.maxX - box.minX + padX * 2)} ${num(box.maxY - box.minY + padY * 2)}" ` +
    `fill="none" stroke="currentColor" stroke-width="1" vector-effect="non-scaling-stroke" ` +
    `font-family="sans-serif">` +
    parts.join('') +
    `</svg>`;
  return { svg, rendered, skipped, approximated };
}
