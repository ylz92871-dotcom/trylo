// Trylo Desktop — preview kind dispatch (base capability).
//
// Pure, IO-free mapping from a file path to the rich preview the
// shared FilePeek should render. Used by BOTH Code and Work surfaces:
// every in-app peek funnels through FilePeek, so extending this matrix
// upgrades both modes at once.
//
// Consumers import this catalog rather than maintaining another format list:
//   - Work artifact dispatch shares these classifications.
//   - Artifact cards use the same format families and preview capabilities.
//
// Office uses the independently supplied local page engine. Archives use a
// bounded byte provider; proprietary CAD retains external-open fallback.

import { SOURCE_LANGUAGES, sourceLanguageFor } from './languages';
import { MEDIA_FORMATS } from './media-formats';

export type PreviewKind =
  | 'code'
  | 'notebook'
  | 'font'
  | 'archive'
  | 'markdown'
  | 'html'
  | 'csv'
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'office'
  | 'unsupported'
  | 'model3d'
  | 'dxf'
  | 'gerber'
  | 'text';

const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.markdown',
]);

const CONVERTED_DOCUMENT_EXTENSIONS = new Set(['.doc', '.rtf', '.odt', '.ott']);
const CONVERTED_PRESENTATION_EXTENSIONS = new Set(['.ppt', '.odp', '.otp']);
const CONVERTED_OFFICE_EXTENSIONS = new Set([...CONVERTED_DOCUMENT_EXTENSIONS, ...CONVERTED_PRESENTATION_EXTENSIONS]);
const UNSUPPORTED_EXTENSIONS = new Set(['.sldprt', '.sldasm', '.slddrw', '.dwg', '.fcstd', '.blend', '.exe', '.dll', '.bin', '.wasm', '.sqlite', '.db', '.pages', '.numbers', '.key']);
const FONT_EXTENSIONS = new Set(['.woff', '.woff2', '.ttf', '.otf']);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.jar', '.war', '.whl', '.nupkg', '.vsix', '.rar', '.7z', '.tar', '.gz', '.gzip', '.tgz', '.bz2', '.tbz', '.tbz2', '.xz', '.txz', '.lzma', '.zst', '.zstd', '.tzst', '.cpio', '.ar']);

const HTML_EXTENSIONS: ReadonlySet<string> = new Set(['.html', '.htm']);

const CSV_EXTENSIONS: ReadonlySet<string> = new Set(['.csv', '.tsv']);
const AUDIO_EXTENSIONS = new Set(Object.entries(MEDIA_FORMATS).filter(([, format]) => format.kind === 'audio').map(([ext]) => `.${ext}`));
const VIDEO_EXTENSIONS = new Set(Object.entries(MEDIA_FORMATS).filter(([, format]) => format.kind === 'video' && !format.ambiguous).map(([ext]) => `.${ext}`));

// Shared with host dispatch and output discovery through this catalog.
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

// Three.js loaders handle scene formats; the isolated OCCT worker supplies
// meshes for STEP / IGES / BREP through the same model view.
const MODEL_EXTENSIONS: ReadonlySet<string> = new Set([
  '.stl', '.obj', '.glb', '.gltf', '.3mf', '.step', '.stp', '.iges', '.igs', '.brep', '.brp',
]);

const GERBER_EXTENSIONS: ReadonlySet<string> = new Set([
  '.gbr', '.ger', '.pho',
  '.gtl', '.gbl', '.gts', '.gbs', '.gto', '.gbo', '.gtp', '.gbp',
  '.gm1', '.gko', '.gm3',
  '.drl', '.xln', '.exc', '.ncd',
]);

/** Known suffix inventory for format consumers. Run-output ownership is
 * deliberately format-agnostic; this is not a collection whitelist. */
export const OUTPUT_EXTENSIONS: readonly string[] = [...new Set([
  ...MARKDOWN_EXTENSIONS, ...HTML_EXTENSIONS, ...CSV_EXTENSIONS,
  ...IMAGE_EXTENSIONS, ...DOCX_EXTENSIONS, ...XLSX_EXTENSIONS, ...PPTX_EXTENSIONS,
  ...CONVERTED_OFFICE_EXTENSIONS, ...MODEL_EXTENSIONS, ...GERBER_EXTENSIONS,
  '.pdf', '.dxf', '.txt', '.json', '.xml', '.yaml', '.yml', '.rst', '.ipynb',
  ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS,
  ...FONT_EXTENSIONS, ...ARCHIVE_EXTENSIONS,
  ...SOURCE_LANGUAGES.flatMap((language) => language.extensions),
  '.step', '.stp', '.iges', '.igs', '.dwg', '.sldprt', '.sldasm',
])];

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
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.ipynb') return 'notebook';
  if (FONT_EXTENSIONS.has(ext)) return 'font';
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive';
  if (DOCX_EXTENSIONS.has(ext)) return 'docx';
  if (XLSX_EXTENSIONS.has(ext)) return 'xlsx';
  if (PPTX_EXTENSIONS.has(ext)) return 'pptx';
  if (CONVERTED_OFFICE_EXTENSIONS.has(ext)) return 'office';
  if (UNSUPPORTED_EXTENSIONS.has(ext)) return 'unsupported';
  if (MODEL_EXTENSIONS.has(ext)) return 'model3d';
  if (ext === '.dxf') return 'dxf';
  if (GERBER_EXTENSIONS.has(ext)) return 'gerber';
  return sourceLanguageFor(path).id === 'plaintext' ? 'text' : 'code';
}

/** The card family is independent of whether an installed reader can open it. */
export type ArtifactCardKind = 'document' | 'presentation' | 'spreadsheet' | 'web' | 'file';

export function artifactCardKindFor(path: string): ArtifactCardKind {
  const extension = previewExtOf(path);
  switch (previewKindFor(path)) {
    case 'markdown':
    case 'docx': return 'document';
    case 'pptx': return 'presentation';
    case 'xlsx':
    case 'csv': return 'spreadsheet';
    case 'html': return 'web';
    case 'office': return CONVERTED_PRESENTATION_EXTENSIONS.has(extension) ? 'presentation' : 'document';
    default:
      // Keep native/cloud documents recognizable while their opener stays external.
      if (extension === '.pages') return 'document';
      if (extension === '.numbers' || extension === '.gsheet') return 'spreadsheet';
      return 'file';
  }
}

export function artifactCardCanPreview(kind: ArtifactCardKind, path: string): boolean {
  // Generic outputs delegate to Desktop's content-aware dispatch (PDF, CAD, etc.).
  if (kind === 'file') return true;
  if (artifactCardKindFor(path) !== kind) return false;
  const preview = previewKindFor(path);
  return preview === 'markdown' || preview === 'docx' || preview === 'pptx'
    || preview === 'xlsx' || preview === 'csv' || preview === 'html' || preview === 'office';
}

/**
 * True when the renderer needs raw bytes (not the UTF-8 text `content`).
 * App.onSelectFile skips the text read for these — decoding binary as
 * UTF-8 would garble the rail — and the component loads bytes itself.
 */
export function previewKindNeedsBytes(kind: PreviewKind): boolean {
  return (
    kind === 'image' || kind === 'font' || kind === 'archive' || kind === 'audio' || kind === 'video' || kind === 'pdf' || kind === 'docx' ||
    kind === 'xlsx' || kind === 'pptx' || kind === 'model3d' || kind === 'office' || kind === 'unsupported'
  );
}

/** Short human label for the peek meta row (e.g. "Markdown", "PDF"). */
export function previewKindLabel(kind: PreviewKind): string {
  switch (kind) {
    case 'markdown': return 'Markdown';
    case 'html': return 'HTML';
    case 'csv': return 'Table';
    case 'image': return 'Image';
    case 'audio': return 'Audio';
    case 'video': return 'Video';
    case 'pdf': return 'PDF';
    case 'docx': return 'Word';
    case 'xlsx': return 'Excel';
    case 'pptx': return 'Slides';
    case 'office': return 'Office';
    case 'unsupported': return 'File';
    case 'model3d': return '3D';
    case 'dxf': return 'CAD';
    case 'gerber': return 'Gerber';
    case 'text': return 'Text';
    case 'notebook': return 'Notebook';
    case 'font': return 'Font';
    case 'archive': return 'Archive';
    case 'code': return 'Code';
  }
}
