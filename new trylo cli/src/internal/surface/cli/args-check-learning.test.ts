import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "./args.js";

test("check learning command allocates model, execution and token quota without choosing a lesson", () => {
  assert.deepEqual(parseArgs(["learn", "check", "--budget", "2", "--tokens", "24000", "--executions", "8"]), {
    kind: "learn", options: { subsystem: "check", action: "learn", allowance: { modelCalls: 2, tokens: 24000, executions: 8 } },
  });
  assert.deepEqual(parseArgs(["learn", "check", "--executions", "0", "--tokens", "0", "--budget", "0"]), {
    kind: "learn", options: { subsystem: "check", action: "learn", allowance: { modelCalls: 0, tokens: 0, executions: 0 } },
  });
});

test("check learning management is explicit and separate from a new learning allocation", () => {
  assert.deepEqual(parseArgs(["learn", "check", "--status"]), { kind: "learn", options: { subsystem: "check", action: "status" } });
  assert.deepEqual(parseArgs(["learn", "check", "--recover"]), { kind: "learn", options: { subsystem: "check", action: "recover" } });
});

test("check learning rejects incomplete, duplicated, unbounded or content-selecting flags", () => {
  const base = ["--budget", "1", "--tokens", "24000", "--executions", "4"];
  for (const flags of [[], ["--budget", "1"], ["--budget", "1", "--tokens", "10"], ["--status", "--recover"],
    ["--status", ...base], ["--recover", "--budget", "1"], [...base, "--topic", "skip-negative"], [...base, "--asset", "chosen"],
    [...base, "--budget", "2"], ["--budget", "33", "--tokens", "10", "--executions", "1"],
    ["--budget", "1", "--tokens", "262145", "--executions", "1"], ["--budget", "1", "--tokens", "10", "--executions", "257"],
    ["--budget", "1.5", "--tokens", "10", "--executions", "1"], ["--budget", "-1", "--tokens", "10", "--executions", "1"]]) {
    assert.equal(parseArgs(["learn", "check", ...flags]).kind, "error", JSON.stringify(flags));
  }
});
