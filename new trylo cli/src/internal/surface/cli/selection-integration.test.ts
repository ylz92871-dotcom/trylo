import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readSelection, renderSelection, selectionNote } from "../../ports/ide-selection.js";
import { prepareInput } from "./mention.js";

/**
 * The join, not the parts.
 *
 * `ide-selection.test.ts` (in ports) proves what a selection *is*; this file
 * proves the selected text actually reaches the turn — the acceptance criterion
 * for WP12.3. It lives on the surface side because that is the layer that owns
 * "what text a turn carries", and a test in `ports/` reaching across into
 * `surface/` to assert it would be the exact dependency the architecture gate
 * exists to prevent.
 */

const WORKSPACE = "D:/proj";

function toWorkspaceRelative(absolute: string): string | undefined {
  const normalized = absolute.replaceAll("\\", "/");
  const prefix = `${WORKSPACE}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : undefined;
}

const io = { cwd: WORKSPACE, readFile: () => undefined, isDirectory: () => false };

describe("a selection reaches the turn", () => {
  it("attaches the selected text to what the model is sent", () => {
    const selection = readSelection(
      { selection: null, text: "const answer = 42;", filePath: `${WORKSPACE}/src/answer.ts` },
      toWorkspaceRelative,
    );

    assert.equal(selection.ok, true);

    if (!selection.ok) return;

    const prepared = prepareInput("explain this", io, selection.selection);

    assert.equal(prepared.ok, true);

    if (!prepared.ok) return;

    // The acceptance criterion: the selected text really is in the turn.
    assert.match(prepared.text, /const answer = 42;/);
    assert.match(prepared.text, /src\/answer\.ts/);
    assert.match(prepared.note ?? "", /src\/answer\.ts:1/);
  });

  it("does not invent a selection when there is none", () => {
    const prepared = prepareInput("hello", io);
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal(prepared.text, "hello");
    assert.equal(prepared.note, undefined);
  });

  it("names both sources when a mention and a selection are present", () => {
    const selection = readSelection(
      { selection: null, text: "from editor", filePath: `${WORKSPACE}/src/h.ts` },
      toWorkspaceRelative,
    );

    assert.equal(selection.ok, true);

    if (!selection.ok) return;

    const prepared = prepareInput("compare @src/i.ts", { ...io, readFile: () => "from disk" }, selection.selection);

    assert.equal(prepared.ok, true);

    if (!prepared.ok) return;

    assert.match(prepared.text, /from disk/);
    assert.match(prepared.text, /from editor/);
    assert.match(prepared.note ?? "", /;/);
  });

  it("renders a selection in the same shape as a mention", () => {
    const selection = readSelection(
      { selection: null, text: "body", filePath: `${WORKSPACE}/src/j.ts` },
      toWorkspaceRelative,
    );

    assert.equal(selection.ok, true);

    if (!selection.ok) return;

    // One shape of "here is a file" means one thing for the model to parse.
    assert.equal(renderSelection(selection.selection), '<file path="src/j.ts" selection="0-0">\nbody\n</file>');
  });

  it("keeps a named file ahead of the cursor position", () => {
    const selection = readSelection(
      { selection: null, text: "editor context", filePath: `${WORKSPACE}/src/k.ts` },
      toWorkspaceRelative,
    );

    assert.equal(selection.ok, true);

    if (!selection.ok) return;

    const prepared = prepareInput("look at @src/other.ts", { ...io, readFile: () => "named file" }, selection.selection);

    assert.equal(prepared.ok, true);

    if (!prepared.ok) return;

    // A person who typed the path meant that file; the cursor is context.
    assert.ok(prepared.text.indexOf("named file") < prepared.text.indexOf("editor context"));
  });

  it("states where the selection came from without inventing a line range", () => {
    const selection = readSelection(
      { selection: null, text: "x", filePath: `${WORKSPACE}/src/l.ts` },
      toWorkspaceRelative,
    );

    assert.equal(selection.ok, true);

    if (!selection.ok) return;

    assert.equal(selectionNote(selection.selection), "src/l.ts:1 (1 line)");
  });
});
