import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject } from "../../../protocol/envelope.js";
import type { ToolCallRequest, ToolOutcome } from "../../../ports/tools.js";
import { createReadOnlyTools } from "./index.js";
import { createNodeFileSystemReader } from "./node-fs.js";
import type { FileSystemReader } from "./limits.js";
import { VIEW_IMAGE_TOOL } from "./view-image.js";

/**
 * `view_image` through the real tool (WP19.1: C25, L10).
 *
 * `image-guard.test.ts` proves the byte arithmetic. This file proves the tool
 * agrees with it: workspace containment first, bad detail before any read, a
 * renamed text file refused as an image, and the payload travelling in the
 * structured value while the model-facing text stays a redacted summary.
 */

const PNG = Uint8Array.from([
  // Structurally whole 1x1 PNG: signature + IHDR + empty IDAT + IEND.
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x00, 0x49, 0x44, 0x41,
  0x54, 0x35, 0xaf, 0x06, 0x1e, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60,
  0x82,
]);

function tempRoot(): string {
  // This suite pins ordinary workspace references; alias freezing is tested separately.
  return realpathSync.native(mkdtempSync(join(os.tmpdir(), "trylo-view-image-")));
}

function callFor(args: JsonObject): ToolCallRequest {
  return { toolCallId: "c1", name: VIEW_IMAGE_TOOL, arguments: args };
}

test("view_image is registered in the read-only catalog", () => {
  const root = tempRoot();
  try {
    const names = createReadOnlyTools({ workspaceRoot: root, reader: createNodeFileSystemReader() })
      .snapshot()
      .map((binding) => binding.name);
    assert.ok(names.includes(VIEW_IMAGE_TOOL));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a real PNG validates: facts in value, summary in output, never the payload as a path", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "image.png"), PNG);
    const tools = createReadOnlyTools({ workspaceRoot: root, reader: createNodeFileSystemReader() });
    const outcome = await tools.execute(callFor({ path: "image.png" }), new AbortController().signal);
    assert.equal(outcome.outcome, "result");
    if (outcome.outcome === "result") {
      const value = outcome.value as JsonObject;
      assert.equal(value.mediaType, "image/png");
      assert.equal(value.bytes, PNG.length);
      assert.equal(value.detail, "high");
      assert.equal(value.width, 1);
      assert.equal(value.height, 1);
      assert.equal(value.dataUrl, undefined, "structured values also enter durable envelopes");
      assert.equal(outcome.images?.[0]?.path, "image.png");
      assert.match(outcome.images?.[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
      assert.ok(!JSON.stringify(outcome).includes(Buffer.from(PNG).toString("base64")));
      assert.ok(outcome.output.includes("image/png"));
      assert.ok(outcome.output.includes("image.png"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("text renamed to .png refuses as an image, and bad detail refuses before any read", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "notes.png"), "arbitrary file contents", "utf8");
    const tools = createReadOnlyTools({ workspaceRoot: root, reader: createNodeFileSystemReader() });
    const signal = new AbortController().signal;
    const renamed = await tools.execute(callFor({ path: "notes.png" }), signal);
    assert.equal(renamed.outcome, "error");
    if (renamed.outcome === "error") {
      assert.equal(renamed.code, "invalid_image");
    }
    const detail = await tools.execute(callFor({ path: "notes.png", detail: "low" }), signal);
    assert.equal(detail.outcome, "error");
    if (detail.outcome === "error") {
      assert.equal(detail.code, "invalid_arguments");
    }
    const outside: ToolOutcome = await tools.execute(callFor({ path: "../escape.png" }), signal);
    assert.equal(outside.outcome, "error");
    if (outside.outcome === "error") {
      assert.equal(outside.code, "path_outside_workspace");
    }
    const missing: ToolOutcome = await tools.execute(callFor({}), signal);
    assert.equal(missing.outcome, "error");
    if (missing.outcome === "error") {
      assert.equal(missing.code, "invalid_arguments");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a text-only reader fails closed instead of decoding text as an image", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "image.png"), PNG);
    const textOnly: FileSystemReader = {
      async readFileUtf8(): Promise<string> {
        return "";
      },
      async readDir(): Promise<[]> {
        return [];
      },
      async statBytes(): Promise<number> {
        return 0;
      },
    };
    const tools = createReadOnlyTools({ workspaceRoot: root, reader: textOnly });
    const outcome: ToolOutcome = await tools.execute(callFor({ path: "image.png" }), new AbortController().signal);
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "bytes_unavailable");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
