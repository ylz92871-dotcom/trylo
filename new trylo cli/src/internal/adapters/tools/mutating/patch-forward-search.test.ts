import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { createMutatingTools } from "./index.js";

const COMPOSITE = "    ctx.globalCompositeOperation = 'lighter';";
const NORMAL = "    ctx.globalCompositeOperation = 'source-over';";
const INITIAL = [
  "function drawFood() {", COMPOSITE, "    drawFoodGlow();", "}",
  "function drawTrail() {", COMPOSITE, "    drawTrailGlow();", "}",
  "function drawParticles() {", COMPOSITE, "    drawParticleGlow();", "}",
].join("\r\n") + "\r\n";

test("rangeless edit hunks advance past earlier identical canvas lines through the production tool", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-forward-patch-"));
  try {
    const path = join(root, "index.html");

    writeFileSync(path, "\uFEFF" + INITIAL);
    const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root }) });
    const patch = [
      "@@", " function drawFood() {", " " + COMPOSITE, "-    drawFoodGlow();", "+    drawCandy();", " }",
      "@@", "-" + COMPOSITE, "+" + NORMAL,
      "@@", "-" + COMPOSITE, "+" + NORMAL,
    ].join("\n");
    const result = await tools.execute({ toolCallId: "canvas", name: "edit_file", arguments: { path: "index.html", patch } }, new AbortController().signal);

    assert.equal(result.outcome, "result", JSON.stringify(result));
    const expected = INITIAL.replace("drawFoodGlow()", "drawCandy()")
      .replace("function drawTrail() {\r\n" + COMPOSITE, "function drawTrail() {\r\n" + NORMAL)
      .replace("function drawParticles() {\r\n" + COMPOSITE, "function drawParticles() {\r\n" + NORMAL);

    assert.equal(readFileSync(path, "utf8"), "\uFEFF" + expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a later missing hunk leaves every original byte intact and explains how to recover", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-forward-refuse-"));
  try {
    const path = join(root, "index.html");

    writeFileSync(path, INITIAL);
    const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root }) });
    const patch = "@@\n-    drawTrailGlow();\n+    drawCandy();\n@@\n-    drawFoodGlow();\n+    drawCandy();";
    const result = await tools.execute({ toolCallId: "backwards", name: "edit_file", arguments: { path: "index.html", patch } }, new AbortController().signal);

    assert.equal(result.outcome, "error");

    if (result.outcome === "error") {
      assert.equal(result.code, "patch_hunk_mismatch");
      assert.match(result.message, /file order/);
      assert.match(result.message, /No file was changed/);
    }

    assert.equal(readFileSync(path, "utf8"), INITIAL);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mixed edit formats are refused without writing and explain which fields to omit", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-mixed-edit-"));
  try {
    const path = join(root, "index.html");

    writeFileSync(path, INITIAL);
    const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root }) });

    for (const old_string of ["", COMPOSITE]) {
      const result = await tools.execute({
        toolCallId: "mixed", name: "edit_file",
        arguments: { path: "index.html", patch: "@@\n-" + COMPOSITE + "\n+" + NORMAL, old_string, new_string: "" },
      }, new AbortController().signal);

      assert.equal(result.outcome, "error");

      if (result.outcome === "error") {
        assert.equal(result.code, "invalid_arguments");
        assert.match(result.message, /omit old_string and new_string entirely/);
        assert.match(result.message, /No file was changed/);
      }

      assert.equal(readFileSync(path, "utf8"), INITIAL);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
