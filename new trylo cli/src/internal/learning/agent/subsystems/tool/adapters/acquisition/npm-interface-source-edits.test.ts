import assert from "node:assert/strict";
import test from "node:test";
import { contentHashOf } from "../../../../../control/hash.js";
import { decodeNpmToolInterface } from "../../domain/evolution/npm-production-plan.js";
import { resolveNpmInterfaceSourceEdits } from "./npm-interface-source-edits.js";
import { sha256Bytes } from "./npm-package-check.js";

const descriptor = { identity: "normalized", description: "Normalize package output", inputSchema: { type: "object" },
  mastery: { whenToUse: ["Normalize known data"], preconditions: [], pitfalls: [] } };
const runtime = { profile: "confined_npm_library_v1", source: "module.exports = input => input;" };

test("compact package edits repair an indexed 100KiB source without changing original installation bytes", () => {
  const source = `/* ${"x".repeat(100 * 1024)} */\nmodule.exports = input => Math.round(input * 2);\n`;
  const file = { path: "node_modules/normalize/index.cjs", body: Buffer.from(source) }, oldSha256 = sha256Bytes(file.body);
  const result = resolveNpmInterfaceSourceEdits({ descriptor, runtime, patches: [{ path: file.path, oldSha256,
    edits: [{ search: "Math.round(input * 2)", replace: "input * 2" }] }] }, [file], []);

  assert.ok(result.ok);
  const canonical = decodeNpmToolInterface(result.interface);
  assert.ok(canonical);
  assert.equal(canonical.patches?.[0]?.source, source.replace("Math.round(input * 2)", "input * 2"));
  assert.equal(canonical.patches?.[0]?.oldSha256, oldSha256);
  assert.equal(Object.hasOwn(canonical.patches?.[0] ?? {}, "edits"), false);
  assert.equal(Buffer.from(file.body).toString("utf8"), source);
});

test("a library adapter patch can only expand from a host-provided exact parent or failed adapter", () => {
  const first = "module.exports = input => Math.round(input);", recent = "module.exports = input => input * 2;";
  const raw = { descriptor, runtime: { profile: "confined_npm_library_v1", sourcePatch: { baseContentHash: contentHashOf(recent),
    edits: [{ search: "input * 2", replace: "input * 3" }] } } };
  const result = resolveNpmInterfaceSourceEdits(raw, [], [first, recent]);
  assert.ok(result.ok);
  const canonical = decodeNpmToolInterface(result.interface);
  assert.ok(canonical);
  assert.equal(canonical.runtime.profile, "confined_npm_library_v1");

  if (canonical.runtime.profile === "confined_npm_library_v1") assert.equal(canonical.runtime.source, "module.exports = input => input * 3;");

  assert.equal(resolveNpmInterfaceSourceEdits(raw, [], [first]).ok, false);
  assert.equal(resolveNpmInterfaceSourceEdits({ ...raw, runtime: { ...raw.runtime, source: first } }, [], [first, recent]).ok, false);
  assert.equal(resolveNpmInterfaceSourceEdits({ ...raw, permissions: ["run_shell"] }, [], [first, recent]).ok, false);
});

test("wrong hashes, unindexed or non-JS targets and conflicting source forms never normalize to a canonical interface", () => {
  const file = { path: "node_modules/normalize/index.js", body: Buffer.from("module.exports = () => 1;") };
  const patch = { path: file.path, oldSha256: sha256Bytes(file.body), edits: [{ search: "1", replace: "2" }] };

  for (const changed of [{ ...patch, oldSha256: "a".repeat(64) }, { ...patch, oldSha256: undefined },
    { ...patch, path: "node_modules/normalize/package.json" }, { ...patch, path: "node_modules/normalize/LICENSE.js" },
    { ...patch, path: "node_modules/normalize/missing.js" }, { ...patch, source: "module.exports = () => 2;" }]) {
    assert.equal(resolveNpmInterfaceSourceEdits({ descriptor, runtime, patches: [changed] }, [file], []).ok, false);
  }

  const badUtf8 = { ...file, body: Uint8Array.from([0xc3, 0x28]) };

  assert.equal(resolveNpmInterfaceSourceEdits({ descriptor, runtime, patches: [{ ...patch, oldSha256: sha256Bytes(badUtf8.body) }] }, [badUtf8], []).ok, false);
  const full = { path: file.path, oldSha256: sha256Bytes(file.body), source: "module.exports = () => 2;" };
  const compatible = resolveNpmInterfaceSourceEdits({ descriptor, runtime, patches: [full] }, [file], []);
  assert.ok(compatible.ok);
  assert.deepEqual(decodeNpmToolInterface(compatible.interface)?.patches, [full], "old complete-source canonical fields remain unchanged");
});
