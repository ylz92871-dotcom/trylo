import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { parseArgs } from "./args.js";
import { dispatch } from "./commands.js";
import { handleTools } from "./commands-tools.js";
import type { CliContext } from "./context.js";

function context(t: TestContext) {
  const prefix = path.resolve(tmpdir(), "trylo-tools-cli-");
  const root = mkdtempSync(prefix);
  assert.equal(path.resolve(root).startsWith(prefix), true);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "profile");
  const out: string[] = [], errors: string[] = [], reads: string[] = [], writes: string[] = [];
  const files = new Map<string, string>();
  let observed = 0, detached = 0, autoCancel = false;
  const ctx: CliContext = {
    cwd: root, homeDir: root, env: { TRYLO_HOME: home }, nodeVersion: "v24.14.1", platform: "win32", stdinIsTty: false,
    readFile: file => { reads.push(path.normalize(file)); return files.get(path.normalize(file)); },
    isDirectory: () => true, readDir: () => [], writeFile: (file, text) => { writes.push(file); files.set(path.normalize(file), text); return true; },
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: text => { out.push(text); }, stderr: text => { errors.push(text); }, now: () => 1_793_145_600_000, newId: name => `${name}-cli-test`,
    interrupts: {
      observe: handler => { observed += 1; if (autoCancel) handler(); },
      unobserve: () => { detached += 1; },
      exit: code => { throw new Error(`unexpected forced exit ${code}`); },
    },
  };
  return { ctx, root, home, out, errors, reads, writes, files,
    cancelAtStart: () => { autoCancel = true; }, observers: () => ({ observed, detached }) };
}

const request = {
  schemaVersion: 1, requestId: "cli-test", scope: "workspace:test", capability: "sum numbers", operation: "create",
  evidence: [
    { sampleId: "one", role: "source", input: [1, 2], expected: { kind: "value", value: 3 } },
    { sampleId: "two", role: "source", input: [2, 3], expected: { kind: "value", value: 5 } },
    { sampleId: "variation", role: "variation", input: [-1, 2], expected: { kind: "value", value: 1 } },
    { sampleId: "counterexample", role: "counterexample", input: null, expected: { kind: "error", code: "invalid_input" } },
  ],
};

test("caller recipe can bind explicitly to this workspace and inventories expose no activation", async t => {
  const fx = context(t), file = path.join(fx.ctx.cwd, "recipe.json");
  fx.files.set(path.normalize(file), JSON.stringify(request));
  assert.equal(await handleTools(fx.ctx, ["recipe", file, "--auto", "--workspace"]), EXIT_CODES.OK);
  const registered = JSON.parse(fx.out.at(-1) ?? "{}"); assert.equal(registered.ok, true); assert.equal(registered.recipeScope, registered.workspaceId);
  assert.equal(await handleTools(fx.ctx, ["recipes"]), EXIT_CODES.OK);
  const inventory = JSON.parse(fx.out.at(-1) ?? "{}"); assert.equal(inventory.recipes.length, 1); assert.equal(inventory.recipes[0].automation, "after_turn");
  assert.equal(await handleTools(fx.ctx, ["queue", request.capability]), EXIT_CODES.OK);
  assert.equal(await handleTools(fx.ctx, ["jobs"]), EXIT_CODES.OK);
  const jobs = JSON.parse(fx.out.at(-1) ?? "{}"); assert.equal(jobs.jobs.length, 1); assert.equal(jobs.jobs[0].state, "queued");
  assert.equal(await handleTools(fx.ctx, ["status", "--json"]), EXIT_CODES.OK);
  const status = JSON.parse(fx.out.at(-1) ?? "{}"); assert.equal(status.formatVersion, 1); assert.equal(status.totalJobs, 1);
  assert.equal(JSON.stringify(status).includes('"evidence"'), false); assert.equal(status.jobs[0].capability, request.capability);
  assert.equal(fx.observers().observed, 0, "data commands open no provider/cancellation resources");
});

test("tools help and invalid input touch no profile, provider or cancellation resources", async t => {
  const fx = context(t);
  assert.equal(await handleTools(fx.ctx, ["--help"]), EXIT_CODES.OK);
  assert.equal(await handleTools(fx.ctx, ["activate", "candidate"]), EXIT_CODES.USAGE);
  assert.deepEqual(fx.reads, []);
  assert.deepEqual(fx.writes, []);
  assert.deepEqual(fx.observers(), { observed: 0, detached: 0 });
  assert.equal(existsSync(fx.home), false);
});

test("missing frozen candidate refuses trial and improvement before provider or native setup", async t => {
  for (const kind of ["trial", "improve"]) {
    const fx = context(t);
    fx.files.set(path.join(fx.root, "request.json"), JSON.stringify(request));
    assert.equal(await handleTools(fx.ctx, [kind, "absent-version", "request.json", "--json"]), EXIT_CODES.CONFIG);
    assert.equal(JSON.parse(fx.out.join("")).code, "candidate_not_found");
    assert.equal(fx.reads.some(file => /credential|auth|providers\.json/i.test(file)), false);
    assert.equal(existsSync(fx.home), false);
    assert.deepEqual(fx.observers(), { observed: 1, detached: 1 });
  }
});

test("trial history is a read-only view and missing versions create no profile", async t => {
  const fx = context(t);
  assert.equal(await handleTools(fx.ctx, ["trials", "absent-version", "--json"]), EXIT_CODES.CONFIG);
  assert.equal(JSON.parse(fx.out.join("")).code, "candidate_not_found");
  assert.equal(existsSync(fx.home), false);
  assert.deepEqual(fx.observers(), { observed: 0, detached: 0 });
});

test("tools candidates is a read-only Board projection reachable through the global router", async t => {
  const fx = context(t);
  assert.equal(await dispatch(parseArgs(["tools", "candidates", "--json"]), fx.ctx), EXIT_CODES.OK);
  assert.deepEqual(JSON.parse(fx.out.join("")), { ok: true, candidates: [] });
  assert.deepEqual(fx.reads, []);
  assert.deepEqual(fx.writes, []);
  assert.equal(existsSync(fx.home), false);
  assert.deepEqual(fx.observers(), { observed: 0, detached: 0 });
});

test("ordinary version dispatch does not construct the experimental tool profile", async t => {
  const fx = context(t);
  assert.equal(await dispatch(parseArgs(["--version"]), fx.ctx), EXIT_CODES.OK);
  assert.deepEqual(fx.reads, []);
  assert.deepEqual(fx.writes, []);
  assert.equal(existsSync(fx.home), false);
});

test("unavailable PyPI search is reported honestly without querying a provider or writing a profile", async t => {
  const fx = context(t);
  assert.equal(await handleTools(fx.ctx, ["search", "parse a table", "--platform", "pypi", "--json"]), EXIT_CODES.TEMPORARY);
  const result = JSON.parse(fx.out.join(""));
  assert.equal(result.value.status, "failed");
  assert.equal(result.value.failures[0].code, "search_unsupported");
  assert.deepEqual(fx.reads, []);
  assert.deepEqual(fx.writes, []);
  assert.deepEqual(fx.observers(), { observed: 1, detached: 1 });
  assert.equal(existsSync(fx.home), false);
});

test("cancelled discovery uses the cancellation exit contract rather than a temporary-network exit", async t => {
  const fx = context(t);
  fx.cancelAtStart();
  assert.equal(await handleTools(fx.ctx, ["search", "parse a table", "--platform", "github", "--json"]), EXIT_CODES.CANCELLED);
  assert.equal(JSON.parse(fx.out.join("")).code, "cancelled");
  assert.deepEqual(fx.observers(), { observed: 1, detached: 1 });
  assert.equal(existsSync(fx.home), false);
});

test("evolve rejects unreadable, non-JSON and unauthorized request fields before selecting a provider", async t => {
  for (const raw of [undefined, "not json", JSON.stringify({ ...request, allowNetwork: true })]) {
    const fx = context(t);
    if (raw !== undefined) fx.files.set(path.join(fx.root, "request.json"), raw);
    assert.equal(await handleTools(fx.ctx, ["evolve", "request.json", "--json"]), EXIT_CODES.USAGE);
    assert.deepEqual(fx.reads, [path.join(fx.root, "request.json")]);
    assert.deepEqual(fx.writes, []);
    assert.equal(existsSync(fx.home), false);
    assert.deepEqual(fx.observers(), { observed: 1, detached: 1 });
  }
});

test("an unknown explicit provider fails before workers, credential lookup or candidate writes", async t => {
  const fx = context(t);
  fx.files.set(path.join(fx.root, "request.json"), JSON.stringify(request));
  assert.equal(await handleTools(fx.ctx, ["evolve", "request.json", "--provider", "missing-provider", "--json"]), EXIT_CODES.USAGE);
  assert.match(fx.errors.join(""), /unknown provider missing-provider/);
  assert.equal(fx.reads.some(file => /credential|auth/i.test(file)), false);
  assert.deepEqual(fx.writes, []);
  assert.equal(existsSync(fx.home), false);
});

test("a declared provider keeps its named account binding and refuses a missing account", async t => {
  const fx = context(t);
  fx.files.set(path.join(fx.root, "request.json"), JSON.stringify(request));
  fx.files.set(path.join(fx.home, "providers.json"), JSON.stringify({ version: 1, selected: "lab", providers: [
    { id: "lab", kind: "openai-compatible", endpoint: "http://127.0.0.1:1/v1", model: "local-test-model", accountId: "missing-bound-account" },
  ] }));
  assert.equal(await handleTools(fx.ctx, ["evolve", "request.json", "--json"]), EXIT_CODES.CONFIG);
  assert.match(fx.errors.join(""), /binds unknown account missing-bound-account/);
  assert.deepEqual(fx.writes, []);
  assert.equal(existsSync(fx.home), false);
});

test("candidate inventory fails closed on a corrupt Board and does not repair it", async t => {
  const fx = context(t);
  const board = path.join(fx.home, "learning", "board");
  mkdirSync(board, { recursive: true });
  const file = path.join(board, "board-events.ndjson");
  const original = '{"unexpected":"invalid-board-record"}\n';
  writeFileSync(file, original);
  assert.equal(await handleTools(fx.ctx, ["candidates", "--json"]), EXIT_CODES.CONFIG);
  assert.equal(JSON.parse(fx.out.join("")).ok, false);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.deepEqual(fx.writes, []);
  assert.equal(existsSync(path.join(board, "board-writer.lock")), false);
});
