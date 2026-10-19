import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { shellModeShape } from "../../sandbox/shell-mode.js";
import { createNodeSpawner } from "./shell-spawn.js";

const windowsPowerShell = join(process.env["SystemRoot"] ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
const supported = process.platform === "win32" && existsSync(windowsPowerShell);

async function run(command: string) {
  const shape = shellModeShape({ kind: "shell", shell: { kind: "powershell", path: windowsPowerShell } }, command);
  return createNodeSpawner()({ argv: shape.argv, shape, cwd: process.cwd(), timeoutMs: 15000,
    signal: new AbortController().signal, maxOutputBytes: 10000, maxOutputLines: 100 });
}

test("production spawner preserves PowerShell here-string lines and quoted arguments", { skip: !supported }, async () => {
  const result = await run("$value = @'\nfirst line with \"quotes\"\nsecond line\n'@\nWrite-Output $value");
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.replaceAll("\r\n", "\n").trim(), "first line with \"quotes\"\nsecond line");
});

test("Windows PowerShell here-string reaches native stdin as UTF-8 and returns Unicode", { skip: !supported }, async () => {
  const node = process.execPath.replaceAll("'", "''");
  const result = await run(`@'\n中文内容 🐦\n第二行\n'@ | & '${node}' -e 'process.stdin.pipe(process.stdout)'`);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.replaceAll("\r\n", "\n").trim(), "中文内容 🐦\n第二行");
});
