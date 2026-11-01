import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "./args.js";
import { parseTools } from "./args-tools.js";

test("pipeline commands keep automation opt-in and strict bounded work flags", () => {
  assert.deepEqual(parseTools(["recipe", "checks.json", "--auto", "--workspace"]), { kind: "recipe", requestFile: "checks.json", automation: "after_turn", workspace: true });
  assert.equal(parseTools(["work", "--max-jobs", "3", "--allow-tools", "run_shell"]).kind, "work");
  assert.equal(parseTools(["jobs", "--json"]).kind, "jobs");
  assert.equal(parseTools(["queue", "double", "--scope", "project"]).kind, "queue");
  for (const argv of [["recipe", "x", "--auto", "--auto"], ["recipe", "x", "--allow-tools", "run_shell"],
    ["work", "--max-jobs", "4"], ["work", "--session", "named"], ["work", "--provider", "x", "--provider", "y"],
    ["queue", "double", "--scope"], ["jobs", "--provider", "x"], ["expire"], ["work", "--allow-tools", "*"]]) assert.equal(parseTools(argv).kind, "error");
});

test("use lends a frozen version to an ordinary run only through an explicit separator", () => {
  const command = parseTools(["use", "candidate-v1", "--", "--provider", "fixture", "use this tool"]);
  assert.equal(command.kind, "use");
  for (const args of [["use", "candidate-v1"], ["use", "", "--", "task"],
    ["use", "v", "--", "--session", "persistent", "task"], ["use", "v", "--", "--subagent", "task"]]) {
    assert.equal(parseTools(args).kind, "error");
  }
});

test("a user may explicitly allow a frozen candidate name without accepting wildcard or malformed names", () => {
  const command = parseTools(["use", "candidate-v1", "--", "--allow-tools", "learned__double_012345abcdef", "task"]);
  assert.equal(command.kind, "use");
  for (const name of ["learned__*", "learned__double", "learned__double_012345abcdeg"]) {
    assert.equal(parseTools(["use", "v", "--", "--allow-tools", name, "task"]).kind, "error");
  }
});

test("frozen candidate trials and improvements have explicit commands", () => {
  assert.equal(parseTools(["trial", "version-1", "new-cases.json", "--allow-tools", "run_shell", "--json"]).kind, "trial");
  assert.equal(parseTools(["improve", "version-1", "new-cases.json", "--model", "selected-model"]).kind, "improve");
  assert.equal(parseTools(["trials", "version-1", "--json"]).kind, "trials");
});

test("trial commands reject provider overrides and incomplete identifiers before any execution", () => {
  for (const args of [["trial", "v"], ["trial", "", "cases.json"], ["trial", "v", "cases.json", "--model", "ignored"],
    ["trials", "v", "--allow-tools", "run_shell"], ["improve", "v", "cases.json", "--api-key", "secret"]]) {
    assert.equal(parseTools(args).kind, "error");
  }
});

test("long-thinking generation uses an explicit bounded timeout without changing sample deadlines", () => {
  const command = parseTools(["improve", "v", "cases.json", "--generation-timeout-ms", "180000"]);
  assert.equal(command.kind, "improve");
  if (command.kind === "improve") assert.equal("generationTimeoutMs" in command && command.generationTimeoutMs, 180000);
  for (const value of ["0", "-1", "300001", "Infinity", "1.5"]) {
    assert.equal(parseTools(["evolve", "cases.json", "--generation-timeout-ms", value]).kind, "error");
  }
});

test("tools is routed through its explicit command family", () => {
  assert.deepEqual(parseArgs(["tools", "candidates", "--json"]), { kind: "family", word: "tools", args: ["candidates", "--json"] });
  assert.equal(parseArgs([]).kind, "repl");
  const normal = parseArgs(["run", "check the source"]);
  assert.equal(normal.kind, "run");
  if (normal.kind === "run") assert.equal(normal.options.learning, undefined);
});

test("tools help and read-only candidates accept no execution options", () => {
  assert.equal(parseTools([]).kind, "help");
  assert.equal(parseTools(["--help"]).kind, "help");
  assert.equal(parseTools(["candidates", "--json"]).kind, "candidates");
  for (const args of [["candidates", "--provider", "lab"], ["candidates", "install"], ["activate", "candidate"]]) {
    assert.equal(parseTools(args).kind, "error", args.join(" "));
  }
});

test("search retains its capability and explicit platform order without expanding sources", () => {
  assert.deepEqual(parseTools(["search", "parse office documents", "--platform", "github", "--platform", "npm", "--platform", "github", "--json"]),
    { kind: "search", capability: "parse office documents", platforms: ["github", "npm"] });
  for (const args of [["search"], ["search", " "], ["search", "parse", "--platform", "arbitrary"], ["search", "parse", "--platform"], ["search", "parse", "--endpoint", "https://other.invalid"]]) {
    assert.equal(parseTools(args).kind, "error", args.join(" "));
  }
});

test("evolve keeps provider/model overrides local to this command and carries explicit shell permission", () => {
  const command = parseTools(["evolve", "request with spaces.json", "--provider", "lab", "--model", "lab-model", "--endpoint", "https://lab.invalid/v1", "--allow-tools", "run_shell", "--json"]);
  assert.equal(command.kind, "evolve");
  if (command.kind !== "evolve") return;
  assert.equal(command.requestFile, "request with spaces.json");
  assert.deepEqual(command.run, { message: [], readStdin: false, provider: "lab", model: "lab-model", endpoint: "https://lab.invalid/v1", allowTools: ["run_shell"] });
});

test("evolve rejects missing, unknown and repeated value options", () => {
  for (const args of [["evolve"], ["evolve", "--provider", "lab"], ["evolve", "request.json", "--provider"],
    ["evolve", "request.json", "--model", "one", "--model", "two"], ["evolve", "request.json", "--secret", "private"],
    ["evolve", "request.json", "--allow-writes"], ["evolve", "request.json", "extra.json"]]) {
    assert.equal(parseTools(args).kind, "error", args.join(" "));
  }
});

test("evolve rejects empty override values instead of silently defaulting", () => {
  for (const flag of ["--provider", "--model", "--endpoint", "--allow-tools"]) {
    for (const value of ["", "   "]) assert.equal(parseTools(["evolve", "request.json", flag, value]).kind, "error", `${flag} with blank value`);
  }
  assert.equal(parseTools(["evolve", "request.json", "--allow-tools", ","]).kind, "error");
});
