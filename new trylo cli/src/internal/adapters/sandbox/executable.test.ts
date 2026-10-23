import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildCommandShellLine,
  commandShellPath,
  hostProcessEnvironment,
  lookupExecutable,
  quoteForCommandShell,
  shapeCommand,
} from "./executable.js";

test("an explicit batch extension resolves a PATH target before cmd receives it", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-explicit-batch-"));
  const previous = process.env["PATH"];
  try {
    const script = path.join(root, "trylo-explicit-probe.cmd");
    writeFileSync(script, "@echo off\r\n", "utf8");
    process.env["PATH"] = root + path.delimiter + (previous ?? "");
    const result = shapeCommand(["trylo-explicit-probe.cmd", "--version"]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.shape.argv.at(-1)?.includes(script), "a relative PATH batch gives %~dp0 the working directory");
  } finally {
    if (previous === undefined) delete process.env["PATH"]; else process.env["PATH"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * D5: the controlled cmd form.
 *
 * Quoting is the whole security boundary once cmd is involved, so the escaping
 * is asserted word by word rather than end to end: a wrong number of
 * backslashes in front of a quote is invisible in a passing command and fatal
 * in an adversarial one.
 */

const isWindows = process.platform === "win32";

test("every word is quoted, so cmd cannot reinterpret it", () => {
  assert.equal(quoteForCommandShell("--version"), '"--version"');
  assert.equal(quoteForCommandShell("hello world"), '"hello world"');
  assert.equal(quoteForCommandShell(""), '""');
});

test("an embedded quote is escaped rather than closing the word early", () => {
  assert.equal(quoteForCommandShell('say "hi"'), '"say \\"hi\\""');
});

test("backslashes are doubled only where they would escape the closing quote", () => {
  // A trailing backslash would otherwise swallow the quote that ends the word.
  assert.equal(quoteForCommandShell("C:\\dir\\"), '"C:\\dir\\\\"');
  // Elsewhere they are plain characters and must stay that way.
  assert.equal(quoteForCommandShell("C:\\dir\\file"), '"C:\\dir\\file"');
  assert.equal(quoteForCommandShell('a\\"b'), '"a\\\\\\"b"');
});

test("the line carries one extra outer pair, which is what /s strips", () => {
  const line = buildCommandShellLine(["cmd", "a b"]);
  assert.equal(line, '""cmd" "a b""');
});

test("a non-Windows platform never routes through cmd", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-exec-"));
  try {
    const script = path.join(root, "probe.cmd");
    writeFileSync(script, "@echo off\r\n", "utf8");
    const shape = shapeCommand([script, "--version"]);
    assert.equal(shape.ok, true);
    if (shape.ok) {
      assert.equal(shape.shape.kind, isWindows ? "shell" : "direct");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an executable that is not a batch script is started exactly as written", () => {
  const shape = shapeCommand(["node", "-v"]);
  assert.equal(shape.ok, true);
  if (shape.ok) {
    assert.equal(shape.shape.kind, "direct");
    assert.deepEqual(shape.shape.argv, ["node", "-v"]);
  }
});

test("an empty argv is refused instead of inventing a program", () => {
  const shape = shapeCommand([]);
  assert.equal(shape.ok, false);
  if (!shape.ok) {
    assert.equal(shape.code, "empty_command");
  }
});

test("a batch script found on PATH is the one that gets run", { skip: !isWindows }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-exec-"));
  const previousPath = process.env["PATH"];
  try {
    const script = path.join(root, "trylo-probe.cmd");
    writeFileSync(script, "@echo off\r\n", "utf8");
    process.env["PATH"] = `${root}${path.delimiter}${previousPath ?? ""}`;
    const lookup = lookupExecutable("trylo-probe");
    assert.equal(lookup.kind, "script");
    if (lookup.kind === "script") {
      // PATHEXT is upper case, so the discovered name inherits its casing.
      assert.equal(path.basename(lookup.target).toLowerCase(), "trylo-probe.cmd");
    }
  } finally {
    if (previousPath === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = previousPath;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("percent and line breaks are refused rather than handed to cmd", { skip: !isWindows }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-exec-"));
  const previousPath = process.env["PATH"];
  try {
    const script = path.join(root, "trylo-probe.cmd");
    writeFileSync(script, "@echo off\r\n", "utf8");
    process.env["PATH"] = `${root}${path.delimiter}${previousPath ?? ""}`;
    for (const payload of ["%OS%", "before%OS%after", "line1\nline2"]) {
      const shape = shapeCommand(["trylo-probe", payload]);
      assert.equal(shape.ok, false, payload);
      if (!shape.ok) {
        assert.equal(shape.code, "cmd_metacharacter_forbidden", payload);
      }
    }
    // The refusal is about expansion, not about quoting: a caret is inert once
    // the word is quoted, so `npm i pkg@^1.0.0` keeps working.
    const caret = shapeCommand(["trylo-probe", "pkg@^1.0.0"]);
    assert.equal(caret.ok, true);
  } finally {
    if (previousPath === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = previousPath;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing command shell is refused with an alternative, not a silent fallback", { skip: !isWindows }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-exec-"));
  const previousPath = process.env["PATH"];
  const previousComSpec = process.env["ComSpec"];
  const previousComSpecUpper = process.env["COMSPEC"];
  try {
    const script = path.join(root, "trylo-probe.cmd");
    writeFileSync(script, "@echo off\r\n", "utf8");
    process.env["PATH"] = `${root}${path.delimiter}${previousPath ?? ""}`;
    delete process.env["ComSpec"];
    delete process.env["COMSPEC"];
    assert.equal(commandShellPath(), undefined);
    const shape = shapeCommand(["trylo-probe", "--version"]);
    assert.equal(shape.ok, false);
    if (!shape.ok) {
      assert.equal(shape.code, "command_shell_unavailable");
      assert.match(shape.message, /cmd\.exe/);
    }
  } finally {
    if (previousPath === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = previousPath;
    }
    if (previousComSpec === undefined) {
      delete process.env["ComSpec"];
    } else {
      process.env["ComSpec"] = previousComSpec;
    }
    if (previousComSpecUpper === undefined) {
      delete process.env["COMSPEC"];
    } else {
      process.env["COMSPEC"] = previousComSpecUpper;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shell shape is a controlled cmd invocation, never shell: true", { skip: !isWindows }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-exec-"));
  const previousPath = process.env["PATH"];
  try {
    const script = path.join(root, "trylo-probe.cmd");
    writeFileSync(script, "@echo off\r\n", "utf8");
    process.env["PATH"] = `${root}${path.delimiter}${previousPath ?? ""}`;
    const shape = shapeCommand(["trylo-probe", "--version"]);
    assert.equal(shape.ok, true);
    if (shape.ok && shape.shape.kind === "shell") {
      const argv = shape.shape.argv;
      assert.equal(argv[1], "/d");
      assert.equal(argv[2], "/s");
      assert.equal(argv[3], "/c");
      assert.equal(argv.length, 5);
      const line = argv[4] ?? "";
      assert.ok(line.startsWith('""'), "the outer pair is what /s strips");
      assert.ok(line.endsWith('"'));
      assert.ok(!line.includes(" & "), "no unquoted operator may reach cmd");
    }
  } finally {
    if (previousPath === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = previousPath;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("the host environment reader hands back a copy, not the live object", () => {
  // The reason this function exists: sibling modules need the environment
  // without growing their own `process.env` read. The copy is what keeps that
  // safe — a caller that mutated the result would be editing its own child's
  // environment, and a caller that kept the object would see later mutations
  // appear under it.
  const first = hostProcessEnvironment();
  assert.equal(typeof first, "object");
  // Written through a widened local, because the contract under test is that the
  // caller *cannot* write through the returned handle — the test has to attempt
  // the write to prove it, and `Readonly<Record<...>>` forbids that at the type
  // level. So the attempt is made on a mutable view of the same object.
  const writable = first as Record<string, string | undefined>;
  writable["WP12_PROBE"] = "mutated";
  const second = hostProcessEnvironment();
  assert.equal(second["WP12_PROBE"], undefined, "the reader must not expose the live environment");
});

test("the host environment reader carries the variables a child needs", () => {
  // A sandboxed child with no PATH cannot resolve anything, which presents as a
  // broken install rather than as a missing variable.
  const environment = hostProcessEnvironment();
  assert.equal(typeof environment["PATH"] === "string" || environment["Path"] === "string", true);
});

test("Windows child PATH aliases preserve arbitrary environment-name casing", { skip: process.platform !== "win32" }, () => {
  const pathEntries = Object.entries(process.env).filter(([name]) => name.toLowerCase() === "path");
  try {
    for (const name of ["path", "pAtH", "Path", "PATH"]) {
      for (const key of Object.keys(process.env).filter(key => key.toLowerCase() === "path")) delete process.env[key];
      process.env[name] = "C:\\fixture bin;C:\\Windows";
      const environment = hostProcessEnvironment();
      assert.equal(environment["PATH"], "C:\\fixture bin;C:\\Windows", name);
      assert.equal(environment["Path"], environment["PATH"], name);
    }
  } finally {
    for (const key of Object.keys(process.env).filter(key => key.toLowerCase() === "path")) delete process.env[key];
    for (const [key, value] of pathEntries) process.env[key] = value;
  }
});
