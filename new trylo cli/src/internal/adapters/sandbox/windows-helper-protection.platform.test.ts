import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("helper protection and reuse work from a Medium caller without runtime compilation", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-medium-helper-"));
  const runtime = join(root, "runtime"), cache = join(root, "cache"), target = join(cache, "probe.exe");
  mkdirSync(runtime); mkdirSync(cache);
  const node = join(runtime, "node.exe");
  copyFileSync(process.execPath, node);
  writeFileSync(target, "harmless nonexecutable security descriptor fixture");
  const module = new URL("./windows-helper-protection.js", import.meta.url).href;
  const program = [
    "import {execFileSync} from 'node:child_process';",
    "const sid=execFileSync(process.env.SystemRoot+'/System32/whoami.exe',['/groups'],{encoding:'utf8',windowsHide:true}).match(/S-1-16-\\d+/)?.[0];",
    "if(sid!=='S-1-16-8192')throw new Error('expected Medium caller, got '+sid);",
    "const {protectWindowsCacheTarget}=await import(process.argv[1]);",
    "protectWindowsCacheTarget({kind:'directory',path:process.argv[2],state:'new'},process.env);",
    "protectWindowsCacheTarget({kind:'executable',path:process.argv[3],state:'new'},process.env);",
    "protectWindowsCacheTarget({kind:'executable',path:process.argv[3],state:'existing'},process.env);",
    "console.log(JSON.stringify({sid,protected:true,reused:true}));",
  ].join("\n");
  try {
    execFileSync("icacls.exe", [node, "/setintegritylevel", "M"], { windowsHide: true, stdio: "pipe" });
    const result = spawnSync(node, ["--input-type=module", "-e", program, module, cache, target], {
      env: process.env, windowsHide: true, encoding: "utf8", timeout: 60000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { sid: "S-1-16-8192", protected: true, reused: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
