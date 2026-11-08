import assert from "node:assert/strict";
import test from "node:test";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { PROVIDERS_DOCUMENT_VERSION } from "../../adapters/provider/providers-file.js";
import type { CliContext } from "./context.js";
import { collectDoctor, type DoctorIo } from "./doctor.js";
import { credentialStateOf } from "./provider-credential.js";

/**
 * The AUTH2 bridge and the doctor row (PW-4).
 *
 * Two claims, both about honesty rather than plumbing:
 *
 *  - **no credential is reported as a credential.** The state a provider is in
 *    when nobody has logged in is `logged_in=false`, printed as such. A command
 *    that said nothing in that case would let silence be read as "configured",
 *    which is the one claim this package must never help anyone make (D5);
 *  - **`doctor` does not grow a row for everyone.** The capability row appears
 *    only when a provider was declared. The zero-difference gate counts
 *    `doctor`'s output, so a machine with no `providers.json` must see exactly
 *    the rows it saw before any of this existed.
 */

function ctxOf(files: Map<string, string>): CliContext {
  return {
    env: {},
    homeDir: "/home/user",
    cwd: "/workspace",
    nodeVersion: "v22.0.0",
    stdinIsTty: false,
    readFile: (path) => files.get(path),
    isDirectory: () => true,
    readDir: () => [],

    writeFile: (path, text) => {
      files.set(path, text);
      return true;
    },

    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: () => {},
    stderr: () => {},
    now: () => 0,
    newId: (prefix) => `${prefix}-1`,
  };
}

function ioOf(files: Map<string, string>): DoctorIo {
  return {
    readFile: (path) => files.get(path),
    isDirectory: () => true,
    readDir: () => [],
    env: {},
    homeDir: "/home/user",
    cwd: "/workspace",
    workspaceRoot: "/workspace",
    nodeVersion: "v22.0.0",
    now: () => 0,
  };
}

const PATH = "/home/user/.trylo/providers.json";

function declared(): string {
  return JSON.stringify({
    version: PROVIDERS_DOCUMENT_VERSION,
    selected: "lab",
    providers: [
      { id: "lab", kind: "openai-compatible", endpoint: "https://lab.example/v1", model: "lab-7b" },
    ],
  });
}

function doctorIds(files: Map<string, string>): ReadonlyArray<string> {
  const report = collectDoctor(ioOf(files), { toolCatalogHash: "h", sessionsDir: "/s" });
  return report.checks.map((check) => check.id);
}

test("an offline provider says it needs no credential", () => {
  const state = credentialStateOf(ctxOf(new Map()), "fixture");
  assert.deepEqual(state, { required: false, note: "fixture is offline and needs no credential" });
});

test("a keyed provider with nothing stored is reported as not logged in", () => {
  const state = credentialStateOf(ctxOf(new Map()), "openai-compatible");
  assert.equal(state.required, true);
  if (state.required && !("unavailable" in state)) {
    assert.equal(state.loggedIn, false);
    assert.equal(state.account, "");
  }
});

test("a ledger that cannot be trusted is reported, not smoothed over", () => {
  const files = new Map([["/home/user/.trylo/credentials.json", "{ broken"]]);
  const state = credentialStateOf(ctxOf(files), "openai-compatible");

  assert.equal(state.required, true);

  if (state.required && "unavailable" in state) {
    assert.match(state.unavailable, /ledger unusable/);
    assert.equal(state.unavailable.includes("sk-"), false);
  }
});

test("the credential state never carries a secret", () => {
  const files = new Map([
    ["/home/user/.trylo/credentials.json", JSON.stringify({ formatVersion: 1, providers: {} })],
  ]);
  const state = credentialStateOf(ctxOf(files), "openai-compatible");
  const text = JSON.stringify(state);

  assert.equal(text.includes("secret"), false);
  assert.equal(text.includes("apiKey"), false);
});

test("doctor on a machine with no declared providers says nothing new", () => {
  const ids = doctorIds(new Map());
  assert.equal(ids.includes("provider.capability"), false);
  assert.equal(ids.includes("provider.selected"), true);
});

test("doctor names the selected provider's capabilities once one is declared", () => {
  const ids = doctorIds(new Map([[PATH, declared()]]));

  assert.equal(ids.includes("provider.capability"), true);
  const report = collectDoctor(ioOf(new Map([[PATH, declared()]])), {
    toolCatalogHash: "h",
    sessionsDir: "/s",
  });
  const row = report.checks.find((check) => check.id === "provider.capability");

  assert.equal(row?.status, "ok");
  assert.match(row?.detail ?? "", /lab: streaming\|tools\|cancellation/);
});

test("a selection that names nothing registered is a failure, not a skip", () => {
  const orphan = JSON.stringify({
    version: PROVIDERS_DOCUMENT_VERSION,
    selected: "gone",
    providers: [],
  });
  const report = collectDoctor(ioOf(new Map([[PATH, orphan]])), {
    toolCatalogHash: "h",
    sessionsDir: "/s",
  });
  const row = report.checks.find((check) => check.id === "provider.capability");

  assert.equal(row?.status, "fail");
  assert.match(row?.detail ?? "", /not registered/);
});

test("a providers file that cannot be read is a CONFIG failure in the doctor", () => {
  const report = collectDoctor(ioOf(new Map([[PATH, "{ broken"]])), {
    toolCatalogHash: "h",
    sessionsDir: "/s",
  });
  const row = report.checks.find((check) => check.id === "provider.capability");

  assert.equal(row?.status, "fail");
  assert.match(row?.detail ?? "", /not_json/);
  assert.equal(report.checks.some((check) => check.status === "fail"), true);
});

test("a failing doctor row is worth a non-zero exit", () => {
  const report = collectDoctor(ioOf(new Map([[PATH, "{ broken"]])), {
    toolCatalogHash: "h",
    sessionsDir: "/s",
  });
  assert.equal(report.checks.some((check) => check.status === "fail"), true);
  assert.equal(EXIT_CODES.CONFIG, 52);
});
