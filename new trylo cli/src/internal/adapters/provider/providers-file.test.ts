import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeDocument,
  encodeDocument,
  PROVIDERS_DOCUMENT_VERSION,
  type DocumentFailureCode,
} from "./providers-file.js";
/**
 * The declared-providers file is user-written and names a host, so the decode
 * is where this package's fail-closed rule is actually exercised: every one of
 * these documents is one a person could plausibly write, and every one of them
 * is refused with a code rather than half-accepted.
 *
 * The assertion that `PROVIDER_KINDS` and the CLI's `--provider` vocabulary are
 * the same set lives on the CLI side (`providers-wiring.test.ts`): this layer
 * does not import from `surface/**`, and a test would not be a good enough
 * reason to start.
 */

function document(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: PROVIDERS_DOCUMENT_VERSION,
    providers: [
      {
        id: "lab",
        kind: "openai-compatible",
        endpoint: "https://lab.example/v1/chat",
        model: "lab-7b",
      },
    ],
    ...overrides,
  });
}

function failureCodeOf(text: string): DocumentFailureCode {
  const decoded = decodeDocument(text);
  assert.equal(decoded.ok, false);
  return decoded.ok ? "not_json" : decoded.failure.code;
}

test("a minimal declaration decodes with the kind's defaults", () => {
  const decoded = decodeDocument(document());

  assert.equal(decoded.ok, true);

  if (!decoded.ok) {
    return;
  }

  const entry = decoded.value.providers[0];

  assert.equal(entry?.id, "lab");
  assert.equal(entry?.kind, "openai-compatible");
  assert.equal(entry?.model, "lab-7b");
  assert.equal(entry?.endpoint, "https://lab.example/v1/chat");
  // Defaults: a keyed family needs a key, and nothing claims reasoning.
  assert.equal(entry?.capabilities.auth, "api_key");
  assert.equal(entry?.capabilities.reasoning, false);
  assert.equal(entry?.capabilities.streaming, true);
  assert.deepEqual(entry?.capabilities.models, []);
});

test("a fixture declaration needs no credential", () => {
  const text = JSON.stringify({
    version: PROVIDERS_DOCUMENT_VERSION,
    providers: [{ id: "offline", kind: "fixture" }],
  });
  const decoded = decodeDocument(text);

  assert.equal(decoded.ok, true);

  if (!decoded.ok) {
    return;
  }

  assert.equal(decoded.value.providers[0]?.capabilities.auth, "none");
});

test("a declared capability set and window are honoured verbatim", () => {
  const text = JSON.stringify({
    version: PROVIDERS_DOCUMENT_VERSION,
    providers: [
      {
        id: "big",
        kind: "openai-compatible",
        endpoint: "https://big.example/v1",
        models: ["big-1", "big-2"],
        auth: "oauth",
        reasoning: true,
        tools: false,
        contextWindow: 200000,
      },
    ],
  });
  const decoded = decodeDocument(text);

  assert.equal(decoded.ok, true);

  if (!decoded.ok) {
    return;
  }

  const caps = decoded.value.providers[0]?.capabilities;

  assert.deepEqual(caps?.models, ["big-1", "big-2"]);
  assert.equal(caps?.auth, "oauth");
  assert.equal(caps?.reasoning, true);
  assert.equal(caps?.tools, false);
  assert.equal(caps?.contextWindow, 200000);
});

test("refusals name what is wrong", () => {
  assert.equal(failureCodeOf("not json at all"), "not_json");
  assert.equal(failureCodeOf("[]"), "bad_shape");
  assert.equal(failureCodeOf(JSON.stringify({ version: 2, providers: [] })), "bad_version");
  assert.equal(
    failureCodeOf(JSON.stringify({ version: 1, provider: [] })),
    "unknown_field",
  );
  assert.equal(
    failureCodeOf(
      JSON.stringify({ version: 1, providers: [{ id: "x", kind: "openai-compatible", modelz: "1" }] }),
    ),
    "unknown_field",
  );
  assert.equal(
    failureCodeOf(JSON.stringify({ version: 1, providers: [{ kind: "openai-compatible" }] })),
    "bad_entry",
  );
  assert.equal(
    failureCodeOf(JSON.stringify({ version: 1, providers: [{ id: "x", kind: "gemini" }] })),
    "bad_entry",
  );
});

test("a built-in provider cannot be redefined", () => {
  // This is the one that matters: a shipped id that could be quietly re-pointed
  // would turn "offline and deterministic" into a claim about a file.
  assert.equal(
    failureCodeOf(
      JSON.stringify({ version: 1, providers: [{ id: "fixture", kind: "openai-compatible" }] }),
    ),
    "reserved_id",
  );
  assert.equal(
    failureCodeOf(
      JSON.stringify({
        version: 1,
        providers: [
          { id: "a", kind: "fixture" },
          { id: "a", kind: "fixture" },
        ],
      }),
    ),
    "duplicate_id",
  );
});

test("encode then decode is a round trip", () => {
  const decoded = decodeDocument(document({ selected: "lab" }));

  assert.equal(decoded.ok, true);

  if (!decoded.ok) {
    return;
  }

  const again = decodeDocument(encodeDocument(decoded.value));

  assert.equal(again.ok, true);

  if (!again.ok) {
    return;
  }

  assert.deepEqual(again.value, decoded.value);
});

test("the selection is carried only when it was written", () => {
  const without = decodeDocument(document());
  assert.equal(without.ok && without.value.selected, undefined);
  const withSelected = decodeDocument(document({ selected: "lab" }));
  assert.equal(withSelected.ok ? withSelected.value.selected : undefined, "lab");
});
