import { testScratchPath } from "../../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { err, ok } from "../../../../../../tooling/contract/result.js";
import { locateNpmCli, resolveNpmLearningLock } from "./npm-lock-resolver.js";
import { hostNpmTarget } from "./npm-platform.js";
import type { HttpTransport } from "./transport.js";

// TEST ONLY registry documents. The real existing npm computes the lock; no archive is downloaded or executed.
const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;

function version(name: string, value: string, extra: Record<string, unknown> = {}) {
  return { name, version: value, dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-${value}.tgz`, integrity }, ...extra };
}

async function fixture(t: TestContext, leafVersions: Record<string, Record<string, unknown>>) {
  const base = testScratchPath("npm-resolver-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  const npmCli = await locateNpmCli(process.execPath, process.env.PATH ?? "");
  assert.ok(npmCli, "this process test requires the repository's existing npm");
  const documents: Record<string, unknown> = {
    "test-cli": { name: "test-cli", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": version("test-cli", "1.0.0", { dependencies: { leaf: "^1.0.0" } }) } },
    leaf: { name: "leaf", "dist-tags": { latest: "1.1.0" }, versions: leafVersions },
  };
  const calls: string[] = [];
  const transport: HttpTransport = { get: async request => {
    calls.push(request.url);
    assert.ok(!request.url.endsWith(".tgz"), "unsupported selection must not fetch an upstream archive");
    assert.equal(request.headers.accept, "application/vnd.npm.install-v1+json");
    const value = documents[decodeURIComponent(new URL(request.url).pathname.slice(1))];
    return value === undefined ? err("network_failure", "TEST ONLY unknown metadata") : ok({ status: 200, body: Buffer.from(JSON.stringify(value)) });
  } };
  const resolve = () => resolveNpmLearningLock({ scope: "TEST_ONLY_resolver", name: "test-cli", version: "1.0.0", target: hostNpmTarget(),
    signal: new AbortController().signal, transport, host: { nodeExecutable: process.execPath, npmCli, scratchRoot: path.join(root, "resolve"),
      ...(process.env.SystemRoot === undefined ? {} : { systemRoot: process.env.SystemRoot }) } });

  return { resolve, calls };
}

test("an unsupported historical version does not block the supported version actually selected by npm", async t => {
  const fx = await fixture(t, { "1.0.0": version("leaf", "1.0.0", { _hasShrinkwrap: true, hasInstallScript: true }), "1.1.0": version("leaf", "1.1.0") });
  const result = await fx.resolve();
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.tree.packages.find(pkg => pkg.name === "leaf")?.version, "1.1.0");
  assert.equal(result.tree.packages.length, 2);
  assert.ok(fx.calls.every(url => !url.endsWith(".tgz")));
});

test("a dependency range selecting unsupported shrinkwrap fails explicitly instead of downgrading", async t => {
  const fx = await fixture(t, { "1.0.0": version("leaf", "1.0.0"), "1.1.0": version("leaf", "1.1.0", { _hasShrinkwrap: true }) });
  const result = await fx.resolve();
  assert.ok(!result.ok);
  assert.equal(result.code, "npm_shrinkwrap_unsupported");
  assert.ok("diagnostics" in result && result.diagnostics?.some(row => row.packageName === "leaf" && row.version === "1.1.0" && row.stage === "selected_archive_semantics"));
  assert.ok(fx.calls.every(url => !url.endsWith(".tgz")));
});

test("a dependency range selecting a real bundle is blocked at its exact local marker", async t => {
  const fx = await fixture(t, { "1.0.0": version("leaf", "1.0.0"), "1.1.0": version("leaf", "1.1.0", { dependencies: { inside: "1.0.0" }, bundleDependencies: ["inside"] }) });
  const result = await fx.resolve();
  assert.ok(!result.ok);
  assert.equal(result.code, "npm_bundled_dependency_unsupported");
  assert.ok(fx.calls.every(url => !url.endsWith(".tgz")));
  assert.ok(fx.calls.every(url => !url.endsWith("/inside")));
});

test("install-hook facts are rejected only when they belong to the selected reachable closure", async t => {
  const fx = await fixture(t, { "1.0.0": version("leaf", "1.0.0"), "1.1.0": version("leaf", "1.1.0", { hasInstallScript: true }) });
  const result = await fx.resolve();
  assert.ok(!result.ok);
  assert.equal(result.code, "npm_install_hook_forbidden");
});
