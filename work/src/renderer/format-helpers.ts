// Trylo Work — artifact format helpers. See README.md.
//
// Consolidated from CoWork-OS's `src/shared/{document,presentation,
// spreadsheet,web-page}-formats.ts` (committed 0.5.51). Each function
// is a pure data lookup (extension sets + label switch). No React,
// no IPC, no fs — easy to unit test and safe to import anywhere.
//
// See vendor/cowork-os/src/shared/document-formats.ts (and the three
// siblings) for the originals. Changes there should be mirrored here
// during a vendor refresh.

const WORD_DOCUMENT_ARTIFACT_EXTENSIONS = new Set([
  ".md", ".markdown", ".docx", ".docm", ".dotx", ".dotm",
  ".doc", ".rtf", ".odt", ".ott", ".pages",
]);

// In-app renderers live in desktop/src/components/preview/ — these sets
// must mirror previewKind.ts. Legacy binary Office (.doc/.ppt) and
// .rtf/.odt have no renderer and stay on the OS viewer.
const IN_APP_DOCUMENT_PREVIEW_EXTENSIONS = new Set([
  ".md", ".markdown", ".docx", ".docm", ".dotx", ".dotm",
]);

const EDITABLE_DOCUMENT_EXTENSIONS = new Set([".docx"]);

const PRESENTATION_ARTIFACT_EXTENSIONS = new Set([
  ".pptx", ".ppt", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm",
]);

// OOXML only — pptxviewjs cannot parse legacy .ppt (host-open).
const IN_APP_PRESENTATION_EXTENSIONS = new Set([
  ".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm",
]);

const IN_APP_SPREADSHEET_EXTENSIONS = new Set([
  ".xlsx", ".xls", ".xlsm", ".xlsb", ".ods", ".csv", ".tsv",
]);

const SPREADSHEET_ARTIFACT_EXTENSIONS = new Set([
  ".xlsx", ".xls", ".xlsm", ".xlsb", ".csv", ".tsv",
  ".ods", ".numbers", ".gsheet",
]);

const WEB_PAGE_EXTENSIONS = new Set([".html", ".htm"]);

function getFileExtension(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  const match = /\.([^.]+)$/.exec(fileName);
  // `match[1]` is `string | undefined` under noUncheckedIndexedAccess.
  // `.` guarantees a non-empty capture when the regex matches, so
  // the fallback `""` is only hit on a no-match.
  return match?.[1] ? `.${match[1].toLowerCase()}` : "";
}

function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

// ── Document (Word / markdown / RTF) ────────────────────────────────

export function getDocumentFormatLabel(filePath: string): string {
  switch (getFileExtension(filePath)) {
    case ".md":       return "MD";
    case ".markdown": return "Markdown";
    case ".docx":     return "DOCX";
    case ".docm":     return "DOCM";
    case ".dotx":     return "DOTX";
    case ".dotm":     return "DOTM";
    case ".doc":      return "DOC";
    case ".rtf":      return "RTF";
    case ".odt":      return "ODT";
    case ".ott":      return "OTT";
    case ".pages":    return "Pages";
    default:          return "Document";
  }
}

export function isWordDocumentArtifactFile(filePath: string): boolean {
  return WORD_DOCUMENT_ARTIFACT_EXTENSIONS.has(getFileExtension(filePath));
}

export function canPreviewDocumentInApp(filePath: string): boolean {
  return IN_APP_DOCUMENT_PREVIEW_EXTENSIONS.has(getFileExtension(filePath));
}

export function canEditDocumentInApp(filePath: string): boolean {
  return EDITABLE_DOCUMENT_EXTENSIONS.has(getFileExtension(filePath));
}

// ── Presentation (PowerPoint / Keynote) ────────────────────────────

export function getPresentationFormatLabel(filePath: string): string {
  switch (getFileExtension(filePath)) {
    case ".pptx": return "PPTX";
    case ".ppt":  return "PPT";
    case ".pptm": return "PPTM";
    case ".potx": return "POTX";
    case ".potm": return "POTM";
    case ".ppsx": return "PPSX";
    case ".ppsm": return "PPSM";
    default:      return "Presentation";
  }
}

export function isPresentationArtifactFile(filePath: string): boolean {
  return PRESENTATION_ARTIFACT_EXTENSIONS.has(getFileExtension(filePath));
}

export function canPreviewPresentationInApp(filePath: string): boolean {
  return IN_APP_PRESENTATION_EXTENSIONS.has(getFileExtension(filePath));
}

// ── Spreadsheet (Excel / Numbers / CSV) ─────────────────────────────

export function getSpreadsheetFormatLabel(filePath: string): string {
  switch (getFileExtension(filePath)) {
    case ".xlsx":    return "XLSX";
    case ".xls":     return "XLS";
    case ".xlsm":    return "XLSM";
    case ".xlsb":    return "XLSB";
    case ".csv":     return "CSV";
    case ".tsv":     return "TSV";
    case ".ods":     return "ODS";
    case ".numbers": return "Numbers";
    case ".gsheet":  return "Google Sheets";
    default:         return "Spreadsheet";
  }
}

export function isSpreadsheetArtifactFile(filePath: string): boolean {
  return SPREADSHEET_ARTIFACT_EXTENSIONS.has(getFileExtension(filePath));
}

export function canOpenSpreadsheetInApp(filePath: string): boolean {
  return IN_APP_SPREADSHEET_EXTENSIONS.has(getFileExtension(filePath));
}

// ── Web (HTML) ──────────────────────────────────────────────────────

export function getWebPageFormatLabel(filePath: string): string {
  const ext = getFileExtension(filePath);
  if (ext === ".htm")  return "HTM";
  if (ext === ".html") return "HTML";
  return "Web";
}

export function isWebPageArtifactFile(filePath: string): boolean {
  return WEB_PAGE_EXTENSIONS.has(getFileExtension(filePath));
}

export function canPreviewWebPageInApp(filePath: string): boolean {
  return isWebPageArtifactFile(filePath);
}

// ── Dispatch helpers (the "which card should I render?" question) ──

export type ArtifactKind = "document" | "presentation" | "spreadsheet" | "web" | "file";

/** One produced file as it appears in the Work surface
 *  (inline ArtifactCard / Artifact Dock). The host decides
 *  whether `filePath` is absolute or workspace-relative; the
 *  renderer never resolves paths. */
export interface Artifact {
  readonly filePath: string;
  /** Optional override; if absent the UI calls
   *  `detectArtifactKind`. */
  readonly kind?: ArtifactKind;
  /** Optional human label shown above the card. */
  readonly title?: string;
  /** ms-since-epoch. Used for the "generated/updated"
   *  caption. */
  readonly createdAt?: number;
}

export function detectArtifactKind(filePath: string): ArtifactKind {
  if (isWordDocumentArtifactFile(filePath))  return "document";
  if (isPresentationArtifactFile(filePath))  return "presentation";
  if (isSpreadsheetArtifactFile(filePath))   return "spreadsheet";
  if (isWebPageArtifactFile(filePath))       return "web";
  // P2-1 (spec §8.6): unknown-extension outputs are generic FILEs, not
  // pretend documents. The card keeps Open / Show in folder / Copy path
  // without a fabricated Office "Open with" suggestion.
  return "file";
}

export function getArtifactFormatLabel(kind: ArtifactKind, filePath: string): string {
  switch (kind) {
    case "document":     return getDocumentFormatLabel(filePath);
    case "presentation": return getPresentationFormatLabel(filePath);
    case "spreadsheet":  return getSpreadsheetFormatLabel(filePath);
    case "web":          return getWebPageFormatLabel(filePath);
    case "file":         return "File";
  }
}

export function canOpenArtifactInApp(kind: ArtifactKind, filePath: string): boolean {
  switch (kind) {
    case "document":     return canPreviewDocumentInApp(filePath);
    case "presentation": return canPreviewPresentationInApp(filePath);
    case "spreadsheet":  return canOpenSpreadsheetInApp(filePath);
    case "web":          return canPreviewWebPageInApp(filePath);
    case "file":         return false; // generic files open with the OS default
  }
}

export { getFileExtension, getFileName };
