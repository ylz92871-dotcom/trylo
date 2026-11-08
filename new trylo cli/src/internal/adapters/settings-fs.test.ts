import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { SettingsIo, SettingsLoadRequest } from "../ports/settings.js";
import {
  PROJECT_CONFIG_RELATIVE,
  SYSTEM_CONFIG_RELATIVE,
  USER_CONFIG_RELATIVE,
} from "../settings/discover.js";
import { createSettingsLoader } from "./settings-fs.js";

/**
 * End-to-end loader behaviour over an injected in-memory filesystem, plus one
 * run over real `node:fs` against `testdata/settings/fs/**` to prove the disk
 * path without touching a real home directory. This is where the adversarial
 * list is exercised as *load outcomes*: an invalid layer fails the whole load,
 * a missing layer falls through to packaged, and cli_flag wins.
 */

const HOME = "/home/u";
const WORKSPACE = "/ws";
const SYSTEM = "/etc/trylo";

const userFile = path.join(HOME, USER_CONFIG_RELATIVE);
const projectFile = path.join(WORKSPACE, PROJECT_CONFIG_RELATIVE);
const systemFile = path.join(SYSTEM, SYSTEM_CONFIG_RELATIVE);

function fakeFs(files: Record<string, string>): SettingsIo {
  return { readFile: (p: string): string | undefined => files[p] };
}

function baseRequest(overrides: Partial<SettingsLoadRequest> = {}): SettingsLoadRequest {
  return { systemDir: SYSTEM, homeDir: HOME, workspaceDir: WORKSPACE, ...overrides };
}

test("five layers resolve with correct precedence and layer attribution", () => {
  const loader = createSettingsLoader(
    fakeFs({
      [systemFile]: JSON.stringify({ provider: "openai-compatible", endpoint: "https://sys.test" }),
      [userFile]: JSON.stringify({ model: "user-model", maxTokens: 2048 }),
      [projectFile]: JSON.stringify({ model: "project-model" }),
    }),
  );
  const result = loader.load(baseRequest({ cliFlag: { maxTokens: 512 } }));

  assert.equal(result.ok, true, JSON.stringify(result));

  if (!result.ok) {
    return;
  }

  const view = loader.publicView(result.value);

  assert.deepEqual(view["provider"], { value: "openai-compatible", layer: "system" });
  assert.deepEqual(view["endpoint"], { value: "https://sys.test", layer: "system" });
  assert.deepEqual(view["model"], { value: "project-model", layer: "project" });
  assert.deepEqual(view["maxTokens"], { value: 512, layer: "cli_flag" });
  // packaged defaults survive where nothing overrode them
  assert.deepEqual(view["format"], { value: "text", layer: "packaged_default" });
  assert.equal(view["maxIterations"], undefined);
});

test("adversarial #8: a missing user file still succeeds and falls through to packaged", () => {
  const loader = createSettingsLoader(fakeFs({})); // no files at all
  const result = loader.load(baseRequest());

  assert.equal(result.ok, true, JSON.stringify(result));

  if (!result.ok) {
    return;
  }

  const view = loader.publicView(result.value);

  assert.deepEqual(view["provider"], { value: "fixture", layer: "packaged_default" });
  assert.equal(view["model"], undefined); // no layer supplied a model
});

test("adversarial #7: cli_flag overrides the user model and the view says so", () => {
  const loader = createSettingsLoader(fakeFs({ [userFile]: JSON.stringify({ model: "user-model" }) }));
  const result = loader.load(baseRequest({ cliFlag: { model: "flag-model" } }));

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  assert.deepEqual(loader.publicView(result.value)["model"], {
    value: "flag-model",
    layer: "cli_flag",
  });
});

test("adversarial #1: an unknown key fails the whole load", () => {
  const loader = createSettingsLoader(fakeFs({ [userFile]: '{"nope":1}' }));
  const result = loader.load(baseRequest());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "unknown_key");
  }
});

test("adversarial #2: apiKey in the user file fails; no resolved config exists", () => {
  const loader = createSettingsLoader(fakeFs({ [userFile]: '{"apiKey":"sk-FAKE-not-real"}' }));
  const result = loader.load(baseRequest());

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.code, "secret_key");
    assert.equal("value" in result, false);
  }
});

test("adversarial #3: mcpServers in the project file fails", () => {
  const loader = createSettingsLoader(fakeFs({ [projectFile]: '{"mcpServers":{}}' }));
  const result = loader.load(baseRequest());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "forbidden_key");
  }
});

test("adversarial #4: formatVersion 2 fails", () => {
  const loader = createSettingsLoader(fakeFs({ [userFile]: '{"formatVersion":2}' }));
  const result = loader.load(baseRequest());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "unknown_format_version");
  }
});

test("adversarial #5: malformed JSON is invalid, not silently missing", () => {
  const loader = createSettingsLoader(fakeFs({ [userFile]: "{broken" }));
  const result = loader.load(baseRequest());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "invalid_json");
  }
});

test("fail-closed: one invalid layer fails the load even when other layers are valid", () => {
  const loader = createSettingsLoader(
    fakeFs({
      [systemFile]: JSON.stringify({ provider: "fixture" }),
      [userFile]: JSON.stringify({ model: "good" }),
      [projectFile]: '{"bad":1}', // invalid project layer
    }),
  );
  const result = loader.load(baseRequest());

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.code, "unknown_key");
  }
});

test("an invalid cli_flag object fails the load (flags are schema-checked too)", () => {
  const loader = createSettingsLoader(fakeFs({}));
  const result = loader.load(baseRequest({ cliFlag: { token: "x" } }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "secret_key");
  }
});

test("a readFile throw is read_failed, distinct from missing", () => {
  const loader = createSettingsLoader({
    readFile: (p: string): string | undefined => {
      if (p === userFile) {
        throw new Error("EACCES");
      }
      return undefined;
    },
  });
  const result = loader.load(baseRequest());

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.code, "read_failed");
  }
});

test("no systemDir: the system layer is simply absent, load still succeeds", () => {
  const loader = createSettingsLoader(fakeFs({ [userFile]: JSON.stringify({ model: "m" }) }));
  const result = loader.load({ homeDir: HOME, workspaceDir: WORKSPACE });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(loader.publicView(result.value)["model"], { value: "m", layer: "user" });
  }
});

test("real node:fs against testdata/settings/fs proves the disk path and five-layer precedence", () => {
  const fixtureRoot = path.join(process.cwd(), "testdata", "settings", "fs");
  const io: SettingsIo = {
    readFile: (p: string): string | undefined => (existsSync(p) ? readFileSync(p, "utf8") : undefined),
  };
  const loader = createSettingsLoader(io);
  const result = loader.load({
    systemDir: path.join(fixtureRoot, "system"),
    homeDir: path.join(fixtureRoot, "home"),
    workspaceDir: path.join(fixtureRoot, "workspace"),
  });

  assert.equal(result.ok, true, JSON.stringify(result));

  if (!result.ok) {
    return;
  }

  const view = loader.publicView(result.value);

  assert.deepEqual(view["provider"], { value: "openai-compatible", layer: "system" });
  assert.deepEqual(view["endpoint"], { value: "https://example.test/v1", layer: "system" });
  assert.deepEqual(view["model"], { value: "project-model", layer: "project" });
  assert.deepEqual(view["maxTokens"], { value: 2048, layer: "user" });
  assert.deepEqual(view["format"], { value: "text", layer: "packaged_default" });
});
