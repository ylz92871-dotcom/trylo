import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeDocument,
  isKeyedProviderKind,
  PROVIDER_KINDS,
} from "../../adapters/provider/providers-file.js";
import { builtinRegistry, registryOfDocument } from "../../adapters/provider/registry.js";
import { kindNeedsEndpoint, resolveProvider } from "../../adapters/provider/resolver.js";
import { PROVIDER_IDS } from "./args.js";

/**
 * WP18.2 (C68) wiring: `openai-responses` is declarable, keyed, and
 * endpoint-bound — without growing the built-in set the zero-difference
 * gate counts.
 */

test("the Responses wire is a declarable keyed family, not a built-in", () => {
  assert.ok((PROVIDER_KINDS as readonly string[]).includes("openai-responses"));
  assert.ok((PROVIDER_IDS as readonly string[]).includes("openai-responses"));
  assert.ok(isKeyedProviderKind("openai-responses"));
  assert.equal(isKeyedProviderKind("fixture"), false);
  assert.ok(kindNeedsEndpoint("openai-responses"));
  // No new built-in: the default path stays the four shipped ids.
  assert.deepEqual(
    builtinRegistry().entries.map((entry) => entry.id),
    ["fixture", "fixture-write", "fixture-subagent", "openai-compatible"],
  );
});

test("a Responses declaration resolves with its endpoint or is refused", () => {
  const decoded = decodeDocument(
    JSON.stringify({
      version: 1,
      providers: [
        { id: "r1", kind: "openai-responses", endpoint: "https://lab.example/v1/responses", model: "lab-7b" },
      ],
    }),
  );

  assert.equal(decoded.ok, true);

  if (!decoded.ok) {
    return;
  }

  assert.equal(decoded.value.providers[0]?.capabilities.auth, "api_key");
  const registry = registryOfDocument(decoded.value);
  const resolved = resolveProvider({ registry, requested: "r1", endpoint: "", model: "cfg-model" });

  assert.equal(resolved.ok, true);

  if (resolved.ok) {
    assert.equal(resolved.value.kind, "openai-responses");
    assert.equal(resolved.value.endpoint, "https://lab.example/v1/responses");
    assert.equal(resolved.value.model, "lab-7b");
  }

  const missing = resolveProvider({ registry: builtinRegistry(), requested: "openai-responses", endpoint: "", model: "m" });

  assert.equal(missing.ok, false);
});
