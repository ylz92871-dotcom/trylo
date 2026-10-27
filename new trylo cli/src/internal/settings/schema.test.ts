import assert from "node:assert/strict";
import test from "node:test";
import {
  CONCAT_ARRAY_KEYS,
  PACKAGED_DEFAULTS,
  SETTINGS_SCHEMA,
  isConcatKey,
  isMcpForbiddenKey,
  isSchemaKey,
  isSecretKey,
  validateSettingsObject,
} from "./schema.js";

/**
 * The closed schema is the package's first line of defence: a key it does not
 * define, a credential, or an MCP declaration must be refused *by name* before
 * any value is looked at. These tests pin the closed set, the two refusal
 * families, and the per-kind value rules.
 */

test("packaged defaults satisfy the closed schema (no drift between the two)", () => {
  const result = validateSettingsObject(PACKAGED_DEFAULTS, "packaged_default");
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("packaged defaults omit the optional contextTokenLimit", () => {
  assert.equal(Object.hasOwn(PACKAGED_DEFAULTS, "contextTokenLimit"), false);
});

test("the closed set includes model capacity and the allowed run settings", () => {
  assert.deepEqual(Object.keys(SETTINGS_SCHEMA).sort(), [
    "contextTokenLimit",
    "endpoint",
    "format",
    "inputPricePerMTok",
    "lspConfigFile",
    "maxBudgetUsd",
    "maxIterations",
    "maxTokens",
    "model",
    "modelContextWindow",
    "outputPricePerMTok",
    "provider",
    "shell",
  ]);
});

test("shell names a shell and refuses anything else, and is not a packaged default", () => {
  // Three separate claims, so each fails for its own reason rather than as one
  // lump. The third is the load-bearing one: `shell` is a RUN's decision, and a
  // packaged value would put an interpreter in front of every command in a
  // build that never asked for one.
  for (const name of ["bash", "zsh", "sh", "powershell", "cmd"]) {
    const result = validateSettingsObject({ shell: name }, "user");
    assert.equal(result.ok, true, `${name} was refused`);
  }
  for (const bad of ["powershell.exe", "BASH", "", "sh -c", true, 1]) {
    const result = validateSettingsObject({ shell: bad }, "user");
    assert.equal(result.ok, false, `${JSON.stringify(bad)} was accepted`);
  }
  assert.equal(
    Object.hasOwn(PACKAGED_DEFAULTS, "shell"),
    false,
    "a packaged shell would interpret every command in a build that never asked",
  );
});

test("unknown key is refused", () => {
  const result = validateSettingsObject({ autoApprove: true }, "user");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "unknown_key");
  }
});

test("secret keys are refused by exact name and by the 'secret' substring", () => {
  for (const key of ["apiKey", "token", "authorization", "clientSecret", "MY_SECRET"]) {
    const result = validateSettingsObject({ [key]: "x" }, "user");
    assert.equal(result.ok, false, `${key} must be refused`);
    if (!result.ok) {
      assert.equal(result.code, "secret_key", `${key} -> ${result.code}`);
    }
  }
});

test("isSecretKey is case-insensitive on the 'secret' substring", () => {
  assert.equal(isSecretKey("apiKey"), true);
  assert.equal(isSecretKey("Secret"), true);
  assert.equal(isSecretKey("provider"), false);
});

test("MCP declaration keys are refused as forbidden, not as unknown", () => {
  for (const key of ["mcpServers", "mcp", "servers"]) {
    const result = validateSettingsObject({ [key]: {} }, "user");
    assert.equal(result.ok, false, `${key} must be refused`);
    if (!result.ok) {
      assert.equal(result.code, "forbidden_key", `${key} -> ${result.code}`);
    }
  }
  assert.equal(isMcpForbiddenKey("mcpServers"), true);
  assert.equal(isMcpForbiddenKey("model"), false);
});

test("secret refusal wins over unknown-key refusal for a secret-shaped unknown key", () => {
  // `tokenValue` is not in the schema AND contains no exact secret name, but a
  // key literally named `token` does: order matters so the more specific reason
  // is reported.
  const result = validateSettingsObject({ token: "x" }, "user");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "secret_key");
  }
});

test("provider is an open string: declared ids exist, and the resolver judges them", () => {
  assert.equal(validateSettingsObject({ provider: "fixture" }, "user").ok, true);
  assert.equal(validateSettingsObject({ provider: "fixture-write" }, "user").ok, true);
  assert.equal(validateSettingsObject({ provider: "openai-compatible" }, "user").ok, true);
  // `providers add` can declare ids no schema knows; refusing them here is what
  // made `--provider <declared-id>` unusable, so only the type is checked.
  assert.equal(validateSettingsObject({ provider: "myhost" }, "user").ok, true);
  const bad = validateSettingsObject({ provider: 42 }, "user");
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.code, "invalid_value");
  }
});

test("model and endpoint must be strings", () => {
  assert.equal(validateSettingsObject({ model: "gpt-x" }, "user").ok, true);
  assert.equal(validateSettingsObject({ endpoint: "https://e.test" }, "user").ok, true);
  const bad = validateSettingsObject({ model: 42 }, "user");
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.code, "invalid_value");
  }
});

test("format enum accepts text and stream-json only", () => {
  assert.equal(validateSettingsObject({ format: "text" }, "user").ok, true);
  assert.equal(validateSettingsObject({ format: "stream-json" }, "user").ok, true);
  assert.equal(validateSettingsObject({ format: "json" }, "user").ok, false);
});

test("positive-integer keys refuse zero, negatives, fractions and strings", () => {
  for (const value of [0, -1, 1.5, "8", null, true]) {
    const result = validateSettingsObject({ maxIterations: value as never }, "user");
    assert.equal(result.ok, false, `maxIterations=${JSON.stringify(value)} must be refused`);
    if (!result.ok) {
      assert.equal(result.code, "invalid_value");
    }
  }
  assert.equal(validateSettingsObject({ maxIterations: 1 }, "user").ok, true);
  assert.equal(validateSettingsObject({ maxTokens: 4096 }, "user").ok, true);
  assert.equal(validateSettingsObject({ contextTokenLimit: 128000 }, "user").ok, true);
});

test("an empty object is valid and contributes no keys", () => {
  const result = validateSettingsObject({}, "user");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.values, {});
  }
});

test("isSchemaKey reflects the closed set", () => {
  assert.equal(isSchemaKey("model"), true);
  assert.equal(isSchemaKey("formatVersion"), false);
  assert.equal(isSchemaKey("apiKey"), false);
});

test("the schema declares no concat key, but the predicate exists and is total", () => {
  // D6 §10.7 requires the concat mechanism; this package's closed set has no
  // array key, so the set is empty. The mechanism is proven in merge.test.ts.
  assert.equal(CONCAT_ARRAY_KEYS.size, 0);
  for (const key of Object.keys(SETTINGS_SCHEMA)) {
    assert.equal(isConcatKey(key), false);
  }
});

test("lspConfigFile takes a path and is not a packaged default", () => {
  const result = validateSettingsObject({ lspConfigFile: "lsp-servers.json" }, "user");
  assert.equal(result.ok, true, JSON.stringify(result));
  for (const bad of [true, 1, ["a.json"]]) {
    const refused = validateSettingsObject({ lspConfigFile: bad }, "user");
    assert.equal(refused.ok, false, `${JSON.stringify(bad)} was accepted`);
  }
  assert.equal(
    Object.hasOwn(PACKAGED_DEFAULTS, "lspConfigFile"),
    false,
    "a packaged path would start a language server for every user of the build",
  );
});
