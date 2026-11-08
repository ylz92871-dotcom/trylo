import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindVerbs, type PortDeps } from "./verbs.js";
import { createFileLedgerStore, ledgerPath } from "../adapters/credentials/file-store.js";
import type { CredentialPort } from "../ports/credentials.js";

/**
 * Two-scope resolution and the environment overlay (WP §2.2, §2.4).
 *
 * The precedence rules are the heart of the WP, so they are tested at the level
 * where the whole stack is real: a file ledger on disk for both scopes and an
 * injected environment. The attacks these cover are #5 (env written to disk) and
 * #7 (a project login copying a user secret into the project file).
 */

const NOW = "2026-09-15T12:00:00.000Z";

type Built = { readonly port: CredentialPort; readonly home: string; readonly project: string };

function build(env: Record<string, string | undefined> = {}): Built {
  const home = mkdtempSync(join(tmpdir(), "trylo-home-"));
  const project = mkdtempSync(join(tmpdir(), "trylo-proj-"));
  const deps: PortDeps = {
    store: createFileLedgerStore({ homeDir: home, projectDir: project }),
    env,
    now: () => NOW,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14)}` },
    hasProject: true,
  };

  return { port: bindVerbs(deps), home, project };
}

function cleanup(built: Built): void {
  rmSync(built.home, { recursive: true, force: true });
  rmSync(built.project, { recursive: true, force: true });
}

function projectFile(project: string): string {
  const located = ledgerPath({ homeDir: project, projectDir: project }, "project");
  return located.ok ? located.path : "";
}

test("project current overrides user current for the same provider", (t) => {
  const built = build();

  t.after(() => cleanup(built));
  const { port } = built;

  assert.equal(port.login({ providerId: "openai-compatible", accountId: "user-a", secret: "sk-user" }).ok, true);
  assert.equal(
    port.login({ providerId: "openai-compatible", accountId: "proj-b", secret: "sk-proj", scope: "project" }).ok,
    true,
  );
  const resolved = port.get("openai-compatible");

  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok ? resolved.value.layer : "", "project");
  assert.equal(resolved.ok ? resolved.value.accountId : "", "proj-b");
  assert.equal(resolved.ok ? resolved.value.secret : "", "sk-proj");
});

test("clearing the project pointer falls back to the user layer", (t) => {
  const built = build();

  t.after(() => cleanup(built));
  const { port } = built;

  assert.equal(port.login({ providerId: "openai-compatible", accountId: "user-a", secret: "sk-user" }).ok, true);
  assert.equal(
    port.login({ providerId: "openai-compatible", accountId: "proj-b", secret: "sk-proj", scope: "project" }).ok,
    true,
  );
  assert.equal(port.logout({ providerId: "openai-compatible", scope: "project" }).ok, true);
  const resolved = port.get("openai-compatible");

  assert.equal(resolved.ok ? resolved.value.layer : "", "user");
  assert.equal(resolved.ok ? resolved.value.secret : "", "sk-user");
});

test("a project login never copies the user secret into the project file (adversarial #7)", (t) => {
  const built = build();

  t.after(() => cleanup(built));
  const { port } = built;

  assert.equal(port.login({ providerId: "openai-compatible", secret: "sk-user-only" }).ok, true);
  assert.equal(
    port.login({ providerId: "openai-compatible", accountId: "proj-1", secret: "sk-proj-only", scope: "project" }).ok,
    true,
  );
  const projectText = readFileSync(projectFile(built.project), "utf8");

  assert.equal(projectText.includes("sk-user-only"), false);
  assert.equal(projectText.includes("sk-proj-only"), true);
});

test("no projectDir configured means the project layer is skipped, not an error", (t) => {
  const home = mkdtempSync(join(tmpdir(), "trylo-home-"));

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const deps: PortDeps = {
    store: createFileLedgerStore({ homeDir: home }),
    env: {},
    now: () => NOW,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
    hasProject: false,
  };
  const port = bindVerbs(deps);

  assert.equal(port.login({ providerId: "openai-compatible", secret: "sk-user" }).ok, true);
  const resolved = port.get("openai-compatible");

  assert.equal(resolved.ok ? resolved.value.layer : "", "user");
  // A project-scoped login has nowhere to go.
  assert.equal(
    port.login({ providerId: "openai-compatible", accountId: "p", secret: "sk-p", scope: "project" }).ok,
    false,
  );
});

test("env overrides both files and reports layer:env", (t) => {
  const built = build({ TRYLO_API_KEY: "sk-from-env" });

  t.after(() => cleanup(built));
  const { port } = built;

  assert.equal(port.login({ providerId: "fixture", accountId: "fx" }).ok, true);
  // The keyed provider is shadowed by env, so storing it is refused...
  assert.equal(port.login({ providerId: "openai-compatible", secret: "sk-file" }).ok, false);
  const resolved = port.get("openai-compatible");

  assert.equal(resolved.ok ? resolved.value.layer : "", "env");
  assert.equal(resolved.ok ? resolved.value.secret : "", "sk-from-env");
});

test("the provider-specific env variable beats the generic one", (t) => {
  const built = build({ TRYLO_API_KEY: "generic", TRYLO_OPENAI_API_KEY: "specific" });
  t.after(() => cleanup(built));
  const resolved = built.port.get("openai-compatible");
  assert.equal(resolved.ok ? resolved.value.secret : "", "specific");
});

test("env never lands on disk (adversarial #5)", (t) => {
  const built = build({ TRYLO_API_KEY: "sk-env-only" });

  t.after(() => cleanup(built));
  const { port } = built;

  // A refused login must not have written a file containing the env value.
  port.login({ providerId: "openai-compatible", secret: "sk-env-only" });
  // A fixture login writes the file; prove the env value is not in it.
  assert.equal(port.login({ providerId: "fixture" }).ok, true);
  const userText = readFileSync(join(built.home, "credentials.json"), "utf8");

  assert.equal(userText.includes("sk-env-only"), false);
});

test("removing the env variable falls back to the file layer", (t) => {
  const home = mkdtempSync(join(tmpdir(), "trylo-home-"));

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = () =>
    bindVerbs({
      store: createFileLedgerStore({ homeDir: home }),
      env: {},
      now: () => NOW,
      crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
      hasProject: false,
    });

  // With no env, store a file credential.
  assert.equal(file().login({ providerId: "openai-compatible", secret: "sk-file" }).ok, true);

  // Now present the env: it wins.
  const withEnv = bindVerbs({
    store: createFileLedgerStore({ homeDir: home }),
    env: { TRYLO_API_KEY: "sk-env" },
    now: () => NOW,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000002" },
    hasProject: false,
  });

  assert.equal(withEnv.get("openai-compatible").ok ? (withEnv.get("openai-compatible") as { value: { layer: string } }).value.layer : "", "env");

  // Remove the env again: the file credential is back.
  const resolved = file().get("openai-compatible");

  assert.equal(resolved.ok ? resolved.value.layer : "", "user");
  assert.equal(resolved.ok ? resolved.value.secret : "", "sk-file");
});
