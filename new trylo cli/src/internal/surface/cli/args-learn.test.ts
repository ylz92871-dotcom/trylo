import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "./args.js";

test("Hermes skill learning accepts only subsystem allowance", () => {
  for (const [tokens, calls] of [[4096, 2], [0, 0]]) {
    assert.deepEqual(parseArgs(["learn", "skill", "--tokens", String(tokens), "--calls", String(calls)]), {
      kind: "learn", options: { subsystem: "skill", grant: { subsystem: "skill", allowance: { maxCalls: calls, maxOutputTokens: tokens } } },
    });
  }
  for (const flags of [[], ["--tokens", "10"], ["--tokens", "-1", "--calls", "1"],
    ["--tokens", "9007199254740992", "--calls", "1"], ["--tokens", "1.5", "--calls", "1"],
    ["--tokens", "10", "--calls", "1", "--calls", "2"],
    ["--tokens", "10", "--calls", "1", "--lesson", "chosen"],
    ["--tokens", "10", "--calls", "1", "--conditions", "chosen"],
    ["--tokens", "10", "--calls", "1", "--steps", "2"]]) {
    assert.equal(parseArgs(["learn", "skill", ...flags]).kind, "error", JSON.stringify(flags));
  }
});

test("standalone learning names the subsystem and budgets, without selecting its content", () => {
  assert.deepEqual(parseArgs(["learn", "collaboration", "--budget", "8", "--prompt-chars", "900"]), {
    kind: "learn", options: { subsystem: "collaboration", maxEpisodes: 8, maxPromptChars: 900 },
  });
  assert.deepEqual(parseArgs(["learn", "collaboration", "--budget", "0"]), {
    kind: "learn", options: { subsystem: "collaboration", maxEpisodes: 0, maxPromptChars: 1200 },
  });
});

test("learning rejects unknown content selectors, unbounded budgets and duplicate flags", () => {
  for (const tail of [[], ["other", "--budget", "1"], ["collaboration"],
    ["collaboration", "--budget", "-1"], ["collaboration", "--budget", "1.2"],
    ["collaboration", "--budget", "257"], ["collaboration", "--budget", "NaN"],
    ["collaboration", "--budget", "1", "--budget", "2"],
    ["collaboration", "--budget", "1", "--episode", "chosen"],
    ["collaboration", "--budget", "1", "--prompt-chars", "99999"]]) {
    assert.equal(parseArgs(["learn", ...tail]).kind, "error", JSON.stringify(tail));
  }
  assert.deepEqual(parseArgs(["learn", "--help"]), { kind: "family_help", options: { family: "learn" } });
});

test("persistent learning only accepts a named subsystem and allowance, with explicit no-refill recovery", () => {
  assert.deepEqual(parseArgs(["learn", "collaboration", "--tokens", "16000", "--calls", "2", "--steps", "4"]), {
    kind: "learn", options: { subsystem: "collaboration", resume: false,
      grant: { maxSteps: 4, maxModelCalls: 2, maxModelTokens: 16000, maxPromptChars: 40000 } },
  });
  const resumed = parseArgs(["learn", "collaboration", "--resume"]);

  assert.equal(resumed.kind, "learn");

  if (resumed.kind === "learn" && "resume" in resumed.options) assert.equal(resumed.options.resume, true);

  assert.equal(parseArgs(["learn", "collaboration", "--tokens", "16000", "--prompt-chars", "100000"]).kind, "learn");

  for (const flags of [["--tokens", "10", "--budget", "1"], ["--tokens", "1000001"],
    ["--tokens", "10", "--calls", "17"], ["--tokens", "10", "--prompt-chars", "100001"],
    ["--resume", "--tokens", "10"], ["--tokens", "10", "--asset", "chosen"]]) {
    assert.equal(parseArgs(["learn", "collaboration", ...flags]).kind, "error");
  }
});

test("collaboration governance requires explicit user evidence and an exact correction scope", () => {
  assert.equal(parseArgs(["learn", "collaboration", "status", "--json"]).kind, "learn");
  const base = ["learn", "collaboration", "correct", "--family", "handoff", "--evidence-ref", "user:unneeded"];

  assert.equal(parseArgs([...base, "--action", "suspend", "--scope", "workspace"]).kind, "learn");
  assert.equal(parseArgs([...base, "--action", "restore", "--scope", "workspace", "--replaces", "prior"]).kind, "learn");

  for (const tail of [["--action", "restore", "--scope", "workspace"], ["--action", "suspend", "--scope", "global"],
    ["--action", "suspend", "--scope", "class"], ["--action", "suspend", "--scope", "workspace", "--task-id", "other"],
    ["--action", "suspend", "--scope", "workspace", "--replaces", "prior"]]) assert.equal(parseArgs([...base, ...tail]).kind, "error");

  assert.equal(parseArgs(["learn", "collaboration", "status", "--family", "selected"]).kind, "error");
  assert.equal(parseArgs([...base, "--action", "suspend", "--scope", "workspace", "--evidence-ref", "peer:claim"]).kind, "error");
});
