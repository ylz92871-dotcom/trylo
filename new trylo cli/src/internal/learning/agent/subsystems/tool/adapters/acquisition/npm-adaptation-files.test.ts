import { testScratchPath } from "../../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { adaptNpmFiles, NpmAdaptationError } from "./npm-adaptation-files.js";
import { sha256Bytes } from "./npm-package-check.js";
import { npmTreeTestData } from "./npm-install-test-support.js";
import { createNpmToolProductionPlan, decodeNpmToolInterface, NPM_CLI_INPUT_SCHEMA } from "../../domain/evolution/npm-production-plan.js";
import type { ToolEvolutionRequest } from "../../domain/evolution/contracts.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { runNpmSnapshot } from "./npm-snapshot.js";
import { localNodeContract } from "../../testing/local-node-contract.js";

function fixture(source: string, oldSha256: string) {
  const data = npmTreeTestData();
  const selected = decodeNpmToolInterface({ descriptor: { identity: "test-overlay", description: "TEST ONLY source overlay",
    inputSchema: NPM_CLI_INPUT_SCHEMA, mastery: { whenToUse: ["TEST ONLY source overlay"], preconditions: [], pitfalls: [] } },
  runtime: { profile: "confined_npm_cli_v1", bin: "test-cli", entrypoint: "cli.cjs" },
  patches: [{ path: "node_modules/test-cli/cli.cjs", oldSha256, source }] });
  assert.ok(selected);
  const checks: ToolEvolutionRequest = { schemaVersion: 1, requestId: "test-patch-checks", scope: data.plan.tree.scope, capability: "test overlay", operation: "create", evidence: [
    { sampleId: "a", role: "source", input: { value: 1 }, expected: { kind: "value", value: 1 } },
    { sampleId: "b", role: "source", input: { value: 2 }, expected: { kind: "value", value: 2 } },
    { sampleId: "v", role: "variation", input: { value: 3 }, expected: { kind: "value", value: 3 } },
    { sampleId: "c", role: "counterexample", input: { value: null }, expected: { kind: "error", code: "bad" } },
  ] };
  const plan = createNpmToolProductionPlan({ workspaceId: "test", installation: data.plan, checks, ...selected });
  assert.ok(plan);

  return plan;
}

test("a patch changes only snapshot bytes, retains upstream notices and records the exact old hash", () => {
  const original = Buffer.from("// Copyright TEST ONLY\n// All rights reserved.\nmodule.exports=()=>1;\n");
  const files = [{ path: "node_modules/test-cli/cli.cjs", body: original }, { path: "node_modules/test-cli/LICENSE", body: Buffer.from("TEST ONLY license") }];
  const plan = fixture("#!/usr/bin/env node\nmodule.exports=()=>2;", sha256Bytes(original));
  const adapted = adaptNpmFiles(plan, files), text = Buffer.from(adapted.find(row => row.path.endsWith("cli.cjs"))!.body).toString("utf8");

  assert.ok(text.startsWith("#!/usr/bin/env node\n"));
  assert.match(text, /Copyright TEST ONLY\n\/\/ All rights reserved/);
  assert.match(text, new RegExp(`Modified by Trylo tool learning; upstream SHA-256: ${sha256Bytes(original)}`));
  assert.match(text, /module.exports=\(\)=>2/);
  assert.match(original.toString("utf8"), /module.exports=\(\)=>1/);
  assert.strictEqual(adapted.find(row => row.path.endsWith("LICENSE")), files[1]);
});

test("old-hash mismatch and absent source cannot become a snapshot overlay", () => {
  const plan = fixture("module.exports=()=>2;", "0".repeat(64));
  for (const files of [[], [{ path: "node_modules/test-cli/cli.cjs", body: Buffer.from("original") }]]) {
    assert.throws(() => adaptNpmFiles(plan, files), error => error instanceof NpmAdaptationError && error.code === "npm_patch_source_mismatch");
  }
});

test("overlay notices preserve BOM and first-line shebang and the actual Node child can execute the patched snapshot", async t => {
  const base = testScratchPath("npm-adaptation-files-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = Buffer.from("// Copyright TEST ONLY\nconsole.log('original');\n");
  const source = "\uFEFF#!/usr/bin/env node\r\nconsole.log('patched');\n", plan = fixture(source, sha256Bytes(original));
  const files = adaptNpmFiles(plan, [{ path: "node_modules/test-cli/cli.cjs", body: original }]);
  const patched = Buffer.from(files[0]!.body).toString("utf8");

  assert.ok(patched.startsWith("#!/usr/bin/env node\r\n\uFEFF"));
  assert.equal(plan.patches?.[0]?.source, source, "snapshot header normalization never rewrites the canonical patch source");
  assert.ok(patched.indexOf("Modified by Trylo") > patched.indexOf("\r\n"));
  assert.ok(patched.includes("Copyright TEST ONLY"));
  assert.equal(original.toString("utf8"), "// Copyright TEST ONLY\nconsole.log('original');\n");
  const result = await runNpmSnapshot({ files, entrypoint: "node_modules/test-cli/cli.cjs", runtime: plan.runtime,
    schema: NPM_CLI_INPUT_SCHEMA, timeoutMs: 5000 }, { argv: [], stdin: "" },
  { scratchRoot: root, nodeExecutable: process.execPath, isolation: localNodeContract }, new AbortController().signal);

  assert.deepEqual(result, { kind: "value", value: { stdout: "patched\n", stderr: "", exitCode: 0 } });
  const noNewline = adaptNpmFiles(fixture("\uFEFF#!/usr/bin/env node", sha256Bytes(original)), [{ path: "node_modules/test-cli/cli.cjs", body: original }]);

  assert.ok(Buffer.from(noNewline[0]!.body).toString("utf8").startsWith("#!/usr/bin/env node\n\uFEFF"));
});
