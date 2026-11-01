import assert from "node:assert/strict";
import test from "node:test";
import { npmPlatformCompatible } from "./npm-tree-resolution.js";

test("npm platform literals, negative entries and the special any value match the target without invented globs", () => {
  const target = { os: "win32", cpu: "x64", nodeVersion: "24.14.1" };
  for (const metadata of [{}, { os: "any", cpu: "x64" }, { os: ["!darwin", "win32"] }, { cpu: ["!arm64"] }]) assert.equal(npmPlatformCompatible(metadata, target), true);
  for (const metadata of [{ os: "darwin" }, { os: ["win32", "!win32"] }, { os: ["*"] }, { cpu: ["arm64"] }]) assert.equal(npmPlatformCompatible(metadata, target), false);
  assert.throws(() => npmPlatformCompatible({ libc: ["glibc"] }, target), /unsupported_npm_dependency/);
  assert.equal(npmPlatformCompatible({ os: ["linux"], libc: ["glibc"] }, target), false, "an off-platform optional package can be omitted without claiming a libc attestation");
});
