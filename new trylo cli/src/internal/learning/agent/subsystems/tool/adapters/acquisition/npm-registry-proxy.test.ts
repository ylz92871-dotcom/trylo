import assert from "node:assert/strict";
import test from "node:test";
import { get } from "node:http";
import { err, ok } from "../../../../../../tooling/contract/result.js";
import type { HttpTransport, HttpTransportRequest } from "./transport.js";
import { openNpmMetadataRegistry } from "./npm-registry-proxy.js";
import { recordOf } from "../../domain/evolution/parse.js";

const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;

function metadata(extra: Record<string, unknown> = {}) {
  return { name: "TEST_ONLY".toLowerCase(), "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": {
    name: "test_only", version: "1.0.0", dist: { tarball: "https://registry.npmjs.org/test_only/-/test_only-1.0.0.tgz", integrity }, ...extra } } };
}

function read(url: string): Promise<{ status: number; value: unknown }> {
  return new Promise((resolve, reject) => {
    const request = get(url, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: response.statusCode ?? 0, value: text.length === 0 ? undefined : JSON.parse(text) });
      });
    });
    request.once("error", reject);
  });
}

test("the actual loopback proxy requests abbreviated metadata without forwarding scripts or registry config", async t => {
  const calls: HttpTransportRequest[] = [];
  const transport: HttpTransport = { get: async request => {
    calls.push(request);
    return ok({ status: 200, body: request.headers.accept === "application/vnd.npm.install-v1+json"
      ? Buffer.from(JSON.stringify(metadata({ hasInstallScript: true, scripts: { install: "TEST ONLY never execute" }, _resolved: "https://example.invalid/", _authToken: "TEST ONLY" })))
      : Buffer.alloc(2 * 1024 * 1024 + 1) });
  } };
  const proxy = await openNpmMetadataRegistry(transport, new AbortController().signal);
  t.after(proxy.close);
  const result = await read(`${proxy.url}test_only`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.value, { name: "test_only", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": {
    name: "test_only", version: "1.0.0", dist: metadata().versions["1.0.0"].dist, hasInstallScript: true } } });
  assert.equal(calls[0]?.url, "https://registry.npmjs.org/test_only");
  assert.equal(calls[0]?.maxBytes, 2 * 1024 * 1024);
  assert.equal(calls[0]?.timeoutMs, 15_000);
});

test("abbreviated install-hook facts survive even when the packument contains no scripts", async t => {
  const proxy = await openNpmMetadataRegistry({ get: async () => ok({ status: 200, body: Buffer.from(JSON.stringify(metadata({ hasInstallScript: true }))) }) }, new AbortController().signal);
  t.after(proxy.close);
  const result = await read(`${proxy.url}test_only`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.value, { ...metadata(), versions: { "1.0.0": { ...metadata().versions["1.0.0"], hasInstallScript: true } } });
});

test("unsupported versions keep real flags and receive an exact local refusal only when selected", async t => {
  for (const [extra, code] of [[{ _hasShrinkwrap: true }, "npm_shrinkwrap_unsupported"], [{ bundleDependencies: ["leaf"] }, "npm_bundled_dependency_unsupported"]] as const) {
    const proxy = await openNpmMetadataRegistry({ get: async () => ok({ status: 200, body: Buffer.from(JSON.stringify(metadata(extra))) }) }, new AbortController().signal);

    t.after(proxy.close);
    const result = await read(`${proxy.url}test_only`);
    assert.equal(result.status, 200);
    const value = result.value;
    assert.ok(recordOf(value) && recordOf(value.versions));
    const entry = value.versions["1.0.0"];
    assert.ok(recordOf(entry) && recordOf(entry.dist));
    assert.equal(entry.dist.integrity, integrity);

    for (const [key, flag] of Object.entries(extra)) assert.deepEqual(entry[key], flag);

    const marker = entry.dist.tarball;
    assert.equal(typeof marker, "string");
    assert.ok(typeof marker === "string");
    assert.ok(marker.startsWith(`${proxy.url}_trylo_unsupported_archive/`));
    assert.notEqual(marker, metadata().versions["1.0.0"].dist.tarball);
    assert.deepEqual(proxy.diagnostics(), [], "an unselected historical version has not failed");
    assert.equal((await read(marker)).status, 403);
    assert.deepEqual(proxy.diagnostics(), [{ packageName: "test_only", version: "1.0.0", stage: "selected_archive_semantics", code }]);
    const lock = { packages: { "node_modules/test_only": { version: "1.0.0", resolved: marker } } };

    assert.equal(proxy.unsupportedLock(lock)?.code, code);
    assert.equal(proxy.unsupportedLock({ packages: { "node_modules/test_only": { version: "9.0.0", resolved: marker } } })?.code, "invalid_npm_lock");
  }
});

test("a typed transport failure keeps its exact package and stage, without npm stderr", async t => {
  const proxy = await openNpmMetadataRegistry({ get: async () => err("timeout", "TEST ONLY untrusted transport prose") }, new AbortController().signal);
  t.after(proxy.close);
  assert.equal((await read(`${proxy.url}test_only`)).status, 502);
  assert.deepEqual(proxy.diagnostics(), [{ packageName: "test_only", stage: "metadata_fetch", code: "timeout" }]);
});

test("proxy shutdown cancels its in-flight source transport even when the caller did not cancel", { timeout: 2_000 }, async t => {
  let begun!: () => void, ended!: () => void;
  const started = new Promise<void>(resolve => { begun = resolve; }), cancelled = new Promise<void>(resolve => { ended = resolve; });
  const caller = new AbortController();
  const transport: HttpTransport = { get: request => new Promise(resolve => {
    begun();
    request.signal?.addEventListener("abort", () => {
      ended();
      resolve(err("cancelled", "TEST ONLY"));
    }, { once: true });
  }) };
  const proxy = await openNpmMetadataRegistry(transport, caller.signal);
  t.after(proxy.close);
  const pending = read(`${proxy.url}test_only`).catch(() => undefined);

  await started;
  await proxy.close();
  await cancelled;
  await pending;
  assert.equal(caller.signal.aborted, false);
});

test("a metadata header cannot bypass the shared redirect-domain boundary", async t => {
  const calls: string[] = [];
  const proxy = await openNpmMetadataRegistry({ get: async request => { calls.push(request.url);
    return ok({ status: 302, location: "https://example.invalid/metadata", body: new Uint8Array() }); } }, new AbortController().signal);
  t.after(proxy.close);
  assert.equal((await read(`${proxy.url}test_only`)).status, 502);
  assert.equal(calls.length, 1);
  assert.deepEqual(proxy.diagnostics(), [{ packageName: "test_only", stage: "metadata_fetch", code: "host_not_allowed" }]);
});
