import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import test from "node:test";
import { createWindowsShellBoundary } from "./windows-shell-boundary.js";
import { shapeCommand } from "./executable.js";
import { createNodeSpawner } from "../tools/mutating/shell-spawn.js";

test("a batch command inside the real SRT boundary preserves literal arguments and effects", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-srt-batch-"));
  const batch = join(root, "echo words.cmd");
  mkdirSync(join(root, ".git")); writeFileSync(join(root, ".git/config"), "");
  // Match the private runner's Node flags: a restricted child must not realpath
  // private host-profile ancestors when the fixture lives under the user Temp.
  writeFileSync(batch, '@echo off\r\n"' + process.execPath + '" --preserve-symlinks --preserve-symlinks-main "%~dp0arguments.mjs" %*\r\n');
  writeFileSync(join(root, "arguments.mjs"), "import {writeFileSync} from 'node:fs';const text=JSON.stringify(process.argv.slice(2));writeFileSync('arguments.json',text);process.stdout.write(text);");
  const words = ["a b", "caret^", "literal&", "中文"];
  const previousPath = process.env["PATH"];
  process.env["PATH"] = root + delimiter + (previousPath ?? "");
  const boundary = createWindowsShellBoundary(root, process.env);
  try {
    for (const program of [batch, basename(batch)]) {
      const planned = shapeCommand([program, ...words]);
      assert.equal(planned.ok, true);
      if (!planned.ok) return;
      const result = await boundary.spawner(createNodeSpawner(boundary.helperEnvironment))({
        argv: planned.shape.argv, shape: planned.shape, cwd: root, timeoutMs: 60000,
        signal: new AbortController().signal, maxOutputBytes: 4096, maxOutputLines: 30,
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), words);
      assert.deepEqual(JSON.parse(readFileSync(join(root, "arguments.json"), "utf8")), words);
    }
  } finally {
    if (previousPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = previousPath;
    await boundary.close(); rmSync(root, { recursive: true, force: true });
  }
});
