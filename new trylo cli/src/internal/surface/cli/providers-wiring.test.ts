import assert from "node:assert/strict";
import test from "node:test";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { PROVIDER_KINDS } from "../../adapters/provider/providers-file.js";
import { PROVIDER_IDS } from "./args.js";
import type { ProvidersWiringContext } from "./providers-wiring.js";
import {
  isDocumentFailure,
  PROVIDERS_FILE_NAME,
  providersFilePath,
  readCliProviderRegistry,
  resolveRunProvider,
  switchFailureExit,
  switchSelected,
} from "./providers-wiring.js";

/**
 * The wiring layer: where the file is, and what each refusal costs.
 *
 * The first case is the drift guard. `PROVIDER_KINDS` (adapters) and
 * `PROVIDER_IDS` (the CLI's `--provider` vocabulary) are the same list kept in
 * two layers on purpose — the adapters layer must not import from `surface/**`
 * — and an unchecked duplicate is a duplicate that will eventually disagree.
 *
 * The rest are the switch's three ways of failing and its one way of
 * succeeding, plus the proof that a switch is visible to the very next read.
 */

type Files = Map<string, string>;

function ctxOf(files: Files, writable = true): ProvidersWiringContext & { readonly files: Files } {
  return {
    files,
    homeDir: "/home/user",
    env: {},
    readFile: (path) => files.get(path),

    writeFile: (path, text) => {
      if (!writable) {
        return false;
      }
      files.set(path, text);
      return true;
    },
  };
}

const PATH = "/home/user/.trylo/providers.json";

function declaredFile(): string {
  return JSON.stringify({
    version: 1,
    providers: [
      { id: "lab", kind: "openai-compatible", endpoint: "https://lab.example/v1", model: "lab-7b" },
    ],
  });
}

test("the kinds a declaration may name are the ids the CLI accepts", () => {
  assert.deepEqual([...PROVIDER_KINDS].sort(), [...PROVIDER_IDS].sort());
});

test("the file sits in the profile, not in the workspace", () => {
  const ctx = ctxOf(new Map());
  assert.equal(providersFilePath(ctx), `/home/user/.trylo/${PROVIDERS_FILE_NAME}`);
  const moved = { ...ctx, env: { TRYLO_HOME: "/elsewhere/trylo" } };
  assert.equal(providersFilePath(moved), `/elsewhere/trylo/${PROVIDERS_FILE_NAME}`);
});

test("no file means the built-ins, and that is not an error", () => {
  const registry = readCliProviderRegistry(ctxOf(new Map()));

  assert.equal(isDocumentFailure(registry), false);

  if (isDocumentFailure(registry)) {
    return;
  }

  assert.equal(registry.declared, false);
  assert.equal(registry.entries.length, 4);
});

test("switching to an unknown provider writes nothing and leaves 2", () => {
  const ctx = ctxOf(new Map());
  const result = switchSelected(ctx, { id: "lab" });

  assert.equal(result.ok, false);

  if (result.ok) {
    return;
  }

  assert.equal(result.code, "unknown_provider");
  // The known ids are the registry's entries (the four built-ins on an empty
  // machine), not the kind vocabulary: `openai-responses` names a wire a
  // declaration may use, not an id a run can select without one (WP18.2).
  assert.deepEqual(result.known, [
    "fixture",
    "fixture-write",
    "fixture-subagent",
    "openai-compatible",
  ]);
  assert.equal(switchFailureExit(result), EXIT_CODES.USAGE);
  assert.equal(ctx.files.size, 0);
});

test("a declared Responses wire id switches like any declared id", () => {
  const ctx = ctxOf(
    new Map([
      [
        PATH,
        JSON.stringify({
          version: 1,
          providers: [
            { id: "r1", kind: "openai-responses", endpoint: "https://lab.example/v1/responses", model: "lab-7b" },
          ],
        }),
      ],
    ]),
  );
  const result = switchSelected(ctx, { id: "r1" });

  assert.deepEqual(result, { ok: true, id: "r1", created: false });
});

test("switching to a built-in provider creates the document once", () => {
  const ctx = ctxOf(new Map());
  const result = switchSelected(ctx, { id: "fixture-write" });
  assert.deepEqual(result, { ok: true, id: "fixture-write", created: true });
  const written = ctx.files.get(PATH);
  assert.equal(written !== undefined, true);
});

test("a switch is visible to the next read, as one complete document", () => {
  const ctx = ctxOf(new Map([[PATH, declaredFile()]]));
  const result = switchSelected(ctx, { id: "lab" });

  assert.deepEqual(result, { ok: true, id: "lab", created: false });
  const registry = readCliProviderRegistry(ctx);

  assert.equal(isDocumentFailure(registry), false);

  if (isDocumentFailure(registry)) {
    return;
  }

  assert.equal(registry.selected, "lab");
  assert.equal(registry.entries.length, 5);
  // The declaration survived the rewrite: the document was replaced whole, not
  // patched around.
  const resolved = resolveRunProvider(ctx, { endpoint: "", model: "default" });

  assert.equal(resolved.ok, true);

  if (!resolved.ok) {
    return;
  }

  assert.equal(resolved.value.providerId, "lab");
  assert.equal(resolved.value.endpoint, "https://lab.example/v1");
});

test("an explicit request beats the stored selection", () => {
  const ctx = ctxOf(new Map([[PATH, `${JSON.stringify({ version: 1, selected: "lab", providers: [
    { id: "lab", kind: "openai-compatible", endpoint: "https://lab.example/v1" },
  ] })}`]]));
  const resolved = resolveRunProvider(ctx, { requested: "fixture", endpoint: "", model: "default" });

  assert.equal(resolved.ok, true);

  if (!resolved.ok) {
    return;
  }

  assert.equal(resolved.value.providerId, "fixture");
});

test("a file that cannot be decoded is refused with CONFIG", () => {
  const ctx = ctxOf(new Map([[PATH, "{ not json"]]));
  const registry = readCliProviderRegistry(ctx);

  assert.equal(isDocumentFailure(registry), true);

  if (isDocumentFailure(registry)) {
    assert.equal(registry.code, "not_json");
  }

  const resolved = resolveRunProvider(ctx, { endpoint: "", model: "default" });

  assert.equal(resolved.ok, false);

  if (!resolved.ok && "code" in resolved.failure) {
    assert.equal(resolved.failure.code, "not_json");
  }
});

test("a failed write is a failure, not a silent success", () => {
  const ctx = ctxOf(new Map(), false);
  const result = switchSelected(ctx, { id: "fixture" });

  assert.equal(result.ok, false);

  if (result.ok) {
    return;
  }

  assert.equal(result.code, "write_failed");
  assert.equal(switchFailureExit(result), EXIT_CODES.EXECUTION_FAILURE);
});

test("a keyed selection with nowhere to send a request is refused", () => {
  const ctx = ctxOf(new Map());
  const resolved = resolveRunProvider(ctx, { requested: "openai-compatible", endpoint: "", model: "m" });
  assert.equal(resolved.ok, false);
  if (!resolved.ok && !("code" in resolved.failure)) {
    assert.equal(resolved.failure.kind, "endpoint");
  }
});
