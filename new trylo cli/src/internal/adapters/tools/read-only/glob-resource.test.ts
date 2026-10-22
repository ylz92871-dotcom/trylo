import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { compileGlob } from "./glob-match.js";

test("repeated glob wildcards cannot block a filename mismatch", () => {
  const moduleUrl = new URL("./glob-match.js", import.meta.url).href;
  const script = `import {compileGlob} from ${JSON.stringify(moduleUrl)};
    const result=compileGlob('*a'.repeat(24)+'b');
    if(!result.ok || result.matcher.matches('a'.repeat(80))) throw new Error('wrong_glob_result');`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 2_000, encoding: "utf8", windowsHide: true });
  assert.equal(child.error, undefined, "glob matching must finish inside the bounded child process");
  assert.equal(child.status, 0, child.stderr);
});

test("glob compilation refuses excessive input length and brace depth with a typed error", () => {
  for (const pattern of ["a".repeat(4097), "{a,".repeat(34) + "b" + "}".repeat(34)]) {
    const result = compileGlob(pattern);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "invalid_pattern");
  }
});
