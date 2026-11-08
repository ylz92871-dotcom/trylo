import assert from "node:assert/strict";
import test from "node:test";
import type { RunCommandOptions } from "./args.js";
import { resolveRequestOptions, type RequestModelSelection } from "./run-request-options.js";

/**
 * WP18.2/18.3 contract: flag quartet, schema file, and fallback resolve to
 * scaffold facts or refuse with a code. Absent everything is the identity —
 * the run the flags never heard of.
 */

const SELECTION: RequestModelSelection = { model: "lab-7b", declaredModels: ["lab-7b"] };

function options(overrides: Partial<RunCommandOptions> = {}): RunCommandOptions {
  return { message: [], readStdin: false, ...overrides };
}

const reader = { readFile: (path: string) => (path === "/schema.json" ? '{"type":"object"}' : undefined) };

test("absent flags resolve to no facts", () => {
  const resolved = resolveRequestOptions(reader, options(), SELECTION);
  assert.deepEqual(resolved, {});
});

test("inline prompts compose replace-then-append; files are read", () => {
  const resolved = resolveRequestOptions(
    { readFile: () => "file prompt" },
    options({ systemPrompt: "replace me", appendSystemPromptFile: "/p.txt" }),
    SELECTION,
  );
  assert.deepEqual(resolved, {
    systemPrompt: { mode: "replace", text: "replace me" },
    systemPromptAppend: "file prompt",
  });
});

test("an unreadable file refuses the run, it never silently drops the flag", () => {
  const resolved = resolveRequestOptions(reader, options({ systemPromptFile: "/missing.txt" }), SELECTION);

  assert.ok("exitCode" in resolved);
  const schema = resolveRequestOptions(reader, options({ outputSchema: "/missing.json" }), SELECTION);

  assert.ok("exitCode" in schema);
  const bad = resolveRequestOptions(
    { readFile: () => "{ broken" },
    options({ outputSchema: "/schema.json" }),
    SELECTION,
  );

  assert.ok("exitCode" in bad);
});

test("a schema file loads and a same-model fallback is refused", () => {
  const resolved = resolveRequestOptions(reader, options({ outputSchema: "/schema.json" }), SELECTION);

  assert.ok(!("exitCode" in resolved));

  if (!("exitCode" in resolved)) {
    assert.deepEqual(resolved.responseSchema, { type: "object" });
  }

  const refused = resolveRequestOptions(reader, options({ model: "lab-7b", fallbackModel: "lab-7b" }), SELECTION);

  assert.ok("exitCode" in refused);
  const carried = resolveRequestOptions(
    reader,
    options({
      resolvedRequest: {
        systemPrompt: { mode: "append", text: "hi" },
        fallbackModel: "lab-70b",
      },
    }),
    SELECTION,
  );

  assert.deepEqual(carried, {
    systemPrompt: { mode: "append", text: "hi" },
    fallbackModel: "lab-70b",
  });
});
