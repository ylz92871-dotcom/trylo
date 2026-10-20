import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "./index.js";
import { createWorkspaceTools } from "../tools/index.js";
import { isInside } from "../tools/shared/workspace.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { readToolApprovalRequirement } from "../../loop/tool-boundary.js";
import { composeSandbox } from "../mcp-runtime/mount.js";
import { toolCatalogHash } from "../../surface/cli/wiring-catalog.js";
import { createNavigationView } from "../tools/read-only/navigation-view.js";
import { createNodeFileSystemReader } from "../tools/read-only/node-fs.js";

test("host filesystem scope reaches real read/write/edit/patch executors; default stays contained", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "trylo-host-files-"));
  try {
    const root = path.join(base, "workspace"); mkdirSync(root);
    const external = path.join(base, "external.txt"); writeFileSync(external, "before");
    const config = { workspaceRoot: root, ...{ fileAccess: "host" as const } };
    const sandbox = createWorkspaceSandbox(config);
    const tools = createWorkspaceTools({ ...config, sandbox });
    const scoped = createWorkspaceTools({ workspaceRoot: root, sandbox: createWorkspaceSandbox({ workspaceRoot: root }) });
    assert.equal(toolCatalogHash(tools), toolCatalogHash(scoped), "authority must not alter session catalog identity");
    const call = (name: string, args: JsonObject) => ({ toolCallId: name, name, arguments: args });
    const read = call("read_file", { path: external });
    assert.equal(readToolApprovalRequirement(tools, read.name, read, composeSandbox(sandbox, new Set())).required, true);
    const local = call("read_file", { path: "local.txt" });
    assert.equal(readToolApprovalRequirement(tools, local.name, local, sandbox).required, false);
    const write = call("write_file", { path: external, content: "after" });
    assert.equal(createWorkspaceSandbox({ workspaceRoot: root }).evaluate(write).ok, false);
    assert.equal(sandbox.evaluate(write).ok, true);
    for (const request of [write, call("edit_file", { path: external, old_string: "after", new_string: "edited" }),
      call("read_file", { path: external }),
      call("apply_patch", { patch: `*** Begin Patch\n*** Update File: ${external}\n@@\n-edited\n+patched\n*** End Patch` })]) {
      const outcome = await tools.execute(request, new AbortController().signal);
      assert.equal(outcome.outcome, "result", JSON.stringify(outcome));
    }
    assert.equal(readFileSync(external, "utf8").trim(), "patched");
    for (const name of ["list_files", "search_text", "glob_files"]) {
      const outcome = await tools.execute(call(name, { path: base, pattern: name === "glob_files" ? "*.txt" : "patched" }), new AbortController().signal);
      assert.equal(outcome.outcome, "result", JSON.stringify(outcome));
      if (outcome.outcome === "result") assert.match(outcome.output, /external\.txt/);
    }
    for (const target of ["\\\\.\\PhysicalDrive0", "NUL", "C:relative", "bad\0path"]) {
      assert.equal(sandbox.evaluate(call("write_file", { path: target, content: "no" })).ok, false);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a contained name beginning with two dots is not parent traversal", () => {
  assert.equal(isInside(path.resolve("project"), path.resolve("project", "..cache", "entry.txt")), true);
});

test("workspace aliases allow their own files without silently granting a nested escaping link", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "trylo-workspace-alias-"));
  try {
    const root = path.join(base, "workspace"); mkdirSync(root);
    const outside = path.join(base, "outside"); mkdirSync(outside);
    const alias = path.join(base, "alias"); symlinkSync(root, alias, "junction");
    symlinkSync(outside, path.join(root, "escape"), "junction");
    const local = { toolCallId: "write", name: "write_file", arguments: { path: path.join(alias, "inside.txt"), content: "local" } };
    const frozen = createWorkspaceSandbox({ workspaceRoot: alias });
    assert.equal(frozen.evaluate(local).ok, true);
    const tools = createWorkspaceTools({ workspaceRoot: alias, sandbox: frozen });
    assert.equal((await tools.execute(local, new AbortController().signal)).outcome, "result");
    assert.equal(readFileSync(path.join(root, "inside.txt"), "utf8"), "local");
    const escaped = { ...local, arguments: { path: path.join(alias, "escape", "external.txt"), content: "outside" } };
    assert.equal(createWorkspaceSandbox({ workspaceRoot: alias, fileAccess: "reviewed" }).evaluate(escaped).ok, false);
    assert.equal(createWorkspaceSandbox({ workspaceRoot: alias, fileAccess: "host" }).evaluate(escaped).ok, true);
    unlinkSync(alias); symlinkSync(outside, alias, "junction");
    assert.equal((await tools.execute({ ...local, arguments: { ...local.arguments, content: "still original workspace" } }, new AbortController().signal)).outcome, "result");
    assert.equal(readFileSync(path.join(root, "inside.txt"), "utf8"), "still original workspace");
    assert.equal(existsSync(path.join(outside, "inside.txt")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("reviewed external notebook read/edit and PDF metadata use the same approved target scope", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "trylo-reviewed-documents-"));
  try {
    const root = path.join(base, "workspace"); mkdirSync(root);
    const notebook = path.join(base, "experiment.ipynb");
    writeFileSync(notebook, JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
      { id: "cell", cell_type: "code", source: ["before"], metadata: {}, outputs: [], execution_count: null },
    ] }));
    const pdf = path.join(base, "document.pdf"); writeFileSync(pdf, "%PDF-1.4\n%%EOF\n");
    const tools = createWorkspaceTools({ workspaceRoot: root, sandbox: createWorkspaceSandbox({ workspaceRoot: root, fileAccess: "reviewed" }) });
    const edit = await tools.execute({ toolCallId: "edit", name: "notebook_edit", arguments: { path: notebook, cell_id: "cell", new_source: "after" } }, new AbortController().signal);
    assert.equal(edit.outcome, "result", JSON.stringify(edit));
    assert.match(readFileSync(notebook, "utf8"), /after/);
    const read = await tools.execute({ toolCallId: "read", name: "read_notebook", arguments: { path: notebook } }, new AbortController().signal);
    assert.equal(read.outcome, "result", JSON.stringify(read)); if (read.outcome === "result") assert.match(read.output, /after/);
    const metadata = await tools.execute({ toolCallId: "pdf", name: "read_pdf", arguments: { path: pdf } }, new AbortController().signal);
    assert.equal(metadata.outcome, "result", JSON.stringify(metadata));
    // Permission reachability and metadata validation only, not a Poppler render claim.
    if (metadata.outcome === "result") assert.equal(metadata.value["bytes"], 15);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("navigation metadata does not read escaping rules or parents outside an approved directory", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "trylo-navigation-authority-"));
  try {
    const root = path.join(base, "workspace"); mkdirSync(root);
    const outside = path.join(base, "outside"); mkdirSync(outside);
    writeFileSync(path.join(outside, ".gitignore"), "# external rule data");
    writeFileSync(path.join(base, ".gitignore"), "# private parent rule data");
    writeFileSync(path.join(root, ".gitignore"), "ignored.txt");
    symlinkSync(outside, path.join(root, "escape"), "junction");
    const node = createNodeFileSystemReader(); const observed: string[] = [];
    const reader = { ...node, async readOptionalUtf8(file: string) {
      const text = await node.readOptionalUtf8?.(file); if (text !== undefined) observed.push(text); return text;
    } };
    const local = createNavigationView({ workspaceRoot: root, reader, filters: { include: [], exclude: [] } });
    await local.visible(path.join(root, "escape", "file.txt"), false);
    assert.equal(observed.some(text => text.includes("external rule data")), false);
    assert.equal(await local.visible(path.join(root, "ignored.txt"), false), false);
    const approved = createNavigationView({ workspaceRoot: base, rulesRoot: outside, reader, filters: { include: [], exclude: [] } });
    await approved.visible(path.join(outside, "file.txt"), false);
    assert.ok(observed.some(text => text.includes("external rule data")));
    assert.equal(observed.some(text => text.includes("private parent rule data")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
