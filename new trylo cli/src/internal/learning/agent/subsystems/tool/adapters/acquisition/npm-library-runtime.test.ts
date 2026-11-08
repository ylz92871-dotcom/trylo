import { testScratchPath } from "../../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { IsolationPort } from "../../../../../../ports/isolation.js";
import type { JsonValue } from "../../../../../../protocol/envelope.js";
import { runNpmSnapshot } from "./npm-snapshot.js";
import { NPM_LIBRARY_ENTRYPOINT } from "../../domain/evolution/npm-adaptation.js";
import { executeNpmTool } from "./npm-runtime.js";
import { npmTreeTestData } from "./npm-install-test-support.js";
import { createNpmToolProductionPlan, decodeNpmToolInterface } from "../../domain/evolution/npm-production-plan.js";
import type { ToolEvolutionRequest } from "../../domain/evolution/contracts.js";

const execute = promisify(execFile);
/** TEST ONLY: real Node child/permissions and filesystem cleanup; no OS isolation or network acceptance. */
const localNodeContract: IsolationPort = {
  probe: async () => ({ state: "ready", backend: "windows-srt", evidence: "TEST ONLY local Node contract, not production isolation acceptance" }),
  run: async request => {
    const [file, ...args] = request.argv;
    assert.ok(file);
    const result = await execute(file, args, { cwd: request.cwd, env: {}, windowsHide: true, timeout: request.timeoutMs,
      signal: request.signal, maxBuffer: 131_072 });
    return { outcome: "completed", stdout: result.stdout, stderr: result.stderr, exitCode: 0, timedOut: false, backend: "windows-srt" };
  },
};

test("the library ABI calls a reviewed dependency in its restricted child and removes every snapshot", async t => {
  const base = testScratchPath("npm-library-runtime-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  const invoke = (source: string, input: JsonValue) => runNpmSnapshot({ files: [
    { path: "node_modules/leaf/package.json", body: Buffer.from('{"name":"leaf","version":"1.0.0","main":"index.cjs"}') },
    { path: "node_modules/leaf/index.cjs", body: Buffer.from("module.exports=value=>String(value).trim().toLowerCase();") },
    { path: `node_modules/${NPM_LIBRARY_ENTRYPOINT}`, body: Buffer.from(source) },
  ], entrypoint: `node_modules/${NPM_LIBRARY_ENTRYPOINT}`, runtime: { profile: "confined_npm_library_v1", source }, schema: {}, timeoutMs: 5000 },
  input, { scratchRoot: root, nodeExecutable: process.execPath, isolation: localNodeContract }, new AbortController().signal);

  assert.deepEqual(await invoke("module.exports=input=>require('leaf')(input.value);", { value: "  HELLO " }), { kind: "value", value: "hello" });
  assert.deepEqual(await invoke("module.exports=input=>require('leaf')(input);", "  HELLO "), { kind: "value", value: "hello" });
  assert.deepEqual(await invoke("module.exports=input=>input.map(value=>require('leaf')(value));", [" HELLO ", " WORLD "]), { kind: "value", value: ["hello", "world"] });
  assert.deepEqual(await invoke("module.exports=()=>{throw Object.assign(new Error('TEST ONLY'),{code:'invalid_input'});};", {}), { kind: "tool_error", code: "invalid_input" });
  assert.deepEqual(await invoke("module.exports=()=>require('node:fs').readFileSync('../input.json','utf8');", {}), { kind: "tool_error", code: "ERR_ACCESS_DENIED" });
  assert.deepEqual(await invoke("module.exports=()=>require('node:child_process').spawnSync('node',['-e','0']);", {}), { kind: "tool_error", code: "ERR_ACCESS_DENIED" });
  assert.deepEqual(await readdir(root), []);
});

test("the public library boundary accepts bounded JSON scalars and arrays before checking installed bytes", async t => {
  const base = testScratchPath("npm-library-runtime-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = npmTreeTestData(), selected = decodeNpmToolInterface({ descriptor: { identity: "test-json-input", description: "TEST ONLY arbitrary JSON ABI",
    inputSchema: {}, mastery: { whenToUse: ["TEST ONLY arbitrary JSON input"], preconditions: [], pitfalls: [] } }, runtime: { profile: "confined_npm_library_v1", source: "module.exports=input=>input;" } });

  assert.ok(selected);
  const checks: ToolEvolutionRequest = { schemaVersion: 1, requestId: "test-json-input", scope: data.plan.tree.scope, capability: "test arbitrary JSON library inputs",
    operation: "create", evidence: [
      { sampleId: "s1", role: "source", input: 1, expected: { kind: "value", value: 1 } },
      { sampleId: "s2", role: "source", input: "value", expected: { kind: "value", value: "value" } },
      { sampleId: "v", role: "variation", input: [1], expected: { kind: "value", value: [1] } },
      { sampleId: "c", role: "counterexample", input: null, expected: { kind: "error", code: "invalid_input" } },
    ] };
  const plan = createNpmToolProductionPlan({ workspaceId: "test", installation: data.plan, checks, ...selected });
  assert.ok(plan);
  const options = { installationRoot: root, scratchRoot: root, nodeExecutable: process.execPath, isolation: localNodeContract, target: data.target };

  for (const input of [1, "value", [1], null] as const) {
    assert.deepEqual(await executeNpmTool(plan, input as JsonValue, options, new AbortController().signal), { kind: "unavailable", detail: "reviewed installation is missing" });
  }

  assert.equal((await executeNpmTool(plan, "x".repeat(16_385), options, new AbortController().signal)).kind, "protocol_error");
});

test("an adapter must return JSON and cannot turn logs or a missing export into a successful result", async t => {
  const base = testScratchPath("npm-library-runtime-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const [source, expected] of [
    ["module.exports={};", "npm_adapter_export_required"], ["module.exports=()=>undefined;", "npm_adapter_invalid_result"],
    ["module.exports=()=>NaN;", "npm_adapter_invalid_result"],
    ["module.exports=()=>{console.log('TEST_ONLY_PRIVATE_NOISE');return 1;};", "npm_adapter_result_protocol_invalid"],
    ["module.exports=()=>{process.stdout.write('x'.repeat(70000));return 1;};", "npm_adapter_output_exceeded"],
    ["module.exports=()=>{process.stderr.write('x'.repeat(40000));return 1;};", "npm_adapter_output_exceeded"],
  ] as const) {
    const result = await runNpmSnapshot({ files: [{ path: `node_modules/${NPM_LIBRARY_ENTRYPOINT}`, body: Buffer.from(source) }],
      entrypoint: `node_modules/${NPM_LIBRARY_ENTRYPOINT}`, runtime: { profile: "confined_npm_library_v1", source }, schema: {}, timeoutMs: 5000 }, {},
    { scratchRoot: root, nodeExecutable: process.execPath, isolation: localNodeContract }, new AbortController().signal);
    assert.deepEqual(result, { kind: "tool_error", code: expected });
  }

  assert.deepEqual(await readdir(root), []);
});
