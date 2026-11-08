import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "./args.js";

test("ordinary team collaboration has a separate bounded allowance and explicit opt-out", () => {
  for (const [raw, expected] of [["16000", 16000], ["off", "off"]] as const) {
    const parsed = parseArgs(["run", `--collaboration-learning=${raw}`, "--learning=user", "task"]);
    assert.equal(parsed.kind, "run");
    if (parsed.kind !== "run") continue;
    assert.equal(Reflect.get(parsed.options, "collaborationLearning"), expected);
    assert.equal(parsed.options.learning, "user");
  }
});

test("collaboration allowance rejects malformed, duplicate and unbounded grants", () => {
  for (const raw of ["", "on", "255", "64001", "1.5", "-1", "NaN"]) {
    assert.equal(parseArgs(["run", `--collaboration-learning=${raw}`, "task"]).kind, "error");
  }
  assert.equal(parseArgs(["run", "--collaboration-learning=16000", "--collaboration-learning=32000", "task"]).kind, "error");
});
