import assert from "node:assert/strict";
import test from "node:test";
import {
  builtinRegistry,
  demandCapability,
  findProvider,
  readRegistry,
  registryOfDocument,
  requireProvider,
  selectProvider,
  DEFAULT_PROVIDER_ID,
} from "./registry.js";
import {
  resolveProvider,
  resolveRequiring,
  resolverForBudget,
  withSelected,
  type ResolveInput,
} from "./resolver.js";
import { PROVIDERS_DOCUMENT_VERSION, type ProvidersDocument } from "./providers-file.js";

/**
 * Two claims are being proved here.
 *
 * The first is the gate: with no declared-providers file, selection and
 * resolution behave exactly as they did before this package existed — same
 * default, same four ids, and an endpoint that still fails when it is missing.
 *
 * The second is the point of the package: with declarations in play, an unknown
 * id is refused with the list of known ones, an undeclared capability is
 * refused rather than granted, and a resolved provider is one object whose
 * endpoint, model and capabilities came from the same entry.
 */

function ioWith(text: string | undefined) {
  return { readFile: () => text, providersFile: "/home/.trylo/providers.json" };
}

const DECLARED: ProvidersDocument = {
  version: PROVIDERS_DOCUMENT_VERSION,
  providers: [
    {
      id: "lab",
      kind: "openai-compatible",
      endpoint: "https://lab.example/v1",
      model: "lab-7b",
      capabilities: {
        models: ["lab-7b", "lab-70b"],
        streaming: true,
        reasoning: false,
        tools: true,
        cancellation: true,
        auth: "api_key",
        endpoint: "https://lab.example/v1",
      },
    },
  ],
};

function input(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    registry: builtinRegistry(),
    endpoint: "",
    model: "default",
    ...overrides,
  };
}

test("every shipped provider declares itself", () => {
  const registry = builtinRegistry();

  assert.deepEqual(
    registry.entries.map((entry) => entry.id),
    ["fixture", "fixture-write", "fixture-subagent", "openai-compatible"],
  );

  for (const entry of registry.entries) {
    assert.equal(entry.builtin, true);
    assert.equal(typeof entry.capabilities.auth, "string");
  }

  // No shipped provider claims a reasoning channel it does not translate.
  assert.equal(registry.entries.some((entry) => entry.capabilities.reasoning), false);
});

test("openai-compatible declares no models rather than inventing a catalogue", () => {
  const entry = findProvider(builtinRegistry(), "openai-compatible");
  assert.deepEqual(entry?.capabilities.models, []);
  assert.equal(entry?.capabilities.auth, "api_key");
});

test("a missing file is the default state, not an error", () => {
  const registry = readRegistry(ioWith(undefined));

  assert.equal("entries" in registry, true);

  if (!("entries" in registry)) {
    return;
  }

  assert.equal(registry.declared, false);
  assert.equal(registry.selected, undefined);
  const selected = selectProvider(registry);

  assert.equal(selected.ok && selected.entry.id, DEFAULT_PROVIDER_ID);
});

test("a file that cannot be trusted is refused whole", () => {
  const registry = readRegistry(ioWith("{ not json"));
  assert.equal("code" in registry, true);
  if ("code" in registry) {
    assert.equal(registry.code, "not_json");
  }
});

test("declared providers are added without disturbing the built-ins", () => {
  const registry = registryOfDocument(DECLARED);
  assert.equal(registry.declared, true);
  assert.equal(registry.entries.length, 5);
  assert.equal(findProvider(registry, "lab")?.kind, "openai-compatible");
  assert.equal(findProvider(registry, "fixture")?.builtin, true);
});

test("an unknown provider is refused with the list of known ones", () => {
  const denial = requireProvider(builtinRegistry(), "claude");

  assert.equal(denial.ok, false);

  if (denial.ok) {
    return;
  }

  assert.equal(denial.denial.code, "unknown_provider");
  assert.deepEqual(denial.denial.known, [
    "fixture",
    "fixture-write",
    "fixture-subagent",
    "openai-compatible",
  ]);
});

test("selection precedence: requested, then the document, then the default", () => {
  const registry = registryOfDocument({ ...DECLARED, selected: "lab" });
  const byFlag = selectProvider(registry, "fixture-write");

  assert.equal(byFlag.ok && byFlag.entry.id, "fixture-write");
  const byDocument = selectProvider(registry);

  assert.equal(byDocument.ok && byDocument.entry.id, "lab");
  const byDefault = selectProvider(builtinRegistry());

  assert.equal(byDefault.ok && byDefault.entry.id, "fixture");
});

test("a keyed provider with no endpoint is refused, not half-built", () => {
  const resolved = resolveProvider(input({ requested: "openai-compatible" }));

  assert.equal(resolved.ok, false);

  if (resolved.ok) {
    return;
  }

  assert.equal(resolved.failure.kind, "endpoint");
  assert.match(
    resolved.failure.kind === "endpoint" ? resolved.failure.detail : "",
    /needs an endpoint/,
  );
});

test("a resolved provider is one object: endpoint, model and caps from one entry", () => {
  const resolved = resolveProvider(input({ registry: registryOfDocument(DECLARED), requested: "lab" }));

  assert.equal(resolved.ok, true);

  if (!resolved.ok) {
    return;
  }

  assert.equal(resolved.value.providerId, "lab");
  assert.equal(resolved.value.kind, "openai-compatible");
  assert.equal(resolved.value.endpoint, "https://lab.example/v1");
  assert.equal(resolved.value.model, "lab-7b");
  assert.equal(resolved.value.builtin, false);
});

test("an explicit --endpoint / --model wins over the declaration", () => {
  const resolved = resolveProvider(
    input({
      registry: registryOfDocument(DECLARED),
      requested: "lab",
      endpointOverride: "https://other.example/v1",
      modelOverride: "other-1",
    }),
  );

  assert.equal(resolved.ok, true);

  if (!resolved.ok) {
    return;
  }

  assert.equal(resolved.value.endpoint, "https://other.example/v1");
  assert.equal(resolved.value.model, "other-1");
});

test("with no declaration the run's own endpoint and model survive", () => {
  const resolved = resolveProvider(
    input({ requested: "openai-compatible", endpoint: "https://cfg.example/v1", model: "cfg-model" }),
  );

  assert.equal(resolved.ok, true);

  if (!resolved.ok) {
    return;
  }

  assert.equal(resolved.value.endpoint, "https://cfg.example/v1");
  assert.equal(resolved.value.model, "cfg-model");
});

test("resolution can demand a capability, and says which refusal it hit", () => {
  const missing = resolveRequiring(
    input({ registry: registryOfDocument(DECLARED), requested: "lab" }),
    "reasoning",
  );

  assert.equal(missing.ok, false);

  if (!missing.ok) {
    assert.equal(missing.failure.kind, "capability");
  }

  const unknown = resolveRequiring(input({ requested: "nope" }), "streaming");

  assert.equal(unknown.ok, false);

  if (!unknown.ok) {
    assert.equal(unknown.failure.kind, "provider");
  }

  const granted = resolveRequiring(
    input({ registry: registryOfDocument(DECLARED), requested: "lab" }),
    "tools",
  );

  assert.equal(granted.ok, true);
});

test("the registry answers a capability question without resolving a run", () => {
  const registry = registryOfDocument(DECLARED);

  assert.deepEqual(demandCapability(registry, "lab", "streaming"), { ok: true });
  const denied = demandCapability(registry, "lab", "reasoning");

  assert.equal(denied.ok, false);
  const unknown = demandCapability(registry, "nope", "streaming");

  assert.equal(unknown.ok, false);

  if (!unknown.ok) {
    assert.equal(unknown.denial.code === "unknown_provider" ? unknown.denial.id : "", "nope");
  }
});

test("a declared context window becomes the ceiling unless configured otherwise", () => {
  // D7 BYOK（对照 opencode overflow.ts：已知 limit 默认自动压缩、未知才关）。
  // 旧合同"只展示不激活"已随本修复替代：声明即 asking，未声明仍全关。
  const registry = registryOfDocument({
    ...DECLARED,
    providers: [
      {
        ...DECLARED.providers[0]!,
        capabilities: { ...DECLARED.providers[0]!.capabilities, contextWindow: 200000 },
      },
    ],
  });
  const resolved = resolveProvider(input({ registry, requested: "lab" }));

  assert.equal(resolved.ok, true);

  if (!resolved.ok) {
    return;
  }

  assert.equal(resolved.value.contextWindow, 200000);
  // No configured ceiling: the declared window is the ceiling.
  assert.deepEqual(resolverForBudget(resolved.value, undefined), {
    declared: 200000,
    effective: 200000,
    overridden: false,
  });
  // A configured ceiling wins, and a mismatch is reported rather than resolved.
  assert.deepEqual(resolverForBudget(resolved.value, 32000), {
    declared: 200000,
    effective: 32000,
    overridden: true,
  });
});

test("switching rewrites the whole document, not one key", () => {
  const next = withSelected(DECLARED, "lab");

  assert.equal(next.selected, "lab");
  assert.deepEqual(next.providers, DECLARED.providers);
  assert.equal(next.version, PROVIDERS_DOCUMENT_VERSION);
  assert.equal(selectProvider(registryOfDocument(next)).ok, true);
  const selected = selectProvider(registryOfDocument(next));

  assert.equal(selected.ok ? selected.entry.id : "", "lab");
});
