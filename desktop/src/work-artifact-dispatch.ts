// Trylo Desktop — Work artifact capability dispatch
// (P2-1 A-Edge / audit P1-4).
//
// Pure routing decision: what should the Work surface's primary "Open"
// action do for a given artifact path? Extracted from App.tsx so the
// matrix is unit-testable without mounting React / Tauri / Monaco.
//
// Dispatch matrix (audit §4 P1-4):
//   - text / source / markdown / html / csv / unknown extension:
//     in-app rich peek (FilePeek → PreviewRouter in
//     components/preview/; the router picks markdown / table / text).
//   - image (png/jpg/jpeg/webp/gif/bmp/svg/avif/heic/heif/tif/tiff/ico):
//     in-app image peek (bytes via readFileBytes, never text-decoded).
//   - rich documents (PDF / OOXML Office / 3D lightweights / DXF /
//     Gerber): in-app rich preview (pdf.js / docx-preview / SheetJS /
//     pptxviewjs / three.js / dxf+gerber SVG). Lazy-loaded on peek.
//   - legacy binary Office (.doc/.ppt), .rtf/.odt, CAD natives
//     (.sldprt/.FCStd/.blend/.kicad_*), archives, executables,
//     unknown binaries, no extension: host/OS viewer through the
//     project-root-bound HostAdapter. We do NOT pretend to support
//     in-app preview for these until a real implementation exists
//     (audit: "any non-existent rich preview capability must NOT be
//     advertised as implemented").

export type ArtifactCapability =
  | { readonly kind: 'text-preview' }
  | { readonly kind: 'image-preview' }
  | { readonly kind: 'rich-preview'; readonly preview: string }
  | { readonly kind: 'host-open'; readonly reason: string };

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp',
  '.svg', '.avif', '.heic', '.heif', '.tif', '.tiff', '.ico',
]);

// In-app rich preview, one entry per PreviewKind that needs more than
// the text view. Mirrors `previewKindFor` in components/preview/ —
// every extension here must resolve to a non-text kind there.
const RICH_PREVIEW_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['.pdf', 'pdf'],
  ['.docx', 'docx'], ['.docm', 'docx'], ['.dotx', 'docx'], ['.dotm', 'docx'],
  ['.xlsx', 'xlsx'], ['.xlsm', 'xlsx'], ['.xls', 'xlsx'], ['.xlsb', 'xlsx'], ['.ods', 'xlsx'],
  ['.pptx', 'pptx'], ['.pptm', 'pptx'], ['.potx', 'pptx'], ['.potm', 'pptx'],
  ['.ppsx', 'pptx'], ['.ppsm', 'pptx'],
  ['.stl', 'model3d'], ['.obj', 'model3d'], ['.glb', 'model3d'],
  ['.gltf', 'model3d'], ['.3mf', 'model3d'],
  ['.dxf', 'dxf'],
  ['.gbr', 'gerber'], ['.ger', 'gerber'], ['.pho', 'gerber'],
  ['.gtl', 'gerber'], ['.gbl', 'gerber'], ['.gts', 'gerber'], ['.gbs', 'gerber'],
  ['.gto', 'gerber'], ['.gbo', 'gerber'], ['.gtp', 'gerber'], ['.gbp', 'gerber'],
  ['.gm1', 'gerber'], ['.gko', 'gerber'], ['.gm3', 'gerber'],
  ['.drl', 'gerber'], ['.xln', 'gerber'], ['.exc', 'gerber'], ['.ncd', 'gerber'],
]);

const HOST_OPEN_EXTENSIONS: ReadonlySet<string> = new Set([
  // Legacy binary Office + formats without an in-app renderer. OOXML
  // (.docx/.xlsx/.pptx families) moved to rich-preview above.
  '.doc', '.rtf', '.odt', '.ott', '.ppt', '.pot', '.pps',
  // CAD natives are binary blobs — a UTF-8 peek would be a garbage
  // wall. KiCad/STEP text formats stay on the text peek on purpose.
  '.sldprt', '.sldasm', '.slddrw', '.blend', '.blend1',
  '.fcstd', '.f3d', '.f3z',
  // Common binary formats that the text preview would garble. Archives
  // and compiled binaries have no readable UTF-8 content; sending them
  // to host-open is the safe default. The set is not exhaustive — the
  // "no extension" fallback below also catches the long tail.
  '.bin', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.bz2', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.war',
  '.wasm', '.o', '.a', '.obj', '.lib', '.deb', '.rpm', '.dmg', '.iso',
]);

/** Lowercased trailing extension including the dot, or '' when the path
 *  has no extension. Pure / IO-free so the dispatch matrix is unit
 *  testable without mocking the host adapter. */
export function extOf(p: string): string {
  const m = p.toLowerCase().match(/\.[^./\\]+$/);
  return m ? m[0] : '';
}

/** Decide what "Open" should do for a Work artifact path. Returns the
 *  capability the host should route to. See the file header for the
 *  full dispatch matrix. */
export function artifactCapabilityFor(path: string): ArtifactCapability {
  const e = extOf(path);
  if (IMAGE_EXTENSIONS.has(e)) return { kind: 'image-preview' };
  const rich = RICH_PREVIEW_EXTENSIONS.get(e);
  if (rich !== undefined) return { kind: 'rich-preview', preview: rich };
  if (HOST_OPEN_EXTENSIONS.has(e)) {
    return {
      kind: 'host-open',
      reason: 'This format has no in-app preview yet — opening with the system default app.',
    };
  }
  if (e === '') {
    return {
      kind: 'host-open',
      reason: 'No extension detected — opening with the system default app.',
    };
  }
  // The remaining paths are text-like extensions (txt, md, html, json,
  // ts, rs, …). The peek pipeline reads them as UTF-8; a non-UTF-8 file
  // is the user's risk to take, and the OS can't preview it either.
  return { kind: 'text-preview' };
}
