import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject } from "../../../protocol/envelope.js";
import type { ToolCallRequest } from "../../../ports/tools.js";
import { createReadOnlyTools } from "./index.js";
import { createNodeFileSystemReader } from "./node-fs.js";
import { READ_NOTEBOOK_TOOL } from "./notebook-read.js";
import { executeReadPdf, READ_PDF_TOOL, type PdfRunner } from "./pdf-read.js";

/**
 * WP13.1 (L11) green cover through the real read-only ToolPort.
 *
 * Page counts and page images come from an injected stub runner: this machine
 * has no poppler, and the point under test is the Trylo boundary (validation
 * order, refusals, redaction), not poppler itself. The uninstallable path —
 * no runner at all — is covered by the `unavailable` case, which is the
 * production default.
 */

const MINIMAL_PDF = "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF";

function tempRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-pdf-read-"));
}

function callFor(name: string, args: JsonObject): ToolCallRequest {
  return { toolCallId: "c1", name, arguments: args };
}

function stubRunner(pages: number): PdfRunner {
  return {
    getPageCount: () => Promise.resolve(pages),
    extractPages: (absolutePath, range) => {
      void absolutePath;
      const rendered = [];
      for (let page = range.firstPage; page <= range.lastPage; page += 1) {
        rendered.push({ page, bytes: 12, mediaType: "image/jpeg", dataBase64: "AAA" });
      }
      return Promise.resolve({ ok: true as const, pages: rendered });
    },
  };
}

function toolsFor(root: string, runner?: PdfRunner) {
  return createReadOnlyTools({
    workspaceRoot: root,
    reader: createNodeFileSystemReader(),
    ...(runner === undefined ? {} : { pdfRunner: runner }),
  });
}

const SIGNAL = new AbortController().signal;

test("read_pdf and read_notebook are registered in the read-only catalog", () => {
  const root = tempRoot();
  try {
    const names = toolsFor(root).snapshot().map((binding) => binding.name);
    assert.ok(names.includes(READ_PDF_TOOL));
    assert.ok(names.includes(READ_NOTEBOOK_TOOL));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-PDF paths, bad ranges, and over-ceiling ranges refuse before any read", async () => {
  const root = tempRoot();
  try {
    const tools = toolsFor(root, stubRunner(10));
    const notPdf = await tools.execute(callFor(READ_PDF_TOOL, { path: "notes.txt" }), SIGNAL);

    assert.equal(notPdf.outcome, "error");

    if (notPdf.outcome === "error") {
      assert.equal(notPdf.code, "invalid_arguments");
    }

    const badRange = await tools.execute(callFor(READ_PDF_TOOL, { path: "a.pdf", pages: "5-2" }), SIGNAL);

    assert.equal(badRange.outcome, "error");

    if (badRange.outcome === "error") {
      assert.equal(badRange.code, "invalid_arguments");
    }

    const over = await tools.execute(callFor(READ_PDF_TOOL, { path: "a.pdf", pages: "1-21" }), SIGNAL);

    assert.equal(over.outcome, "error");

    if (over.outcome === "error") {
      assert.equal(over.code, "page_range_too_large");
    }

    const outside = await tools.execute(callFor(READ_PDF_TOOL, { path: "../escape.pdf" }), SIGNAL);

    assert.equal(outside.outcome, "error");

    if (outside.outcome === "error") {
      assert.equal(outside.code, "path_outside_workspace");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renamed HTML refuses as invalid_pdf; empty refuses as empty_file", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "fake.pdf"), "<html>not a pdf</html>");
    writeFileSync(join(root, "empty.pdf"), "");
    const tools = toolsFor(root, stubRunner(2));
    const fake = await tools.execute(callFor(READ_PDF_TOOL, { path: "fake.pdf" }), SIGNAL);

    assert.equal(fake.outcome, "error");

    if (fake.outcome === "error") {
      assert.equal(fake.code, "invalid_pdf");
    }

    assert.equal(readFileUnchanged(root, "fake.pdf"), "<html>not a pdf</html>");
    const empty = await tools.execute(callFor(READ_PDF_TOOL, { path: "empty.pdf" }), SIGNAL);

    assert.equal(empty.outcome, "error");

    if (empty.outcome === "error") {
      assert.equal(empty.code, "empty_file");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readFileUnchanged(root: string, name: string): string {
  return readFileSync(join(root, name), "utf8");
}

test("whole-document read: facts in value, redacted summary in output", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "spec.pdf"), MINIMAL_PDF);
    const tools = toolsFor(root, stubRunner(3));
    const outcome = await tools.execute(callFor(READ_PDF_TOOL, { path: "spec.pdf" }), SIGNAL);

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome === "result") {
      assert.equal(outcome.value.pageCount, 3);
      assert.equal(outcome.value.mediaType, "application/pdf");
      const dataUrl = outcome.value.dataUrl;

      assert.equal(typeof dataUrl, "string");
      assert.ok((dataUrl as string).startsWith("data:application/pdf;base64,"));
      assert.ok(!outcome.output.includes(dataUrl as string));
      assert.ok(outcome.output.includes("spec.pdf"));
      assert.ok(outcome.output.includes("pages=3"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown page count stays unknown; too many pages refuse with a range hint", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "spec.pdf"), MINIMAL_PDF);
    const unknownCount = toolsFor(root, {
      getPageCount: () => Promise.resolve(null),
      extractPages: () => Promise.resolve({ ok: false as const, code: "unavailable" as const, message: "unavailable" }),
    });
    const unknown = await unknownCount.execute(callFor(READ_PDF_TOOL, { path: "spec.pdf" }), SIGNAL);

    assert.equal(unknown.outcome, "result");

    if (unknown.outcome === "result") {
      assert.equal("pageCount" in unknown.value, false);
      assert.ok(unknown.output.includes("pages=unknown"));
    }

    const huge = toolsFor(root, stubRunner(150));
    const refused = await huge.execute(callFor(READ_PDF_TOOL, { path: "spec.pdf" }), SIGNAL);

    assert.equal(refused.outcome, "error");

    if (refused.outcome === "error") {
      assert.equal(refused.code, "pdf_too_many_pages");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("page ranges render through the runner; open-ended ranges bound to the count", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "spec.pdf"), MINIMAL_PDF);
    const tools = toolsFor(root, stubRunner(4));
    const ranged = await tools.execute(callFor(READ_PDF_TOOL, { path: "spec.pdf", pages: "1-2" }), SIGNAL);

    assert.equal(ranged.outcome, "result");

    if (ranged.outcome === "result") {
      const range = ranged.value.range as JsonObject;
      assert.equal(range["firstPage"], 1);
      assert.equal(range["lastPage"], 2);
      assert.equal((ranged.value.parts as ReadonlyArray<unknown>).length, 2);
      assert.ok(ranged.output.includes("pages=1-2"));
    }

    const open = await tools.execute(callFor(READ_PDF_TOOL, { path: "spec.pdf", pages: "2-" }), SIGNAL);

    assert.equal(open.outcome, "result");

    if (open.outcome === "result") {
      const range = open.value.range as JsonObject;
      assert.equal(range["firstPage"], 2);
      assert.equal(range["lastPage"], 4);
    }

    // A closed range past the end clamps to the document instead of refusing.
    const clamped = await tools.execute(callFor(READ_PDF_TOOL, { path: "spec.pdf", pages: "3-10" }), SIGNAL);

    assert.equal(clamped.outcome, "result");

    if (clamped.outcome === "result") {
      const range = clamped.value.range as JsonObject;
      assert.equal(range["firstPage"], 3);
      assert.equal(range["lastPage"], 4);
      assert.equal((clamped.value.parts as ReadonlyArray<unknown>).length, 2);
    }

    const pastEnd = await tools.execute(callFor(READ_PDF_TOOL, { path: "spec.pdf", pages: "9-12" }), SIGNAL);

    assert.equal(pastEnd.outcome, "error");

    if (pastEnd.outcome === "error") {
      assert.equal(pastEnd.code, "page_range_out_of_bounds");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an open-ended range without a measured count refuses instead of extracting blindly", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "spec.pdf"), MINIMAL_PDF);
    let extracted = false;
    const tools = toolsFor(root, {
      getPageCount: () => Promise.resolve(null),
      extractPages: () => {
        extracted = true;
        return Promise.resolve({ ok: false as const, code: "unavailable" as const, message: "must not run" });
      },
    });
    const outcome = await tools.execute(callFor(READ_PDF_TOOL, { path: "spec.pdf", pages: "5-" }), SIGNAL);

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "page_count_unknown");
    }

    // Refused before the runner was touched: no unbounded work was started.
    assert.equal(extracted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor cancel branches, called directly: pre-aborted and abort-during-read", async () => {
  // These bypass the dispatch pre-check on purpose: the dispatcher test below
  // proves the ToolPort answers cancelled, these prove the executor's own
  // branches (before-read check and read-catch mapping) do too. Removing
  // either branch fails its case.
  const root = tempRoot();
  try {
    writeFileSync(join(root, "spec.pdf"), MINIMAL_PDF);
    const config = { workspaceRoot: root, reader: createNodeFileSystemReader(), runner: stubRunner(3) };
    const preAborted = new AbortController();

    preAborted.abort();
    assert.equal(
      (await executeReadPdf(config, callFor(READ_PDF_TOOL, { path: "spec.pdf" }), preAborted.signal)).outcome,
      "cancelled",
    );
    // The abort lands while the read is in flight: the catch must report
    // cancelled, not read_failed. A reader that throws on a live signal still
    // reports read_failed, proving the branch discriminates on the signal.
    const midFlight = new AbortController();
    const abortingReader = {
      ...createNodeFileSystemReader(),
      readFileBytes: (_absolutePath: string, _signal: AbortSignal): Promise<Uint8Array> => {
        midFlight.abort();
        throw new Error("boom");
      },
    };

    assert.equal(
      (
        await executeReadPdf(
          { workspaceRoot: root, reader: abortingReader, runner: stubRunner(3) },
          callFor(READ_PDF_TOOL, { path: "spec.pdf" }),
          midFlight.signal,
        )
      ).outcome,
      "cancelled",
    );
    const liveThrower = {
      ...createNodeFileSystemReader(),
      readFileBytes: (_absolutePath: string, _signal: AbortSignal): Promise<Uint8Array> => {
        throw new Error("boom");
      },
    };
    const failed = await executeReadPdf(
      { workspaceRoot: root, reader: liveThrower, runner: stubRunner(3) },
      callFor(READ_PDF_TOOL, { path: "spec.pdf" }),
      SIGNAL,
    );

    assert.equal(failed.outcome, "error");

    if (failed.outcome === "error") {
      assert.equal(failed.code, "read_failed");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without a runner, ranges refuse as unavailable; cancellation wins", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "spec.pdf"), MINIMAL_PDF);
    const tools = toolsFor(root);
    const ranged = await tools.execute(callFor(READ_PDF_TOOL, { path: "spec.pdf", pages: "1-2" }), SIGNAL);

    assert.equal(ranged.outcome, "error");

    if (ranged.outcome === "error") {
      assert.equal(ranged.code, "unavailable");
    }

    const whole = await tools.execute(callFor(READ_PDF_TOOL, { path: "spec.pdf" }), SIGNAL);

    assert.equal(whole.outcome, "result");
    const aborted = new AbortController();

    aborted.abort();
    const cancelled = await tools.execute(callFor(READ_PDF_TOOL, { path: "spec.pdf" }), aborted.signal);

    assert.equal(cancelled.outcome, "cancelled");
    const missing = await tools.execute(callFor(READ_PDF_TOOL, { path: "gone.pdf" }), SIGNAL);

    assert.equal(missing.outcome, "error");

    if (missing.outcome === "error") {
      assert.equal(missing.code, "read_failed");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
