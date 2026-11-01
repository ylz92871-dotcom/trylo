import assert from "node:assert/strict";
import test from "node:test";
import type { JsonFunctionToolPackageManifest } from "../contract/types.js";
import { manifest as mcpManifest } from "../testing/fixtures.js";
import { validateManifest } from "./manifest.js";

const manifest: JsonFunctionToolPackageManifest = { runtimeProfile: "confined_json_function_v1", moduleFormat: "commonjs", inputTransport: "json",
  identity: "double", version: "1.0.0", origin: "self_created", licenseSpdx: "MIT", entrypoint: "candidate.cjs", capabilities: ["double"], permissions: [],
  processIsolation: true, cwdWhitelist: [], envWhitelist: [], secretsWhitelist: [], healthProbe: true, alwaysLoad: false, shouldDefer: true,
  cancelSupported: true, timeoutMs: 5000, idempotencyKeyRequired: true, sideEffectCommitPoint: "none", stdoutBytes: 65_536, stderrBytes: 65_536,
  resultChars: 32_768, postinstall: "forbidden", thirdPartyTypes: "isolated" };

test("confined JSON scripts have their own ABI without claiming an MCP server", () => {
  assert.ok(validateManifest(manifest).ok);
  const mixed = { ...manifest, mcpTransport: "stdio", mcpSchemaVersion: "2024-11-05" };
  assert.ok(!validateManifest(mixed).ok);
});
test("old implicit MCP manifests and explicit MCP profiles retain the existing contract", () => {
  const legacy = mcpManifest(); assert.ok(validateManifest(legacy).ok);
  assert.ok(validateManifest({ ...legacy, runtimeProfile: "mcp_stdio" }).ok);
  assert.equal(Object.hasOwn(legacy, "runtimeProfile"), false);
});
test("a JSON profile cannot smuggle IO, host environment, secrets, directories or side effects", () => {
  for (const change of [{ permissions: ["network"] }, { envWhitelist: ["PATH"] }, { secretsWhitelist: ["TOKEN"] },
    { cwdWhitelist: ["."] }, { sideEffectCommitPoint: "after-write" }]) {
    const result = validateManifest({ ...manifest, ...change }); assert.ok(!result.ok); assert.equal(result.code, "json_profile_not_pure");
  }
});
test("JSON profile has bounded integer budgets and a fixed confined entrypoint", () => {
  for (const timeoutMs of [NaN, Infinity, 0, -1, 1.5, 60_001]) assert.ok(!validateManifest({ ...manifest, timeoutMs }).ok);
  for (const change of [{ stdoutBytes: 65_537 }, { stderrBytes: 65_537 }, { resultChars: 32_769 }, { stdoutBytes: NaN }, { entrypoint: "../candidate.cjs" }]) assert.ok(!validateManifest({ ...manifest, ...change }).ok);
});
