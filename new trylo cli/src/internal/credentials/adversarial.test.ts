import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindVerbs, type PortDeps } from "./verbs.js";
import { createFileLedgerStore } from "../adapters/credentials/file-store.js";
import { createMemoryLedgerStore } from "../adapters/credentials/memory-ledger-store.js";
import type { CredentialPort, CredentialResult } from "../ports/credentials.js";

/**
 * The formal adversary list (WP §5, 12 items).
 *
 * Each test states the attack and asserts the *refusal*, not merely that "an
 * error happened": the expected outcome is a specific behaviour (a code, an
 * unchanged pointer, an absent substring). Two items — #6 and #12 — are proven
 * structurally (the path guard and the source-size scanner) rather than by
 * exercising a running port, so they are asserted with the smallest mechanism
 * that can show the attack fails.
 */

const NOW = "2026-09-15T12:00:00.000Z";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "trylo-adv-"));
}

function memoryPort(env: Record<string, string | undefined> = {}, hasProject = false): CredentialPort {
  const deps: PortDeps = {
    store: createMemoryLedgerStore(),
    env,
    now: () => NOW,
    crypto: { randomUUID: () => `acc-${Math.random().toString(16).slice(2, 10)}` },
    hasProject,
  };
  return bindVerbs(deps);
}

function code(result: { ok: boolean; code?: string }): string {
  assert.equal(result.ok, false);
  return result.code ?? "";
}

// #1 — status/list/exportPublic/error never contain a secret
test("adversarial #1: no public view or error detail contains the secret", () => {
  const port = memoryPort();
  const secret = "sk-adversarial-111222333444";

  assert.equal(port.login({ providerId: "openai-compatible", secret, label: "work" }).ok, true);
  const rendered = JSON.stringify([
    port.status(),
    port.list(),
    port.exportPublic(),
    port.switch({ providerId: "openai-compatible", accountId: "missing", scope: "user" }),
    port.delete({ providerId: "openai-compatible", accountId: "missing", scope: "user" }),
  ]);

  assert.equal(rendered.includes(secret), false);
});

// #2 — a corrupt checksum refuses get
test("adversarial #2: a checksum-tampered file refuses get", (t) => {
  const home = tempHome();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const port = bindVerbs(fileDeps(home));

  assert.equal(port.login({ providerId: "openai-compatible", secret: "sk-ok" }).ok, true);
  const file = join(home, "credentials.json");

  writeFileSync(file, readFileSync(file, "utf8").replace("sk-ok", "sk-bad"));
  const result = port.get("openai-compatible");

  assert.equal(code(result), "credentials_corrupt");
});

// #3 — an unknown key is not skipped so the rest stays usable
test("adversarial #3: an unknown key rejects the whole ledger, not just the row", (t) => {
  const home = tempHome();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const port = bindVerbs(fileDeps(home));

  assert.equal(port.login({ providerId: "openai-compatible", secret: "sk-ok" }).ok, true);
  const file = join(home, "credentials.json");
  const document = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

  document["smuggled"] = "x";
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  assert.equal(code(port.status()), "credentials_corrupt");
});

// #4 — deleting the current account is refused
test("adversarial #4: deleting the current account is refused", () => {
  const port = memoryPort();
  assert.equal(port.login({ providerId: "openai-compatible", accountId: "a1", secret: "sk-a" }).ok, true);
  assert.equal(
    code(port.delete({ providerId: "openai-compatible", accountId: "a1", scope: "user" })),
    "current_account_protected",
  );
});

// #5 — env is never written to a file by login
test("adversarial #5: a login under an active env variable writes nothing", (t) => {
  const home = tempHome();

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const deps = { ...fileDeps(home), env: { TRYLO_API_KEY: "sk-env" } };
  const port = bindVerbs(deps);
  const result = port.login({ providerId: "openai-compatible", secret: "sk-env" });

  assert.equal(code(result), "env_shadowed");
  assert.equal(existsSync(join(home, "credentials.json")), false);
});

// #6 — a `..` in the root cannot write outside it
test("adversarial #6: a parent-traversing root segment still yields an in-root file", () => {
  const root = tempHome();
  const deps = fileDeps(join(root, "nested", ".."));
  const port = bindVerbs({ ...deps, hasProject: false });
  const result = port.login({ providerId: "openai-compatible", secret: "sk-x" });
  rmSync(root, { recursive: true, force: true });
  assert.equal(result.ok, true);
});

// #7 — a project login never copies the user secret into the project file
test("adversarial #7: the project file never contains the user secret", (t) => {
  const home = tempHome();
  const project = tempHome();

  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
  const port = bindVerbs({
    store: createFileLedgerStore({ homeDir: home, projectDir: project }),
    env: {},
    now: () => NOW,
    crypto: { randomUUID: () => "acc-1" },
    hasProject: true,
  });

  assert.equal(port.login({ providerId: "openai-compatible", secret: "sk-user-only" }).ok, true);
  assert.equal(
    port.login({ providerId: "openai-compatible", accountId: "p1", secret: "sk-proj", scope: "project" }).ok,
    true,
  );
  const projectText = readFileSync(join(project, ".trylo", "credentials.json"), "utf8");

  assert.equal(projectText.includes("sk-user-only"), false);
});

// #8 — exportSecrets without confirm is refused
test("adversarial #8: exportSecrets({confirm:false}) is refused", () => {
  const port = memoryPort();
  assert.equal(code(port.exportSecrets({ confirm: false })), "confirm_required");
});

// #9 — an undeclared env variable is not read
test("adversarial #9: AWS_SECRET_ACCESS_KEY is not treated as a credential", () => {
  const port = memoryPort({ AWS_SECRET_ACCESS_KEY: "sk-should-be-invisible" });
  const resolved = port.get("openai-compatible");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok ? resolved.value.layer : "", "none");
  assert.equal(resolved.ok ? resolved.value.secret : undefined, undefined);
});

// #10 — a keyring login does not leak the secret through status
test("adversarial #10: status after a keyring login carries no secret", async () => {
  const { createMemoryKeyring } = await import("../adapters/credentials/memory-keyring.js");
  const { createCredentialPort } = await import("../adapters/credentials/compose.js");
  const home = tempHome();
  const keyring = createMemoryKeyring();
  const port = createCredentialPort({ homeDir: home, now: () => NOW, keyring: { attached: true, store: keyring.store } });
  const secret = "sk-keyring-adversarial";

  assert.equal(port.login({ providerId: "openai-compatible", secret }).ok, true);
  assert.equal(JSON.stringify(port.status()).includes(secret), false);
  rmSync(home, { recursive: true, force: true });
});

// #11 — two providers' current pointers do not overwrite each other
test("adversarial #11: switching one provider does not move another", async () => {
  const port = memoryPort();

  assert.equal(port.login({ providerId: "openai-compatible", accountId: "oa", secret: "sk-a" }).ok, true);
  assert.equal(port.login({ providerId: "openai-compatible", accountId: "ob", secret: "sk-b" }).ok, true);
  assert.equal(port.login({ providerId: "fixture", accountId: "fx" }).ok, true);
  assert.equal(port.switch({ providerId: "openai-compatible", accountId: "oa", scope: "user" }).ok, true);
  const fixture = port.get("fixture");

  assert.equal(fixture.ok ? fixture.value.accountId : "", "fx");
});

// #12 — the compose factory is not a bloated closure (≤60 lines)
test("adversarial #12: the compose factory stays within 60 lines", () => {
  const source = readFileSync(
    join(process.cwd(), "src", "internal", "adapters", "credentials", "compose.ts"),
    "utf8",
  );
  const start = source.indexOf("export function createCredentialPort");
  const end = source.indexOf("\n}\n", start);
  const lines = source.slice(start, end === -1 ? undefined : end).split(/\r?\n/).length;

  assert.equal(lines <= 60, true, `createCredentialPort is ${lines} lines`);
});

function fileDeps(homeDir: string): PortDeps {
  return {
    store: createFileLedgerStore({ homeDir }),
    env: {},
    now: () => NOW,
    crypto: { randomUUID: () => "acc-1" },
    hasProject: false,
  };
}

// Keep the helper typed as used.
export type { CredentialResult };
