import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "../../protocol/envelope.js";
import {
  chatStructuredFields,
  loadResponseSchema,
  responsesStructuredFields,
  wantsStructuredOutput,
} from "./structured-output.js";

/**
 * WP18.3 red-to-green contract: schema parsing, wire mapping, system-prompt
 * combination. The red half was shown by asserting these imports against the
 * unfixed tree (no such module): every case below failed at resolve time
 * before the module landed.
 */

test("a schema file must be a non-empty JSON object", () => {
  assert.deepEqual(loadResponseSchema("{ broken"), {
    ok: false,
    failure: { code: "not_json", detail: "schema file is not valid JSON" },
  });
  assert.equal(loadResponseSchema("[1,2]").ok, false);
  assert.equal(loadResponseSchema("{}").ok, false);
  const good = loadResponseSchema('{"type":"object","properties":{"a":{"type":"string"}}}');

  assert.equal(good.ok, true);

  if (good.ok) {
    assert.equal(good.schema["type"], "object");
  }
});

test("absent schema means absent wire fields, never a default", () => {
  assert.equal(chatStructuredFields(undefined), undefined);
  assert.equal(responsesStructuredFields(undefined), undefined);
  const schema: JsonObject = { type: "object" };
  const chat = chatStructuredFields(schema);

  assert.equal(chat?.response_format.type, "json_schema");
  assert.equal(chat?.response_format.json_schema.strict, true);
  assert.equal(chat?.response_format.json_schema.name, "trylo_structured_output");
  const responses = responsesStructuredFields(schema);

  assert.equal(responses?.text.format.type, "json_schema");
});

test("wantsStructuredOutput reads the request, not the wire", () => {
  assert.equal(
    wantsStructuredOutput({ attemptId: "a", model: "m", messages: [], tools: [] }),
    false,
  );
  assert.equal(
    wantsStructuredOutput({
      attemptId: "a",
      model: "m",
      messages: [],
      tools: [],
      responseSchema: { type: "object" },
    }),
    true,
  );
});
