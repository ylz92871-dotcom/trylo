import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ok, err } from "../../tooling/contract/result.js";
import { createToolAcquisitionService } from "./search-service.js";
import { createHttpsTransport, type HttpTransport, type HttpTransportRequest, type HttpsRequestFactory } from "./transport.js";

const GITHUB_RESULT = { items: [{ full_name: "example/parser" }] };
const GITHUB_METADATA = {
  html_url: "https://github.com/example/parser",
  license: { spdx_id: "MIT" },
  owner: { type: "User" },
};

function replies(handler: (request: HttpTransportRequest) => unknown): {
  readonly transport: HttpTransport;
  readonly requests: HttpTransportRequest[];
} {
  const requests: HttpTransportRequest[] = [];
  return {
    requests,
    transport: {
      get: async request => {
        requests.push(request);
        return ok({ status: 200, body: new TextEncoder().encode(JSON.stringify(handler(request))) });
      },
    },
  };
}

test("AS1 searches and resolves metadata without inventing package audit facts", async () => {
  const { transport, requests } = replies(request => request.url.includes("/search/") ? GITHUB_RESULT : GITHUB_METADATA);
  const result = await createToolAcquisitionService({ transport }).search({ capability: "parse a table", platforms: ["github"] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "complete");
  assert.deepEqual(result.value.searchedPlatforms, ["github"]);
  assert.deepEqual(result.value.discovered, [{ platform: "github", id: "example/parser" }]);
  assert.equal(result.value.candidates[0]?.licenseSpdx, "MIT");
  assert.equal(result.value.candidates[0]?.officialIdentity, "unverified");
  assert.equal("windowsEvidence" in (result.value.candidates[0] ?? {}), false);
  assert.equal("dependencySbom" in (result.value.candidates[0] ?? {}), false);
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[0]?.url ?? "").searchParams.get("q"), "parse a table");
});

test("AS2 deduplicates references and limits total metadata calls", async () => {
  const { transport, requests } = replies(request => request.url.includes("/search/")
    ? { items: [{ full_name: "example/one" }, { full_name: "example/one" }, { full_name: "example/two" }, { full_name: "example/three" }] }
    : GITHUB_METADATA);
  const result = await createToolAcquisitionService({ transport, maxCandidates: 2 }).search({ capability: "parse", platforms: ["github", "github"] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.candidates.length, 2);
  assert.deepEqual(result.value.discovered.map(ref => ref.id), ["example/one", "example/two"]);
  assert.equal(requests.length, 3);
});

test("AS3 preserves successful platforms and reports unavailable PyPI search", async () => {
  const { transport } = replies(request => request.url.includes("/search/") ? GITHUB_RESULT : GITHUB_METADATA);
  const result = await createToolAcquisitionService({ transport }).search({ capability: "parse", platforms: ["github", "pypi"] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "partial");
  assert.equal(result.value.candidates.length, 1);
  assert.deepEqual(result.value.failures.map(failure => [failure.platform, failure.stage, failure.code]), [["pypi", "search", "search_unsupported"]]);
});

test("AS4 reports failed platform searches and failed metadata separately", async () => {
  const requests: string[] = [];
  const transport: HttpTransport = { get: async request => {
    requests.push(request.url);
    if (request.url.includes("registry.npmjs.org")) return err("timeout", "injected timeout");
    return ok({ status: 200, body: new TextEncoder().encode(JSON.stringify(request.url.includes("/search/") ? GITHUB_RESULT : { license: null, html_url: "https://evil.example/repo" })) });
  } };
  const result = await createToolAcquisitionService({ transport }).search({ capability: "parse", platforms: ["github", "npm"] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "failed");
  assert.equal(result.value.candidates.length, 0);
  assert.deepEqual(result.value.failures.map(failure => [failure.stage, failure.code]), [["search", "timeout"], ["metadata", "domain_mismatch"]]);
  assert.equal(requests.length, 3);
});

test("AS5 empty search is complete and does not fetch metadata", async () => {
  const { transport, requests } = replies(() => ({ items: [] }));
  const result = await createToolAcquisitionService({ transport }).search({ capability: "parse", platforms: ["github"] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "complete");
  assert.deepEqual(result.value.candidates, []);
  assert.equal(requests.length, 1);
});

test("AS6 rejects malformed requests before any network action", async () => {
  const { transport, requests } = replies(() => ({}));
  for (const maxCandidates of [0, -1, 1.5, 21, Number.NaN]) {
    const result = await createToolAcquisitionService({ transport, maxCandidates }).search({ capability: "parse" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "invalid_request");
  }
  const service = createToolAcquisitionService({ transport });
  for (const capability of ["", "  ", "a".repeat(513)]) {
    const result = await service.search({ capability });
    assert.equal(result.ok, false);
  }
  assert.equal((await service.search({ capability: "parse", platforms: [] })).ok, false);
  assert.equal((await service.metadata({ platform: "github", id: "../../other?token=value" })).ok, false);
  assert.equal(requests.length, 0);
});

test("AS7 pre-cancelled search and metadata perform no requests", async () => {
  const { transport, requests } = replies(() => ({}));
  const signal = AbortSignal.abort();
  const service = createToolAcquisitionService({ transport });
  for (const result of [await service.search({ capability: "parse", signal }), await service.metadata({ platform: "pypi", id: "parser" }, signal)]) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "cancelled");
  }
  assert.equal(requests.length, 0);
});

test("AS8 cancellation reaches an in-flight request and prevents metadata requests", async () => {
  const controller = new AbortController();
  let entered: (() => void) | undefined;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const requests: HttpTransportRequest[] = [];
  const transport: HttpTransport = { get: request => new Promise(resolve => {
    requests.push(request);
    request.signal?.addEventListener("abort", () => resolve(err("cancelled", "cancelled")), { once: true });
    entered?.();
  }) };
  const pending = createToolAcquisitionService({ transport }).search({ capability: "parse", platforms: ["github"], signal: controller.signal });
  await ready;
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "cancelled");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.signal, controller.signal);
});

test("AS9 exact-name metadata keeps missing license unknown", async () => {
  const { transport } = replies(() => ({ info: { project_urls: { Repository: "https://github.com/example/parser" } } }));
  const result = await createToolAcquisitionService({ transport }).metadata({ platform: "pypi", id: "parser" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.licenseSpdx, "UNKNOWN");
  assert.equal(result.value.officialIdentity, "unverified");
});

test("AS10 transport rejection becomes a typed failure without private error text", async () => {
  const transport: HttpTransport = { get: async () => { throw new Error("private-token-example"); } };
  const result = await createToolAcquisitionService({ transport }).metadata({ platform: "github", id: "example/parser" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "network_failure");
    assert.equal(result.message.includes("private-token-example"), false);
  }
});

test("AS11 HTTPS cancellation destroys the real request handle and settles once", async () => {
  const controller = new AbortController();
  class Request extends EventEmitter {
    destroys = 0;
    setTimeout() { return this; }
    end() {}
    destroy() { this.destroys += 1; this.emit("error", new Error("destroyed")); return this; }
  }
  const handle = new Request();
  const factory: HttpsRequestFactory = () => handle;
  const pending = createHttpsTransport(factory).get({ url: "https://api.github.com/repos/example/parser", headers: {}, timeoutMs: 15_000, maxBytes: 1024, signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "cancelled");
  assert.equal(handle.destroys, 1);
  handle.emit("error", new Error("late failure"));
});

test("AS12 timeout keeps its typed outcome when destruction emits a synchronous error", async () => {
  let timeout: (() => void) | undefined;
  class Request extends EventEmitter {
    destroys = 0;
    setTimeout(_milliseconds: number, callback: () => void) { timeout = callback; return this; }
    end() {}
    destroy() { this.destroys += 1; this.emit("error", new Error("destroyed")); return this; }
  }
  const handle = new Request();
  const pending = createHttpsTransport(() => handle).get({ url: "https://api.github.com/repos/example/parser", headers: {}, timeoutMs: 15_000, maxBytes: 1024 });
  timeout?.();
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "timeout");
  assert.equal(handle.destroys, 1);
});
