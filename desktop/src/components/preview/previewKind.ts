// Trylo Desktop — preview kind dispatch (base capability).
//
// Pure, IO-free mapping from a file path to the rich preview the
// shared FilePeek should render. Used by BOTH Code and Work surfaces:
// every in-app peek funnels through FilePeek, so extending this matrix
// upgrades both modes at once.
//
// Consistency rules (keep in sync — a mismatch is a user-visible lie):
//   - IMAGE_EXTENSIONS mirrors `work-artifact-dispatch.ts`.
//   - DOCX/XLSX/PPTX sets mirror `canPreview*InApp` in
//     `work/src/renderer/format-helpers.ts` (the ArtifactCard button).
//
// Formats we deliberately do NOT claim: legacy binary Office
// (.doc/.ppt), .rtf/.odt, CAD natives (.sldprt/.FCStd/.blend,
// .kicad_*), archives. Those stay on the OS viewer (host-open).

export type PreviewKind =
  | 'markdown'
  | 'html'
  | 'csv'
  | 'image'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'model3d'
  | 'dxf'
  | 'gerber'
  | 'text';

const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.markdown',
]);

const HTML_EXTENSIONS: ReadonlySet<string> = new Set(['.html', '.htm']);

const CSV_EXTENSIONS: ReadonlySet<string> = new Set(['.csv', '.tsv']);

// Mirrors IMAGE_EXTENSIONS in work-artifact-dispatch.ts — keep in sync.
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp',
  '.svg', '.avif', '.heic', '.heif', '.tif', '.tiff', '.ico',
]);

// OOXML Word only — docx-preview cannot parse legacy .doc / .rtf / .odt.
const DOCX_EXTENSIONS: ReadonlySet<string> = new Set([
  '.docx', '.docm', '.dotx', '.dotm',
]);

// SheetJS reads all of these (modern + legacy BIFF + ODS values).
const XLSX_EXTENSIONS: ReadonlySet<string> = new Set([
  '.xlsx', '.xlsm', '.xls', '.xlsb', '.ods',
]);

// OOXML Presentation only — pptxviewjs cannot parse legacy .ppt.
const PPTX_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pptx', '.pptm', '.potx', '.potm', '.ppsx', '.ppsm',
]);

// three.js addon loaders: STL / OBJ / glTF / 3MF. STEP needs a full
// OCCT kernel (multi-MB WASM) — deliberately out of scope, host-open.
const MODEL_EXTENSIONS: ReadonlySet<string> = new Set([
  '.stl', '.obj', '.glb', '.gltf', '.3mf',
]);

const GERBER_EXTENSIONS: ReadonlySet<string> = new Set([
  '.gbr', '.ger', '.pho',
  '.gtl', '.gbl', '.gts', '.gbs', '.gto', '.gbo', '.gtp', '.gbp',
  '.gm1', '.gko', '.gm3',
  '.drl', '.xln', '.exc', '.ncd',
]);

/** Lowercased trailing extension including the dot, or '' when none. */
export function previewExtOf(path: string): string {
  const m = path.toLowerCase().match(/\.[^./\\]+$/);
  return m ? m[0] : '';
}

/** Which rich renderer FilePeek should use. Pure / IO-free. */
export function previewKindFor(path: string): PreviewKind {
  const ext = previewExtOf(path);
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (HTML_EXTENSIONS.has(ext)) return 'html';
  if (CSV_EXTENSIONS.has(ext)) return 'csv';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (DOCX_EXTENSIONS.has(ext)) return 'docx';
  if (XLSX_EXTENSIONS.has(ext)) return 'xlsx';
  if (PPTX_EXTENSIONS.has(ext)) return 'pptx';
  if (MODEL_EXTENSIONS.has(ext)) return 'model3d';
  if (ext === '.dxf') return 'dxf';
  if (GERBER_EXTENSIONS.has(ext)) return 'gerber';
  return 'text';
}

/**
 * True when the renderer needs raw bytes (not the UTF-8 text `content`).
 * App.onSelectFile skips the text read for these — decoding binary as
 * UTF-8 would garble the rail — and the component loads bytes itself.
 */
export function previewKindNeedsBytes(kind: PreviewKind): boolean {
  return (
    kind === 'image' || kind === 'pdf' || kind === 'docx' ||
    kind === 'xlsx' || kind === 'pptx' || kind === 'model3d'
  );
}

/** Short human label for the peek meta row (e.g. "Markdown", "PDF"). */
export function previewKindLabel(kind: PreviewKind): string {
  switch (kind) {
    case 'markdown': return 'Markdown';
    case 'html': return 'HTML';
    case 'csv': return 'Table';
    case 'image': return 'Image';
    case 'pdf': return 'PDF';
    case 'docx': return 'Word';
    case 'xlsx': return 'Excel';
    case 'pptx': return 'Slides';
    case 'model3d': return '3D';
    case 'dxf': return 'CAD';
    case 'gerber': return 'Gerber';
    case 'text': return 'Text';
  }
}
