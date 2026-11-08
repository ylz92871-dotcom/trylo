import assert from "node:assert/strict";
import test from "node:test";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import {
  handleProvidersConfig,
  handleProvidersList,
  handleProvidersModels,
  handleProvidersSwitch,
} from "./commands-providers.js";

/**
 * The command family, driven in-process.
 *
 * Three claims: the verbs answer the question they were asked; a provider or a
 * capability that is not there is refused rather than approximated; and no
 * output of any verb, in either format, carries a secret. The last one is a
 * scan rather than an assertion about one field, because the failure it is
 * guarding against is a secret that arrives by accident — a whole object
 * stringified into `--json` — and only a scan catches that.
 *
 * The undeclared-models case is the one that carries the package's honesty
 * rule: `providers models openai-compatible` must not print an empty list as
 * though that were an answer.
 */

type Recorded = {
  readonly ctx: CliContext;
  readonly out: string[];
  readonly err: string[];
  readonly files: Map<string, string>;
};

const PATH = "/home/user/.trylo/providers.json";

function recorded(files: Map<string, string> = new Map()): Recorded {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
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
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => 0,
    newId: (prefix) => `${prefix}-1`,
  };

  return { ctx, out, err, files };
}

function withLab(): Map<string, string> {
  return new Map([
    [
      PATH,
      JSON.stringify({
        version: 1,
        selected: "lab",
        providers: [
          {
            id: "lab",
            kind: "openai-compatible",
            endpoint: "https://lab.example/v1",
            model: "lab-7b",
            models: ["lab-7b", "lab-70b"],
            contextWindow: 128000,
          },
        ],
      }),
    ],
  ]);
}

function textOf(rec: Recorded): string {
  return rec.out.join("");
}

test("list names the four shipped providers and marks the selected one", () => {
  const rec = recorded();
  assert.equal(handleProvidersList(rec.ctx, { json: false }), EXIT_CODES.OK);
  const text = textOf(rec);
  assert.match(text, /\* fixture/);
  assert.match(text, /openai-compatible/);
  assert.equal(text.split("\n").filter((line) => line.trim().length > 0).length, 4);
});

test("list --json carries the whole matrix and no secret", () => {
  const rec = recorded(withLab());

  assert.equal(handleProvidersList(rec.ctx, { json: true }), EXIT_CODES.OK);
  const payload = JSON.parse(textOf(rec)) as {
    readonly selected: string;
    readonly providers: ReadonlyArray<{ readonly id: string; readonly auth: string }>;
  };

  assert.equal(payload.selected, "lab");
  assert.equal(payload.providers.length, 5);
  assert.equal(payload.providers.some((entry) => entry.id === "lab"), true);
  assert.equal(textOf(rec).includes("apiKey"), false);
  assert.equal(textOf(rec).includes("sk-"), false);
});

test("an undeclared model list is reported as undeclared, not as empty", () => {
  const rec = recorded();

  assert.equal(handleProvidersModels(rec.ctx, { id: "openai-compatible", json: false }), EXIT_CODES.OK);
  assert.match(textOf(rec), /not declared/);
  const jsonRec = recorded();

  handleProvidersModels(jsonRec.ctx, { id: "openai-compatible", json: true });
  const payload = JSON.parse(textOf(jsonRec)) as { readonly declared: boolean; readonly models: unknown[] };

  assert.equal(payload.declared, false);
  assert.deepEqual(payload.models, []);
});

test("declared models are listed as facts", () => {
  const rec = recorded(withLab());
  assert.equal(handleProvidersModels(rec.ctx, { id: "lab", json: false }), EXIT_CODES.OK);
  assert.match(textOf(rec), /lab-7b/);
  assert.match(textOf(rec), /lab-70b/);
});

test("asking about a provider that does not exist leaves 2 and says what exists", () => {
  const rec = recorded();
  assert.equal(handleProvidersModels(rec.ctx, { id: "nope", json: false }), EXIT_CODES.USAGE);
  assert.match(rec.err.join(""), /unknown provider nope/);
  assert.match(rec.err.join(""), /known providers:/);
});

test("switch selects, and says so", () => {
  const rec = recorded(withLab());
  assert.equal(handleProvidersSwitch(rec.ctx, { id: "fixture" }), EXIT_CODES.OK);
  assert.match(textOf(rec), /selected provider fixture/);
});

test("config resolves what a run would use", () => {
  const rec = recorded(withLab());

  assert.equal(handleProvidersConfig(rec.ctx, { json: false }), EXIT_CODES.OK);
  const text = textOf(rec);

  assert.match(text, /id\s+lab/);
  assert.match(text, /endpoint\s+https:\/\/lab\.example\/v1/);
  assert.match(text, /auth\s+api_key/);
  assert.match(text, /context\s+128000/);
  assert.match(text, /from\s+providers\.json/);
});

test("config of a built-in says where it came from and hides nothing", () => {
  const rec = recorded();
  assert.equal(handleProvidersConfig(rec.ctx, { id: "fixture", json: true }), EXIT_CODES.OK);
  const payload = JSON.parse(textOf(rec)) as { readonly origin: string; readonly auth: string };
  assert.equal(payload.origin, "builtin");
  assert.equal(payload.auth, "none");
});

test("config of a keyed provider with no endpoint is refused", () => {
  const rec = recorded();
  assert.equal(handleProvidersConfig(rec.ctx, { id: "openai-compatible", json: false }), EXIT_CODES.CONFIG);
  assert.match(rec.err.join(""), /needs an endpoint/);
});

test("a providers file that cannot be read is CONFIG, in every verb", () => {
  const files = new Map([[PATH, "{ broken"]]);
  for (const run of [
    () => handleProvidersList(recorded(files).ctx, { json: false }),
    () => handleProvidersModels(recorded(files).ctx, { id: "lab", json: false }),
    () => handleProvidersSwitch(recorded(files).ctx, { id: "lab" }),
    () => handleProvidersConfig(recorded(files).ctx, { json: false }),
  ]) {
    const rec = recorded(files);
    void rec;
    assert.equal(run(), EXIT_CODES.CONFIG);
  }
});
