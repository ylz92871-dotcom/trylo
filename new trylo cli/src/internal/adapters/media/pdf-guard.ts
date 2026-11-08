/**
 * PDF boundary guard (WP13.1: L11).
 *
 * Pure mechanical layer ported from the legacy CLI, no filesystem, no clock,
 * no randomness, no process surface: bytes and strings in, verdicts out.
 *
 * Reuse (mechanical layer only, types stay Trylo-owned):
 * - legacy `src/utils/pdfUtils.ts` — `parsePDFPageRange`, `isPDFExtension`;
 * - legacy `src/utils/pdf.ts` — `%PDF-` magic check, the empty/too_large/
 *   password_protected/corrupted/unavailable taxonomy, poppler-missing refusal;
 * - legacy `src/constants/apiLimits.ts` — the size and page ceilings below.
 *
 * What deliberately differs from legacy: legacy decides "inline base64 vs page
 * extraction" from the *model* (`isPDFSupported`) and file size. Trylo owns no
 * model-gated branch here — that choice belongs to the provider wire owner
 * (WP18) — so this guard only states the facts (magic, size, page range) and
 * the ceilings. Whether the caller renders pages or ships base64 is decided by
 * the injected runner in `read-only/pdf-read.ts`, which fails closed with
 * `unavailable` when no poppler-backed runner is installed.
 */

/** Raw bytes that still fit a single request after base64 (legacy `PDF_TARGET_RAW_SIZE`). */
export const PDF_TARGET_RAW_SIZE = 20 * 1024 * 1024;

/** Raw bytes beyond which even the page-extraction path refuses (legacy `PDF_MAX_EXTRACT_SIZE`). */
export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024;

/** Pages per single ranged read (legacy `PDF_MAX_PAGES_PER_READ`). */
export const PDF_MAX_PAGES_PER_READ = 20;

/** Pages beyond which the provider refuses the document (legacy `API_PDF_MAX_PAGES`). */
export const API_PDF_MAX_PAGES = 100;

export type PdfPageRange = {
  readonly firstPage: number;
  readonly lastPage: number;
};

/**
 * Parse a page range string into 1-indexed first/last pages.
 *
 * Ported from legacy `parsePDFPageRange`: `"5"` is one page, `"1-10"` is a
 * closed range, `"3-"` is open-ended (`lastPage: Infinity`). Anything else —
 * empty, zero, inverted, non-numeric — is `undefined`, never a guess.
 */
export function parsePdfPageRange(pages: string): PdfPageRange | undefined {
  const trimmed = pages.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (trimmed.endsWith("-")) {
    const first = Number.parseInt(trimmed.slice(0, -1), 10);
    if (Number.isNaN(first) || first < 1) {
      return undefined;
    }
    return { firstPage: first, lastPage: Infinity };
  }

  const dash = trimmed.indexOf("-");
  if (dash === -1) {
    const page = Number.parseInt(trimmed, 10);
    if (Number.isNaN(page) || page < 1) {
      return undefined;
    }
    return { firstPage: page, lastPage: page };
  }

  const first = Number.parseInt(trimmed.slice(0, dash), 10);
  const last = Number.parseInt(trimmed.slice(dash + 1), 10);
  if (Number.isNaN(first) || Number.isNaN(last) || first < 1 || last < 1 || last < first) {
    return undefined;
  }

  return { firstPage: first, lastPage: last };
}

/**
 * Pages a range would read. `Infinity` for open-ended ranges: the caller must
 * refuse those (`page_range_too_large`) unless a page count bounds them first.
 */
export function pdfRangeSize(range: PdfPageRange): number {
  return range.lastPage === Infinity ? Infinity : range.lastPage - range.firstPage + 1;
}

/** Refuse an unbounded or over-ceiling range before any file is touched. */
export function checkPdfRangeSize(range: PdfPageRange): { readonly ok: true } | { readonly ok: false; readonly code: "page_range_too_large"; readonly message: string } {
  if (pdfRangeSize(range) > PDF_MAX_PAGES_PER_READ) {
    return {
      ok: false,
      code: "page_range_too_large",
      message: `page_range_too_large: pages ${range.firstPage}-${range.lastPage} exceed the ${PDF_MAX_PAGES_PER_READ} page ceiling per read`,
    };
  }
  return { ok: true };
}

/** Extension allowlist, mirrored from legacy `isPDFExtension` (dot optional, case-insensitive). */
export function isPdfExtension(extension: string): boolean {
  const bare = extension.startsWith(".") ? extension.slice(1) : extension;
  return bare.toLowerCase() === "pdf";
}

/** Path suffix check: `.pdf` in any case, nothing else qualifies. */
export function isPdfPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".pdf");
}

/**
 * Magic-byte check, ported from legacy `readPDF`: the first five bytes must be
 * `%PDF-`. A renamed HTML file is `invalid_pdf` here, not a document the model
 * will choke on three turns later (legacy comment: an invalid document block
 * poisons every subsequent request until `/clear`).
 */
export function checkPdfMagic(bytes: Uint8Array): { readonly ok: true } | { readonly ok: false; readonly code: "invalid_pdf"; readonly message: string } {
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    code: "invalid_pdf",
    message: "invalid_pdf: file is not a valid PDF (missing %PDF- header)",
  };
}

export type PdfSizeVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "empty_file" | "too_large"; readonly message: string };

/**
 * Size gate with two ceilings: empty is empty, anything over the request target
 * is `too_large` for the document path, and anything over the extraction max is
 * too large for any path. The caller reports which ceiling fired.
 */
export function checkPdfSize(byteLength: number): PdfSizeVerdict {
  if (byteLength === 0) {
    return { ok: false, code: "empty_file", message: "empty_file: PDF file is empty" };
  }

  if (byteLength > PDF_MAX_EXTRACT_SIZE) {
    return {
      ok: false,
      code: "too_large",
      message: `too_large: ${byteLength} bytes exceed the ${PDF_MAX_EXTRACT_SIZE} byte extraction ceiling`,
    };
  }

  if (byteLength > PDF_TARGET_RAW_SIZE) {
    return {
      ok: false,
      code: "too_large",
      message: `too_large: ${byteLength} bytes exceed the ${PDF_TARGET_RAW_SIZE} byte document ceiling; use a page range instead`,
    };
  }

  return { ok: true };
}

/** Redacted one-line summary for logs and tool output: never the payload. */
export function describePdfForLog(input: {
  readonly path: string;
  readonly bytes: number;
  readonly pageCount: number | undefined;
}): string {
  const pages = input.pageCount === undefined ? "pages=unknown" : `pages=${input.pageCount}`;
  return `<pdf ${input.bytes} bytes ${pages} path=${JSON.stringify(input.path)}>`;
}
