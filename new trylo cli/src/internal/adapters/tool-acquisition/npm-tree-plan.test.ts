import assert from "node:assert/strict";
import test from "node:test";
import { planNpmLockedTree } from "./npm-tree-plan.js";
import { npmTreeId } from "./npm-tree-contract.js";

const target = { os: "win32", cpu: "x64", nodeVersion: "24.14.1" };
const sri = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
function pkg(name: string, version: string, extra: Record<string, unknown> = {}) {
  return { version, resolved: `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`, integrity: sri, license: "MIT", ...extra };
}
function fixture() {
  return { scope: "test-workspace", name: "tool", version: "1.0.0", target,
    lock: { lockfileVersion: 3, packages: { "": { dependencies: { tool: "1.0.0" } },
      "node_modules/tool": pkg("tool", "1.0.0", { dependencies: { leaf: "^2.1.0" } }), "node_modules/leaf": pkg("leaf", "2.2.0") } } };
}

test("freeze an exact hoisted runtime closure without installation, approval or verification claims", () => {
  const input = fixture(), result = planNpmLockedTree(input); assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.tree.packages.length, 2);
  assert.deepEqual(result.tree.packages.find(item => item.name === "tool")?.edges[0]?.resolution, { kind: "package", location: "node_modules/leaf" });
  assert.ok(!Object.hasOwn(result.tree, "activated")); assert.ok(!Object.hasOwn(result.tree, "verified"));
  const changed = planNpmLockedTree({ ...input, scope: "another" }); assert.ok(changed.ok); assert.notEqual(npmTreeId(changed.tree), npmTreeId(result.tree));
});

test("aliases bind actual package identity and peers ignore development-only private packages", () => {
  const base = fixture(), packages = { "": { dependencies: { tool: "1.0.0" } }, "node_modules/tool": pkg("tool", "1.0.0", {
    dependencies: { alias: "npm:@scope/real@^2.0.0" }, peerDependencies: { peer: "^3.0.0" } }),
    "node_modules/tool/node_modules/alias": pkg("@scope/real", "2.1.0", { name: "@scope/real" }),
    "node_modules/tool/node_modules/peer": pkg("peer", "9.0.0", { dev: true }), "node_modules/peer": pkg("peer", "3.2.0") };
  const result = planNpmLockedTree({ ...base, lock: { lockfileVersion: 3, packages } }); assert.ok(result.ok, JSON.stringify(result));
  const edges = result.tree.packages.find(item => item.name === "tool")!.edges;
  assert.equal(edges.find(item => item.name === "alias")?.packageName, "@scope/real");
  assert.deepEqual(edges.find(item => item.name === "peer" && item.kind === "peer")?.resolution, { kind: "package", location: "node_modules/peer" });
});
test("peer shadowing and optional omissions with a different visible fallback are refused", () => {
  const base = fixture();
  const peers = { "": base.lock.packages[""], "node_modules/tool": pkg("tool", "1.0.0", { dependencies: { peer: "^9.0.0" }, peerDependencies: { peer: "^3.0.0" } }),
    "node_modules/tool/node_modules/peer": pkg("peer", "9.0.0"), "node_modules/peer": pkg("peer", "3.2.0") };
  assert.equal(planNpmLockedTree({ ...base, lock: { lockfileVersion: 3, packages: peers } }).ok, false);
  const fallback = { "": base.lock.packages[""], "node_modules/tool": pkg("tool", "1.0.0", { dependencies: { leaf: "1.0.0", mac: "2.0.0" } }),
    "node_modules/leaf": pkg("leaf", "1.0.0", { optionalDependencies: { mac: "^1.0.0" } }),
    "node_modules/leaf/node_modules/mac": pkg("mac", "1.0.0", { optional: true, os: ["darwin"] }), "node_modules/mac": pkg("mac", "2.0.0") };
  assert.equal(planNpmLockedTree({ ...base, lock: { lockfileVersion: 3, packages: fallback } }).ok, false);
});

test("optional platform omissions are explicit, including unused descendants and native scripts outside the target", () => {
  const base = fixture(), packages = { ...base.lock.packages, "node_modules/tool": pkg("tool", "1.0.0", {
    dependencies: { leaf: "^2.0.0" }, optionalDependencies: { mac: "^1.0.0", missing: "^1.0.0" } }),
    "node_modules/mac": pkg("mac", "1.0.0", { os: ["darwin"], optional: true, hasInstallScript: true, dependencies: { helper: "1.0.0" } }),
    "node_modules/helper": pkg("helper", "1.0.0", { optional: true }) };
  const result = planNpmLockedTree({ ...base, lock: { lockfileVersion: 3, packages } }); assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.tree.packages.length, 2); assert.deepEqual(result.tree.omittedOptional, ["node_modules/helper", "node_modules/mac"]);
  const edges = result.tree.packages.find(item => item.name === "tool")!.edges;
  assert.deepEqual(edges.find(item => item.name === "mac")?.resolution, { kind: "omitted", reason: "platform_incompatible" });
  assert.deepEqual(edges.find(item => item.name === "missing")?.resolution, { kind: "omitted", reason: "not_locked" });
});

test("range mismatch, missing required closure, unsupported URLs, path escape and native hooks fail closed", () => {
  for (const change of [{ ...pkg("leaf", "1.0.0") }, { ...pkg("leaf", "2.2.0"), resolved: "git+https://github.com/a/b" },
    { ...pkg("leaf", "2.2.0"), integrity: "sha1-untrusted" }, { ...pkg("leaf", "2.2.0"), hasInstallScript: true }, { ...pkg("leaf", "2.2.0"), engines: { node: ">=99" } }]) {
    const input = fixture(), packages = { ...input.lock.packages, "node_modules/leaf": change };
    assert.equal(planNpmLockedTree({ ...input, lock: { lockfileVersion: 3, packages } }).ok, false);
  }
  const input = fixture();
  assert.equal(planNpmLockedTree({ ...input, lock: { lockfileVersion: 3, packages: { "": input.lock.packages[""], "node_modules/tool": input.lock.packages["node_modules/tool"] } } }).ok, false);
  assert.equal(planNpmLockedTree({ ...input, lock: { lockfileVersion: 3, packages: { ...input.lock.packages, "node_modules/../escape": pkg("escape", "1.0.0") } } }).ok, false);
});

test("stable npm ranges exclude unrequested prereleases, links and unrelated runtime packages", () => {
  const input = fixture(), packages = { ...input.lock.packages, "node_modules/leaf": pkg("leaf", "2.3.0-beta.1") };
  assert.equal(planNpmLockedTree({ ...input, lock: { lockfileVersion: 3, packages } }).ok, false);
  const linked = { ...input.lock.packages, "node_modules/leaf": { ...pkg("leaf", "2.2.0"), link: true } };
  assert.equal(planNpmLockedTree({ ...input, lock: { lockfileVersion: 3, packages: linked } }).ok, false);
  assert.equal(planNpmLockedTree({ ...input, lock: { lockfileVersion: 3, packages: { ...input.lock.packages, "node_modules/unreferenced": pkg("unreferenced", "1.0.0") } } }).ok, false);
});

test("dependency cycles reuse an already frozen ancestor and do not consume unbounded planning work", () => {
  const input = fixture(), packages = { "": input.lock.packages[""], "node_modules/tool": pkg("tool", "1.0.0", { dependencies: { child: "1.0.0" } }),
    "node_modules/tool/node_modules/child": pkg("child", "1.0.0", { dependencies: { tool: "^1.0.0" } }) };
  const result = planNpmLockedTree({ ...input, lock: { lockfileVersion: 3, packages } }); assert.ok(result.ok); assert.equal(result.tree.packages.length, 2);
});
