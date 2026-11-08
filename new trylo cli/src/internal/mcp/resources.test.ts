import assert from "node:assert/strict";
import { test } from "node:test";
import {
  interpretResourceList,
  interpretResourceRead,
  interpretResourceTemplates,
  renderResourceContents,
  toResource,
  toResourceContent,
  toResourceTemplate,
} from "./resources.js";
import type { JsonRpcResponse } from "./jsonrpc.js";
import type { JsonValue } from "../protocol/envelope.js";

/**
 * WP15.2 resource interpretation contracts.
 *
 * Every hostile reply shape here is a unit test that needs neither a spawned
 * child nor a socket: a missing URI, a missing array, content that is neither
 * text nor blob, and a binary payload that must never be decoded into the
 * text envelope.
 */

function response(result: JsonValue): JsonRpcResponse {
  return { jsonrpc: "2.0", id: 1, result };
}

function failure(code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: 1, error: { code, message } };
}

test("a listed resource keeps its URI and distrusts its annotations", () => {
  const resource = toResource({
    uri: "file:///notes/today.md",
    name: "today",
    mimeType: "text/markdown",
    annotations: { readOnlyHint: true },
  });

  assert.ok(resource !== undefined);
  assert.equal(resource.uri, "file:///notes/today.md");
  assert.equal(resource.annotationsTrust, "untrusted");
  assert.deepEqual(resource.annotations, { readOnlyHint: true });
});

test("a resource without a URI or name is dropped, not repaired", () => {
  assert.equal(toResource({ name: "nameless" }), undefined);
  assert.equal(toResource({ uri: "", name: "empty" }), undefined);
  assert.equal(toResource({ uri: "file:///x" }), undefined);
  assert.equal(toResource("not-an-object"), undefined);
});

test("a template without a uriTemplate is dropped, not repaired", () => {
  assert.equal(toResourceTemplate({ name: "t", uriTemplate: "" }), undefined);
  const template = toResourceTemplate({ name: "logs", uriTemplate: "file:///logs/{date}.log" });
  assert.ok(template !== undefined);
  assert.equal(template.uriTemplate, "file:///logs/{date}.log");
  assert.equal(template.annotationsTrust, "untrusted");
});

test("resources/list keeps the addressable and reports the cursor", () => {
  const parsed = interpretResourceList(
    response({
      resources: [
        { uri: "file:///a", name: "a" },
        { name: "no-uri" },
        { uri: "file:///b", name: "b" },
      ],
      nextCursor: "page-2",
    }),
  );

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  assert.deepEqual(
    parsed.value.resources.map((item) => item.uri),
    ["file:///a", "file:///b"],
  );
  assert.equal(parsed.value.nextCursor, "page-2");
});

test("resources/list without a resources array fails closed", () => {
  const parsed = interpretResourceList(response({ resources: "nope" }));
  assert.equal(parsed.ok, false);
  if (parsed.ok) {
    return;
  }
  assert.equal(parsed.code, "invalid_resource");
});

test("a JSON-RPC error on resources/list is a protocol error, not a crash", () => {
  const parsed = interpretResourceList(failure(-32601, "unknown method resources/list"));
  assert.equal(parsed.ok, false);
  if (parsed.ok) {
    return;
  }
  assert.equal(parsed.code, "protocol_error");
});

test("templates/list keeps the addressable templates", () => {
  const parsed = interpretResourceTemplates(
    response({ resourceTemplates: [{ name: "t", uriTemplate: "file:///{name}" }] }),
  );

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  assert.equal(parsed.value.templates.length, 1);
  assert.equal(parsed.value.nextCursor, undefined);
});

test("templates/list without a template array fails closed", () => {
  const parsed = interpretResourceTemplates(response({}));
  assert.equal(parsed.ok, false);
  if (parsed.ok) {
    return;
  }
  assert.equal(parsed.code, "invalid_resource");
});

test("resources/read keeps text and reports binary by size, never decodes it", () => {
  const parsed = interpretResourceRead(
    response({
      contents: [
        { uri: "file:///a", mimeType: "text/plain", text: "hello" },
        { uri: "file:///b", mimeType: "image/png", blob: "aGVsbG8=" },
        { uri: "file:///c", mimeType: "text/plain" },
      ],
    }),
  );

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  assert.equal(parsed.value.contents.length, 2);
  const first = parsed.value.contents[0];

  assert.ok(first !== undefined && first.kind === "text" && first.text === "hello");
  const second = parsed.value.contents[1];

  assert.ok(second !== undefined && second.kind === "binary");

  if (second.kind === "binary") {
    assert.equal(second.byteLength, 6);
  }
});

test("a content item without a URI is dropped", () => {
  assert.equal(toResourceContent({ text: "orphan" }), undefined);
});

test("resources/read without a contents array fails closed", () => {
  const parsed = interpretResourceRead(failure(-32602, "missing uri"));
  assert.equal(parsed.ok, false);
  if (parsed.ok) {
    return;
  }
  assert.equal(parsed.code, "protocol_error");
});

test("rendered text joins in order and marks binary omissions", () => {
  const rendered = renderResourceContents(
    [
      { kind: "text", uri: "file:///a", text: "first" },
      { kind: "binary", uri: "file:///b", mimeType: "image/png", byteLength: 12 },
    ],
    1024,
  );

  assert.equal(rendered.truncated, false);
  assert.ok(rendered.output.includes("first"));
  assert.ok(rendered.output.includes("[binary content omitted: image/png, about 12 bytes]"));
});

test("rendering past the byte budget cuts and says so, without splitting UTF-8", () => {
  const rendered = renderResourceContents([{ kind: "text", uri: "file:///a", text: "中文内容很长" }], 7);
  assert.equal(rendered.truncated, true);
  assert.ok(Buffer.byteLength(rendered.output, "utf8") <= 7);
  assert.ok(!rendered.output.includes("�"));
});
