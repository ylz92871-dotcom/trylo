import assert from "node:assert/strict";
import { test } from "node:test";
import {
  API_PDF_MAX_PAGES,
  PDF_MAX_EXTRACT_SIZE,
  PDF_MAX_PAGES_PER_READ,
  PDF_TARGET_RAW_SIZE,
  checkPdfMagic,
  checkPdfRangeSize,
  checkPdfSize,
  describePdfForLog,
  isPdfExtension,
  isPdfPath,
  parsePdfPageRange,
  pdfRangeSize,
} from "./pdf-guard.js";

/**
 * WP13.1 (L11) red cover: every refusal the `read_pdf` executor can return is
 * decided here, in pure functions, before any file is touched. A case that
 * fails here fails the same way through the tool — the executor adds IO, not
 * judgment.
 */

test("page ranges parse: single, closed, and open-ended; garbage refuses", () => {
  assert.deepEqual(parsePdfPageRange("1-5"), { firstPage: 1, lastPage: 5 });
  assert.deepEqual(parsePdfPageRange("3"), { firstPage: 3, lastPage: 3 });
  assert.deepEqual(parsePdfPageRange("3-"), { firstPage: 3, lastPage: Infinity });
  assert.deepEqual(parsePdfPageRange("1-"), { firstPage: 1, lastPage: Infinity });

  for (const bad of ["", "0", "5-2", "abc", "-3", "0-5", "-"]) {
    assert.equal(parsePdfPageRange(bad), undefined, JSON.stringify(bad));
  }
});

test("range sizes: 20 pages pass, 21 refuse, open-ended refuses until bounded", () => {
  assert.equal(checkPdfRangeSize({ firstPage: 1, lastPage: 20 }).ok, true);
  const over = checkPdfRangeSize({ firstPage: 1, lastPage: 21 });

  assert.equal(over.ok, false);

  if (!over.ok) {
    assert.equal(over.code, "page_range_too_large");
  }

  assert.equal(pdfRangeSize({ firstPage: 3, lastPage: Infinity }), Infinity);
  assert.equal(checkPdfRangeSize({ firstPage: 3, lastPage: Infinity }).ok, false);
  assert.equal(PDF_MAX_PAGES_PER_READ, 20);
});

test("only .pdf qualifies, in any case, with or without the dot", () => {
  assert.equal(isPdfExtension("pdf"), true);
  assert.equal(isPdfExtension(".PDF"), true);
  assert.equal(isPdfExtension("png"), false);
  assert.equal(isPdfPath("docs/spec.pdf"), true);
  assert.equal(isPdfPath("docs/SPEC.PDF"), true);
  assert.equal(isPdfPath("docs/spec.pdf.txt"), false);
  assert.equal(isPdfPath("docs/pdf"), false);
});

test("magic bytes decide: %PDF- passes, renamed HTML and short files refuse", () => {
  const real = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

  assert.equal(checkPdfMagic(real).ok, true);
  const html = Uint8Array.from(Buffer.from("<html>renamed</html>", "utf8"));
  const renamed = checkPdfMagic(html);

  assert.equal(renamed.ok, false);

  if (!renamed.ok) {
    assert.equal(renamed.code, "invalid_pdf");
  }

  assert.equal(checkPdfMagic(new Uint8Array(0)).ok, false);
  assert.equal(checkPdfMagic(Uint8Array.from([0x25, 0x50])).ok, false);
});

test("sizes: empty refuses, document ceiling and extraction ceiling refuse separately", () => {
  assert.deepEqual(checkPdfSize(0).ok, false);
  const empty = checkPdfSize(0);
  if (!empty.ok) {
    assert.equal(empty.code, "empty_file");
  }

  assert.equal(checkPdfSize(1024).ok, true);
  assert.equal(checkPdfSize(PDF_TARGET_RAW_SIZE).ok, true);
  const overDocument = checkPdfSize(PDF_TARGET_RAW_SIZE + 1);

  assert.equal(overDocument.ok, false);

  if (!overDocument.ok) {
    assert.equal(overDocument.code, "too_large");
  }

  const overExtract = checkPdfSize(PDF_MAX_EXTRACT_SIZE + 1);

  assert.equal(overExtract.ok, false);

  if (!overExtract.ok) {
    assert.equal(overExtract.code, "too_large");
  }

  assert.equal(API_PDF_MAX_PAGES, 100);
});

test("log summaries name the file, never the payload", () => {
  const summary = describePdfForLog({ path: "docs/spec.pdf", bytes: 41, pageCount: 3 });
  assert.ok(summary.includes("docs/spec.pdf"));
  assert.ok(summary.includes("pages=3"));
  assert.ok(!summary.includes("%PDF"));
  assert.ok(describePdfForLog({ path: "x.pdf", bytes: 1, pageCount: undefined }).includes("pages=unknown"));
});
