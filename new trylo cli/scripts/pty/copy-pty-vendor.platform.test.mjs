import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPtySessionRegistry } from "../../dist/internal/adapters/process-session/pty-session.js";

test("building into a Low directory preserves a working native terminal", {
  skip: process.platform !== "win32", timeout: 20000,
}, async context => {
  const stage = mkdtempSync(path.join(os.tmpdir(), "trylo-pty-build-"));
  const effect = mkdtempSync(path.join(os.tmpdir(), "trylo-pty-effect-"));
  const output = path.join(effect, "written.txt");
  let registry;
  let helperClosed;

  try {
    execFileSync("icacls.exe", [stage, "/setintegritylevel", "(OI)(CI)L"], { windowsHide: true });
    execFileSync("icacls.exe", [effect, "/setintegritylevel", "(OI)(CI)M"], { windowsHide: true });
    execFileSync(process.execPath, [fileURLToPath(new URL("./copy-pty-vendor.mjs", import.meta.url)),
      `--out-dir=${stage}`], { windowsHide: true, stdio: "pipe" });
    // Same bytes are not sufficient: a cached Low executable still needs
    // preparation before it can host a normal native terminal.
    const helper = path.join(stage, "internal/vendor/pty/win-x64/trylo-pty.exe");

    execFileSync("icacls.exe", [helper, "/setintegritylevel", "L"], { windowsHide: true });
    execFileSync(process.execPath, [fileURLToPath(new URL("./copy-pty-vendor.mjs", import.meta.url)),
      `--out-dir=${stage}`], { windowsHide: true, stdio: "pipe" });
    registry = createPtySessionRegistry({ helper: { ok: true, source: "override",
      helperPath: path.join(stage, "internal/vendor/pty/win-x64/trylo-pty.exe") },
      spawnHelper(helperPath) {
        const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        helperClosed = once(child, "close");
        return child;
      } });
    const session = await registry.start({ id: "", tty: true, rows: 24, cols: 80,
      argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'native terminal works')", output],
      cwd: effect, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
        TEMP: process.env.TEMP, COMSPEC: process.env.COMSPEC }, maxBufferBytes: 65536 }, context.signal);
    let transcript = "";

    while (!context.signal.aborted && registry.get(session.id)?.status === "running") {
      const read = await registry.write({ sessionId: session.id, input: "", eof: false, yieldMs: 250 });
      if (read.ok) transcript += read.read.output;
      if (registry.get(session.id)?.status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    assert.equal(registry.get(session.id)?.exitCode, 0, transcript);
    assert.equal(readFileSync(output, "utf8"), "native terminal works");
  } finally {
    registry?.shutdown();

    // shutdown initiates exit; Windows releases the mapped image at close.
    if (helperClosed) await helperClosed;

    assert.equal(path.dirname(stage), path.resolve(os.tmpdir()));
    assert.equal(path.dirname(effect), path.resolve(os.tmpdir()));
    rmSync(stage, { recursive: true, force: true });
    rmSync(effect, { recursive: true, force: true });
  }
});

test("a restricted builder reuses an identical prepared terminal without overwriting it", {
  skip: process.platform !== "win32", timeout: 30000,
}, () => {
  const stage = mkdtempSync(path.join(os.tmpdir(), "trylo-pty-reuse-"));
  try {
    const script = fileURLToPath(new URL("./copy-pty-vendor.mjs", import.meta.url));

    execFileSync("icacls.exe", [stage, "/setintegritylevel", "(OI)(CI)L"], { windowsHide: true });
    execFileSync(process.execPath, [script, `--out-dir=${stage}`], { windowsHide: true, stdio: "pipe" });
    const helper = path.join(stage, "internal/vendor/pty/win-x64/trylo-pty.exe");
    const original = readFileSync(helper);
    const labels = execFileSync("icacls.exe", [helper], { encoding: "utf8", windowsHide: true });
    const restrictedNode = path.join(stage, "low-builder.exe");

    writeFileSync(restrictedNode, readFileSync(process.execPath));
    execFileSync("icacls.exe", [restrictedNode, "/setintegritylevel", "L"], { windowsHide: true });
    const rebuilt = spawnSync(restrictedNode, [script, `--out-dir=${stage}`], { encoding: "utf8", windowsHide: true });

    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    assert.deepEqual(readFileSync(helper), original);
    assert.equal(execFileSync("icacls.exe", [helper], { encoding: "utf8", windowsHide: true }), labels);
    writeFileSync(helper, "tampered helper");
    const rejected = spawnSync(restrictedNode, [script, `--out-dir=${stage}`], { encoding: "utf8", windowsHide: true });

    assert.notEqual(rejected.status, 0, "different bytes cannot be reported as a reusable prepared helper");
    execFileSync(process.execPath, [script, `--out-dir=${stage}`], { windowsHide: true, stdio: "pipe" });
    assert.deepEqual(readFileSync(helper), original);
  } finally {
    assert.equal(path.dirname(stage), path.resolve(os.tmpdir()));
    rmSync(stage, { recursive: true, force: true });
  }
});
