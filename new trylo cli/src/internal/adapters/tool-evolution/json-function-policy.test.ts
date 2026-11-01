import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { checkJsonFunctionSource } from "./json-function-policy.js";
import { createToolCandidateExecutor } from "./process-executor.js";
import type { ToolEvolutionCandidate } from "../../learning/domains/tool/evolution/contracts.js";
import type { IsolationPort } from "../../ports/isolation.js";

const candidate: ToolEvolutionCandidate = { identity: "double", description: "double JSON input", inputSchema: { type: "number" },
  source: "module.exports = input => input * 2;", mastery: { whenToUse: ["double"], preconditions: [], pitfalls: [] } };

test("pure CommonJS JSON functions compile under strict semantics without executing in the host", () => {
  const result = checkJsonFunctionSource(candidate.source); assert.ok(result.ok); assert.match(result.program, /^"use strict";/);
  assert.ok(checkJsonFunctionSource("module.exports = async input => { throw Object.assign(new Error('bad input'), {code:'invalid_input'}); };").ok);
});
test("host access, global escapes and alternate module loading are refused before execution", () => {
  for (const expression of ["process.pid", "require('node:fs')", "globalThis", "this", "module['require']('node:fs')", "import('node:fs')", "eval('1')", "WebAssembly", "\\u0070rocess.pid"]) {
    const result = checkJsonFunctionSource(`module.exports = () => ${expression};`); assert.ok(!result.ok); assert.equal(result.code, "script_host_api_forbidden");
  }
});
test("noncanonical, oversized and syntactically broken programs never pass profile admission", () => {
  assert.ok(!checkJsonFunctionSource("throw new Error('top-level effect');").ok);
  assert.ok(!checkJsonFunctionSource("module.exports = function( {").ok);
  assert.ok(!checkJsonFunctionSource(`module.exports = () => '${"x".repeat(33_000)}';`).ok);
});
test("profile rejection performs no isolation or filesystem setup; legacy labs keep their original admission", async () => {
  let probes = 0;
  const isolation: IsolationPort = { probe: async () => { probes++; return { state: "unavailable", backend: "windows-srt", reason: "TEST ONLY unavailable" }; },
    run: async () => { throw new Error("must not run"); } };
  const executor = createToolCandidateExecutor({ isolation, scratchRoot: path.resolve("Temp/profile-rejected"), nodeExecutable: process.execPath, profile: "confined_json_function_v1" });
  const rejected = await executor.execute({ ...candidate, source: "module.exports=()=>process.pid;" }, 1, new AbortController().signal);
  assert.equal(rejected.kind, "protocol_error"); assert.equal(probes, 0);
  const lab = createToolCandidateExecutor({ isolation, scratchRoot: path.resolve("Temp/profile-rejected"), nodeExecutable: process.execPath });
  assert.equal((await lab.execute({ ...candidate, source: "module.exports=()=>process.pid;" }, 1, new AbortController().signal)).kind, "unavailable"); assert.equal(probes, 1);
});
test("confined execution uses the admitted strict program and disables dynamic string code generation", async t => {
  const base = path.resolve("Temp/tool-production-profile-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); assert.equal(path.dirname(root), base); t.after(() => rm(root, { recursive: true, force: true }));
  const nonce = "a".repeat(48);
  const isolation: IsolationPort = { probe: async () => ({ state: "ready", backend: "windows-srt", evidence: "TEST ONLY request contract" }), run: async request => {
    assert.ok(request.argv.includes("--disallow-code-generation-from-strings")); assert.deepEqual(request.env, {}); assert.deepEqual(request.network.allowedDomains, []);
    assert.match(await readFile(path.join(request.cwd, "candidate.cjs"), "utf8"), /^"use strict";/);
    return { outcome: "completed", backend: "windows-srt", stdout: `TRYLO_TOOL_READY:${nonce}\nTRYLO_TOOL_RESULT:${nonce}:{"kind":"value","value":4}\n`, stderr: "", exitCode: 0, timedOut: false };
  } };
  const result = await createToolCandidateExecutor({ isolation, scratchRoot: root, nodeExecutable: process.execPath, profile: "confined_json_function_v1" }).execute(candidate, 2, new AbortController().signal);
  assert.deepEqual(result, { kind: "value", value: 4 });
});
