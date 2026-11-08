import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ok } from "../../../../../../tooling/contract/result.js";
import { contentHashOf } from "../../../../../control/hash.js";
import { createToolResearchService } from "./research-service.js";
import { NPM } from "./platforms/npm.js";
import type { HttpTransport } from "./transport.js";
import { decodeToolInspectionReport, toolGenerationResearchReference } from "../../domain/evolution/research.js";

const candidate = { platform: "npm" as const, id: "@example/parser", version: "1.2.3" };
const commit = "a".repeat(40);

test("npm API inspection pins its manifest and repository file without archive or execution", async () => {
  const requests: string[] = [], source = "export function parse(input) { return input.rows; }";
  const blobSha = createHash("sha1").update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest("hex");
  const transport: HttpTransport = { get: async request => { requests.push(request.url);
    const value = requests.length === 1 ? { name: candidate.id, version: candidate.version,
      repository: { url: "git+https://github.com/example/parser.git", directory: "packages/core" }, gitHead: commit, bin: { parse: "bin.js" } }
      : { type: "file", encoding: "base64", path: "packages/core/src/index.ts", sha: blobSha, content: Buffer.from(source).toString("base64") };
    return ok({ status: 200, body: Buffer.from(JSON.stringify(value)) });
  } };
  const report = await createToolResearchService({ transport }).inspect({ candidate, path: "src/index.ts" }, new AbortController().signal);

  assert.equal(report.status, "complete");
  assert.ok(decodeToolInspectionReport(report));
  assert.equal(requests.length, 2);
  assert.equal(requests[0], "https://registry.npmjs.org/%40example%2Fparser/1.2.3");
  assert.equal(requests[1], `https://api.github.com/repos/example/parser/contents/packages/core/src/index.ts?ref=${commit}`);
  assert.equal(report.documents[1]?.text, source);
  assert.equal(report.documents[1]?.contentHash, contentHashOf(source));
  assert.equal(report.documents[1]?.contentHashBasis, "canonical_rendered_text");
  assert.deepEqual(report.documents[1]?.basis, { kind: "repository_reference", repository: "example/parser", refKind: "commit", requestedRef: commit,
    blobSha, npmLink: { package: { name: candidate.id, version: candidate.version }, relationship: "publisher_claimed_gitHead" } });
  assert.equal(report.documents[0]?.basis?.kind, "registry_version_metadata");
});

test("research cannot label mismatched Git blobs or another file as its requested source", async () => {
  const source = "module.exports = input => input;", bytes = Buffer.from(source);
  const blobSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

  for (const mode of ["wrong_sha", "wrong_path"] as const) {
    const service = createToolResearchService({ transport: { get: async () => ok({ status: 200, body: Buffer.from(JSON.stringify({
      type: "file", encoding: "base64", path: mode === "wrong_path" ? "another.js" : "index.js",
      sha: mode === "wrong_sha" ? "b".repeat(40) : blobSha, content: bytes.toString("base64") })) }) } });
    const report = await service.inspect({ candidate: { platform: "github", id: "example/parser", version: commit }, path: "index.js" }, new AbortController().signal);
    assert.equal(report.status, "failed");
    assert.equal(report.code, mode === "wrong_sha" ? "inspection_blob_mismatch" : "inspection_content_mismatch");
  }
});

test("generation references preserve documentation hints but withhold repository implementation bodies", () => {
  const text = "UPSTREAM_IMPLEMENTATION_BODY", source = { sourceUrl: "https://api.github.com/repos/example/parser/contents/index.js",
    path: "index.js", kind: "source" as const, text, contentHash: contentHashOf(text), truncated: false };
  const safe = toolGenerationResearchReference(source);

  assert.equal(safe.text, undefined);
  assert.equal(safe.sourceBodyWithheld, "repository_source_is_not_reviewed_installation_bytes");
  assert.equal(safe.contentHash, source.contentHash);
  assert.equal(JSON.stringify(safe).includes(text), false);
  const documentation = toolGenerationResearchReference({ ...source, kind: "documentation", text: "API example: parse(rows)", contentHash: contentHashOf("API example: parse(rows)") });

  assert.equal(documentation.text, "API example: parse(rows)");
});

test("research refuses traversal, unpinned npm metadata and redirects before fetching executable archives", async () => {
  let requests = 0;
  const transport: HttpTransport = { get: async () => { requests++;
  return ok({ status: 302,
    location: "https://registry.npmjs.org/parser/-/parser-1.2.3.tgz", body: new Uint8Array() }); } };
  const service = createToolResearchService({ transport }), signal = new AbortController().signal;

  assert.equal((await service.inspect({ candidate, path: "../secret" }, signal)).code, "invalid_inspection_request");
  assert.equal(requests, 0);
  const report = await service.inspect({ candidate }, signal);

  assert.equal(report.status, "failed");
  assert.equal(requests, 1, "the redirect target never reaches the transport");
});

test("npm discovery carries the exact searched or latest version into subsequent acquisition", () => {
  const searched = NPM.readSearch({ objects: [{ package: { name: candidate.id, version: candidate.version } }] });
  assert.ok(searched.ok);
  assert.deepEqual(searched.value, [candidate]);
  const selected = NPM.readMetadata({ platform: "npm", id: candidate.id }, { "dist-tags": { latest: candidate.version },
    versions: { [candidate.version]: { name: candidate.id, version: candidate.version, license: "MIT", repository: { url: "git+https://github.com/example/parser.git" } } } });

  assert.ok(selected.ok);
  assert.equal(selected.value.ref.version, candidate.version);
  assert.equal(selected.value.licenseSpdx, "MIT");
  assert.equal(NPM.readMetadata(candidate, { versions: {} }).ok, false);
  assert.deepEqual(NPM.metadataUrl(candidate), ok("https://registry.npmjs.org/%40example%2Fparser/1.2.3"));
  assert.equal(NPM.readMetadata(candidate, { license: "MIT", repository: "https://github.com/example/parser" }).ok, false,
    "metadata without an exact name/version cannot borrow the requested identity");
  assert.equal(NPM.readMetadata(candidate, { name: candidate.id, version: candidate.version, license: "MIT" }).ok, true,
    "a missing repository leaves registry provenance rather than inventing or authorizing an upstream");
});
