import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJson,
  checksumFor,
  decodeDocument,
  emptyDocument,
  encodeDocument,
} from "./document.js";
import type { McpServerEntry } from "../../ports/mcp-registry.js";

/**
 * M2 (document half): the on-disk shape is read strictly. Corruption, an
 * unknown key, an unknown version and a checksum mismatch are all failures —
 * never "the registry is empty", which would let the next write clobber
 * whatever the file really said.
 */

const fsServer: McpServerEntry = {
  name: "fs",
  transport: "stdio",
  command: "node",
  args: ["server.mjs"],
  env: { TOKEN: "secret" },
  enabled: true,
};

test("encode then decode round-trips the same entries", () => {
  const raw = encodeDocument([fsServer]);
  const decoded = decodeDocument(raw, "test.json");

  assert.equal(decoded.ok, true);

  if (decoded.ok) {
    assert.deepEqual(decoded.value.servers, [fsServer]);
    assert.equal(decoded.value.formatVersion, 1);
  }
});

test("an unknown format version fails closed", () => {
  const doc = JSON.stringify({ formatVersion: 9, checksum: "x", servers: [] });
  const decoded = decodeDocument(doc, "test.json");
  assert.equal(decoded.ok, false);
  if (!decoded.ok) {
    assert.equal(decoded.code, "unknown_format_version");
  }
});

test("an unknown top-level key is refused", () => {
  const doc = JSON.stringify({ formatVersion: 1, checksum: "x", servers: [], autoApprove: true });
  const decoded = decodeDocument(doc, "test.json");
  assert.equal(decoded.ok, false);
  if (!decoded.ok) {
    assert.equal(decoded.code, "unknown_key");
  }
});

test("adversarial #1: a url key inside an entry is refused as unsupported transport", () => {
  const doc = JSON.stringify({
    formatVersion: 1,
    checksum: "x",
    servers: [{ name: "fs", transport: "stdio", command: "npx", args: [], env: {}, enabled: true, url: "http://x" }],
  });
  const decoded = decodeDocument(doc, "test.json");

  assert.equal(decoded.ok, false);

  if (!decoded.ok) {
    assert.equal(decoded.code, "unsupported_transport");
  }
});

test("an unknown key inside an entry is refused", () => {
  const doc = JSON.stringify({
    formatVersion: 1,
    checksum: "x",
    servers: [{ name: "fs", transport: "stdio", command: "npx", args: [], env: {}, enabled: true, inheritEnv: true }],
  });
  const decoded = decodeDocument(doc, "test.json");

  assert.equal(decoded.ok, false);

  if (!decoded.ok) {
    assert.equal(decoded.code, "unsupported_transport");
  }
});

test("adversarial #2: a checksum that does not match the entries is refused", () => {
  const good = encodeDocument([fsServer]);
  const parsed = JSON.parse(good) as { checksum: string };

  parsed.checksum = "0".repeat(64);
  const decoded = decodeDocument(JSON.stringify(parsed), "test.json");

  assert.equal(decoded.ok, false);

  if (!decoded.ok) {
    assert.equal(decoded.code, "checksum_mismatch");
  }
});

test("not JSON and a non-object document are both invalid_document", () => {
  assert.equal(decodeDocument("{", "test.json").ok, false);
  const array = decodeDocument("[]", "test.json");
  assert.equal(array.ok, false);
  if (!array.ok) {
    assert.equal(array.code, "invalid_document");
  }
});

test("canonicalJson sorts keys at every level, so the checksum is order-stable", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(checksumFor([fsServer]), checksumFor([fsServer]));
});

test("emptyDocument is well-formed and decodes", () => {
  const empty = emptyDocument();
  assert.deepEqual(empty.servers, []);
  assert.equal(checksumFor([]), empty.checksum);
});

// ---------------------------------------------------------------------------
// T1 (remote entries per 2026-09-16-ADR-MCP远端传输.md): the document carries
// `http`/`sse` entries with url/headers, and *never* carries both shapes.
// ---------------------------------------------------------------------------

const remoteServer: McpServerEntry = {
  name: "remote",
  transport: "http",
  command: "",
  args: [],
  env: {},
  enabled: true,
  url: "https://example.com/mcp",
  headers: { Authorization: "Bearer token" },
};

test("T1: a remote entry round-trips without the stdio fields", () => {
  const raw = encodeDocument([remoteServer]);
  const parsed = JSON.parse(raw) as { servers: Array<Record<string, unknown>> };

  // The on-disk shape stores only remote fields; no command/args/env keys.
  assert.deepEqual(Object.keys(parsed.servers[0] ?? {}).sort(), ["enabled", "headers", "name", "transport", "url"]);
  const decoded = decodeDocument(raw, "test.json");

  assert.equal(decoded.ok, true);

  if (decoded.ok) {
    assert.deepEqual(decoded.value.servers, [remoteServer]);
  }
});

test("T1: a remote entry with empty headers round-trips to headers-absent", () => {
  // exactOptionalPropertyTypes forbids `headers: undefined`; destructuring
  // keeps the bare shape.
  const { headers: _dropped, ...bare } = remoteServer;
  const raw = encodeDocument([bare]);
  const decoded = decodeDocument(raw, "test.json");

  assert.equal(decoded.ok, true);

  if (decoded.ok) {
    assert.equal(decoded.value.servers[0]?.headers, undefined);
  }
});

test("T1: a remote entry without a url is invalid_url, not a server", () => {
  const doc = JSON.stringify({
    formatVersion: 1,
    checksum: "x",
    servers: [{ name: "remote", transport: "http", enabled: true }],
  });
  const decoded = decodeDocument(doc, "test.json");

  assert.equal(decoded.ok, false);

  if (!decoded.ok) {
    assert.equal(decoded.code, "invalid_url");
  }
});

test("T1: a remote entry with a non-http url is invalid_url", () => {
  const doc = JSON.stringify({
    formatVersion: 1,
    checksum: "x",
    servers: [{ name: "remote", transport: "sse", url: "ftp://x", enabled: true }],
  });
  const decoded = decodeDocument(doc, "test.json");

  assert.equal(decoded.ok, false);

  if (!decoded.ok) {
    assert.equal(decoded.code, "invalid_url");
  }
});

test("T1: a remote entry carrying stdio fields is refused by field name", () => {
  const doc = JSON.stringify({
    formatVersion: 1,
    checksum: "x",
    servers: [{ name: "remote", transport: "http", url: "https://x", command: "node", enabled: true }],
  });
  const decoded = decodeDocument(doc, "test.json");

  assert.equal(decoded.ok, false);

  if (!decoded.ok) {
    assert.equal(decoded.code, "invalid_command");
  }

  const withEnv = JSON.stringify({
    formatVersion: 1,
    checksum: "x",
    servers: [{ name: "remote", transport: "http", url: "https://x", env: { A: "1" }, enabled: true }],
  });
  const decodedEnv = decodeDocument(withEnv, "test.json");

  assert.equal(decodedEnv.ok, false);

  if (!decodedEnv.ok) {
    assert.equal(decodedEnv.code, "invalid_env");
  }
});

test("T1: stdio and remote entries coexist in one document", () => {
  const raw = encodeDocument([fsServer, remoteServer]);
  const decoded = decodeDocument(raw, "test.json");
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    assert.deepEqual(decoded.value.servers, [fsServer, remoteServer]);
  }
});

test("T1: a headers value is a string map or invalid_headers", () => {
  const doc = JSON.stringify({
    formatVersion: 1,
    checksum: "x",
    servers: [{ name: "remote", transport: "http", url: "https://x", headers: { A: 3 }, enabled: true }],
  });
  const decoded = decodeDocument(doc, "test.json");

  assert.equal(decoded.ok, false);

  if (!decoded.ok) {
    assert.equal(decoded.code, "invalid_headers");
  }
});
