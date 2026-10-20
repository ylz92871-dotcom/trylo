import type { JsonObject, JsonValue } from "../../../protocol/envelope.js";
import type { FileAccessMode, ToolCallRequest, ToolOutcome } from "../../../ports/tools.js";
import {
  API_PDF_MAX_PAGES,
  PDF_MAX_PAGES_PER_READ,
  checkPdfMagic,
  checkPdfRangeSize,
  checkPdfSize,
  describePdfForLog,
  isPdfPath,
  parsePdfPageRange,
  type PdfPageRange,
} from "../../media/pdf-guard.js";
import { readStringArg } from "./args.js";
import type { FileSystemReader } from "./limits.js";
import { resolveInsideWorkspace } from "./workspace.js";

export const READ_PDF_TOOL = "read_pdf";

export type PdfExtractedPage = {
  readonly page: number;
  readonly bytes: number;
  readonly mediaType: string;
  readonly dataBase64: string;
};

export type PdfExtractResult =
  | { readonly ok: true; readonly pages: ReadonlyArray<PdfExtractedPage> }
  | {
    readonly ok: false;
    readonly code: "password_protected" | "corrupted" | "unavailable" | "too_large" | "unknown";
    readonly message: string;
  };

/**
 * Poppler-backed operations behind an injection seam. The default (below)
 * reports `unavailable`: page counts and page images need `pdfinfo`/`pdftoppm`
 * on the machine, and a tool that pretends otherwise would hand the model a
 * page count it never measured. Tests inject a stub; production installs a
 * real runner when poppler is present (verified at WP28 install acceptance).
 */
export type PdfRunner = {
  getPageCount(absolutePath: string): Promise<number | null>;
  extractPages(absolutePath: string, range: PdfPageRange): Promise<PdfExtractResult>;
};

export const UNAVAILABLE_PDF_RUNNER: PdfRunner = {
  getPageCount: () => Promise.resolve(null),
  extractPages: () =>
    Promise.resolve({
      ok: false as const,
      code: "unavailable" as const,
      message:
        "unavailable: page rendering needs poppler-utils (pdfinfo/pdftoppm); install it to read page ranges",
    }),
};

export type PdfReadConfig = {
  readonly workspaceRoot: string;
  readonly fileAccess?: FileAccessMode;
  readonly workspaceAlias?: string;
  readonly reader: FileSystemReader;
  readonly runner?: PdfRunner | undefined;
};

function fail(code: string, message: string): ToolOutcome {
  return { outcome: "error", code, message };
}

/**
 * `read_pdf` (WP13.1: L11).
 *
 * Whole-document reads validate magic + size and hand the payload to the
 * structured value (redacted summary in text, like `view_image`); the
 * provider wire that attaches `application/pdf` blocks is WP18's聯验, so no
 * wire format is invented here. Ranged reads validate the range before any
 * file is touched and refuse unbounded, over-ceiling, or out-of-bounds ranges
 * with named codes instead of extracting whatever happens to exist.
 */
export async function executeReadPdf(
  config: PdfReadConfig,
  call: ToolCallRequest,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const requested = readStringArg(call.arguments, "path");
  if (requested === undefined) {
    return fail("invalid_arguments", "read_pdf requires path");
  }
  if (!isPdfPath(requested)) {
    return fail("invalid_arguments", "read_pdf only reads .pdf files; use read_file for text");
  }
  // Parsed before the file is touched: a bad range must not cost a read.
  const pagesText = readStringArg(call.arguments, "pages");
  let range: PdfPageRange | undefined;
  if (pagesText !== undefined) {
    const parsed = parsePdfPageRange(pagesText);
    if (parsed === undefined) {
      return fail(
        "invalid_arguments",
        `read_pdf: invalid pages ${JSON.stringify(pagesText)}; use "1-5", "3", or "3-"`,
      );
    }
    // Closed ranges are bounded before any file is touched. Open-ended ranges
    // ("3-") stay syntactic until the measured page count bounds them in
    // `readPageRange`; an unmeasurable count refuses there, never here.
    if (parsed.lastPage !== Infinity) {
      const sized = checkPdfRangeSize(parsed);
      if (!sized.ok) {
        return fail("page_range_too_large", sized.message);
      }
    }
    range = parsed;
  }
  const verdict = resolveInsideWorkspace(config.workspaceRoot, requested, config.fileAccess, config.workspaceAlias);
  if (!verdict.ok) {
    return fail(verdict.code, verdict.code);
  }
  if (signal.aborted) {
    return { outcome: "cancelled" };
  }
  const readBytes = config.reader.readFileBytes;
  if (readBytes === undefined) {
    return fail("bytes_unavailable", "bytes_unavailable: this filesystem reader serves text only");
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(verdict.absolutePath, signal);
  } catch (error) {
    if (signal.aborted) {
      return { outcome: "cancelled" };
    }
    const detail = error instanceof Error ? error.message : "read_error";
    return fail("read_failed", `read_failed:${detail}`);
  }
  if (signal.aborted) {
    return { outcome: "cancelled" };
  }
  // Size before magic, mirroring legacy `readPDF`: an empty file is empty,
  // not "invalid", and an over-ceiling file refuses without a magic read.
  const sized = checkPdfSize(bytes.length);
  if (!sized.ok) {
    return fail(sized.code, sized.message);
  }
  const magic = checkPdfMagic(bytes);
  if (!magic.ok) {
    return fail(magic.code, magic.message);
  }
  const runner = config.runner ?? UNAVAILABLE_PDF_RUNNER;
  if (range === undefined) {
    return readWholeDocument(runner, requested, verdict.absolutePath, bytes, signal);
  }
  return readPageRange(runner, requested, verdict.absolutePath, bytes, range, signal);
}

async function readWholeDocument(
  runner: PdfRunner,
  requested: string,
  absolutePath: string,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  let pageCount: number | null;
  try {
    pageCount = await runner.getPageCount(absolutePath);
  } catch (error) {
    if (signal.aborted) {
      return { outcome: "cancelled" };
    }
    const detail = error instanceof Error ? error.message : "runner_error";
    return fail("page_count_failed", `page_count_failed:${detail}`);
  }
  if (signal.aborted) {
    return { outcome: "cancelled" };
  }
  if (pageCount !== null && pageCount > API_PDF_MAX_PAGES) {
    return fail(
      "pdf_too_many_pages",
      `pdf_too_many_pages: document has ${pageCount} pages (max ${API_PDF_MAX_PAGES}); read a page range with pages instead`,
    );
  }
  // The payload travels in the structured value for the provider wire to
  // attach (WP18聯验); the text stays a redacted summary so the transcript is
  // not taxed with megabytes of base64 every later turn. Same shape as
  // `view_image`: never logged, never persisted as a session fact in v1.
  const value: JsonObject = {
    path: requested,
    bytes: bytes.length,
    ...(pageCount === null ? {} : { pageCount }),
    mediaType: "application/pdf",
    dataUrl: `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}`,
  };
  const summary = describePdfForLog({ path: requested, bytes: bytes.length, pageCount: pageCount ?? undefined });
  return { outcome: "result", value, output: `${summary} path=${JSON.stringify(requested)}`, truncated: false };
}

async function readPageRange(
  runner: PdfRunner,
  requested: string,
  absolutePath: string,
  bytes: Uint8Array,
  range: PdfPageRange,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  let pageCount: number | null;
  try {
    pageCount = await runner.getPageCount(absolutePath);
  } catch (error) {
    if (signal.aborted) {
      return { outcome: "cancelled" };
    }
    const detail = error instanceof Error ? error.message : "runner_error";
    return fail("page_count_failed", `page_count_failed:${detail}`);
  }
  if (signal.aborted) {
    return { outcome: "cancelled" };
  }
  // An open-ended range without a measured count is unbounded work: refuse,
  // do not extract "whatever comes out".
  let lastPage: number;
  if (range.lastPage === Infinity) {
    if (pageCount === null) {
      return fail(
        "page_count_unknown",
        "page_count_unknown: cannot read an open-ended page range without a measured page count",
      );
    }
    lastPage = pageCount;
  } else {
    lastPage = pageCount === null ? range.lastPage : Math.min(range.lastPage, pageCount);
  }
  if (pageCount !== null && range.firstPage > pageCount) {
    return fail(
      "page_range_out_of_bounds",
      `page_range_out_of_bounds: pages start at ${range.firstPage} but the document has ${pageCount} pages`,
    );
  }
  const count = lastPage - range.firstPage + 1;
  if (count > PDF_MAX_PAGES_PER_READ) {
    return fail(
      "page_range_too_large",
      `page_range_too_large: ${count} pages exceed the ${PDF_MAX_PAGES_PER_READ} page ceiling per read after bounding to the document`,
    );
  }
  let extracted: PdfExtractResult;
  try {
    extracted = await runner.extractPages(absolutePath, { firstPage: range.firstPage, lastPage });
  } catch (error) {
    if (signal.aborted) {
      return { outcome: "cancelled" };
    }
    const detail = error instanceof Error ? error.message : "runner_error";
    return fail("extraction_failed", `extraction_failed:${detail}`);
  }
  if (signal.aborted) {
    return { outcome: "cancelled" };
  }
  if (!extracted.ok) {
    return fail(extracted.code, extracted.message);
  }
  const parts: JsonValue[] = extracted.pages.map((page) => ({
    page: page.page,
    bytes: page.bytes,
    mediaType: page.mediaType,
    dataBase64: page.dataBase64,
  }));
  const value: JsonObject = {
    path: requested,
    bytes: bytes.length,
    ...(pageCount === null ? {} : { pageCount }),
    range: { firstPage: range.firstPage, lastPage, count: extracted.pages.length },
    parts,
  };
  const summary = describePdfForLog({ path: requested, bytes: bytes.length, pageCount: pageCount ?? undefined });
  return {
    outcome: "result",
    value,
    output: `${summary} pages=${range.firstPage}-${lastPage} (${extracted.pages.length} rendered) path=${JSON.stringify(requested)}`,
    truncated: false,
  };
}
