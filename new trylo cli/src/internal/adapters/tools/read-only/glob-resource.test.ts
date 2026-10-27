import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { compileGlob } from "./glob-match.js";

test("repeated glob wildcards cannot block a filename mismatch", async (t) => {
  const moduleUrl = new URL("./glob-match.js", import.meta.url).href;
  const script = `import {compileGlob} from ${JSON.stringify(moduleUrl)};
    process.once('message', () => {
      const result=compileGlob('*a'.repeat(24)+'b');
      process.exit(!result.ok || result.matcher.matches('a'.repeat(80)) ? 1 : 0);
    });
    process.send('ready');`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
  });
  t.after(() => { child.kill(); });
  const stderrStream = child.stderr;
  assert.ok(stderrStream);
  const outcome = await new Promise<{ code: number | null; failure: string | undefined; stderr: string }>((resolve) => {
    let failure: string | undefined;
    let stderr = "";
    let phase: "startup" | "matching" = "startup";
    const expire = () => { failure = phase + " timeout"; child.kill(); };
    // Windows process startup/shutdown can itself consume two seconds. The
    // original algorithm budget begins only when the imported child is ready;
    // it still covers compilation, matching and the observed process exit.
    let timer = setTimeout(expire, 10_000);
    stderrStream.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(0, 2000); });
    child.once("error", (error) => { failure = error.message; });
    child.on("message", (message) => {
      if (message !== "ready" || phase !== "startup") return;
      clearTimeout(timer);
      phase = "matching";
      timer = setTimeout(expire, 2_000);
      child.send("match");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, failure: failure ?? (phase === "startup" ? "child never became ready" : undefined), stderr });
    });
  });
  assert.equal(outcome.failure, undefined, "glob compilation/matching must finish inside the bounded child process");
  assert.equal(outcome.code, 0, outcome.stderr);
});

test("glob compilation refuses excessive input length and brace depth with a typed error", () => {
  for (const pattern of ["a".repeat(4097), "{a,".repeat(34) + "b" + "}".repeat(34)]) {
    const result = compileGlob(pattern);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "invalid_pattern");
  }
});
