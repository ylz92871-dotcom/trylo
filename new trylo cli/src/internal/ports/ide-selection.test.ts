import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readSelection, selectionNote, MAX_SELECTION_BYTES } from "./ide-selection.js";

const WORKSPACE = "D:/proj";

/** The editor reports absolute paths with either separator; we want one spelling. */
function toWorkspaceRelative(absolute: string): string | undefined {
  const normalized = absolute.replaceAll("\\", "/");
  const prefix = `${WORKSPACE}/`;
  if (!normalized.startsWith(prefix)) return undefined;
  return normalized.slice(prefix.length);
}

describe("readSelection", () => {
  it("normalises a selection into Trylo coordinates", () => {
    const outcome = readSelection(
      {
        selection: { start: { line: 10, character: 0 }, end: { line: 10, character: 20 } },
        text: "const x = 1;",
        filePath: `${WORKSPACE}/src/a.ts`,
      },
      toWorkspaceRelative,
    );

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.deepEqual(
      { path: outcome.selection.filePath, start: outcome.selection.startLine, lines: outcome.selection.lineCount },
      { path: "src/a.ts", start: 10, lines: 1 },
    );
  });

  it("counts a multi-line selection", () => {
    const outcome = readSelection(
      {
        selection: { start: { line: 4, character: 2 }, end: { line: 9, character: 0 } },
        text: "one\ntwo\nthree\nfour\nfive\n",
        filePath: `${WORKSPACE}/src/b.ts`,
      },
      toWorkspaceRelative,
    );
    assert.equal(outcome.ok && outcome.selection.lineCount, 5);
  });

  it("does not count the line an ending character 0 only touches", () => {
    // Ending at character 0 of line 9 means "up to the start of line 9", so
    // counting it would overstate the selection by a whole line.
    const outcome = readSelection(
      {
        selection: { start: { line: 4, character: 0 }, end: { line: 9, character: 0 } },
        text: "a\nb\nc\nd\ne\n",
        filePath: `${WORKSPACE}/src/c.ts`,
      },
      toWorkspaceRelative,
    );
    assert.equal(outcome.ok && outcome.selection.lineCount, 5);
  });

  it("treats a cursor as empty, not as an error", () => {
    // An editor nobody dragged in is the normal state, not a failure.
    const outcome = readSelection({ selection: null, text: "", filePath: `${WORKSPACE}/src/d.ts` }, toWorkspaceRelative);
    assert.deepEqual(outcome, { ok: false, reason: "empty" });
  });

  it("refuses text with no file rather than attaching an unattributable quote", () => {
    const outcome = readSelection({ selection: null, text: "mystery" }, toWorkspaceRelative);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, "incomplete");
  });

  it("refuses a file outside the workspace", () => {
    // Reading someone else's file because the editor had it open would put
    // content in a turn that no workspace rule ever approved.
    const outcome = readSelection({ selection: null, text: "secret", filePath: "C:/other/secret.txt" }, toWorkspaceRelative);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, "incomplete");
  });

  it("truncates an oversized selection and says so", () => {
    const outcome = readSelection(
      { selection: null, text: "x".repeat(200), filePath: `${WORKSPACE}/src/e.ts` },
      toWorkspaceRelative,
      50,
    );

    assert.equal(outcome.ok && outcome.selection.truncated, true);
    assert.equal(outcome.ok && outcome.selection.text.length, 50);
  });

  it("falls back to one line when the editor sends no range", () => {
    const outcome = readSelection(
      { selection: null, text: "whole file", filePath: `${WORKSPACE}/src/f.ts` },
      toWorkspaceRelative,
    );
    assert.equal(outcome.ok && outcome.selection.startLine, 0);
    assert.equal(outcome.ok && outcome.selection.lineCount, 1);
  });

  it("names a location a person can act on", () => {
    const outcome = readSelection(
      { selection: null, text: "x", filePath: `${WORKSPACE}/src/g.ts` },
      toWorkspaceRelative,
    );
    assert.equal(outcome.ok && selectionNote(outcome.selection), "src/g.ts:1 (1 line)");
  });

  it("keeps the selection byte ceiling named, not inline", () => {
    assert.equal(typeof MAX_SELECTION_BYTES, "number");
  });
});
