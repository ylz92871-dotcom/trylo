import assert from "node:assert/strict";
import test from "node:test";
import { parseLearn } from "./args-learn.js";

test("skill central control is reachable through the existing learn parser with explicit workspace and stdin", () => {
  assert.deepEqual(parseLearn(["skill", "issues", "--json", "--workspace", "./project", "--issue", "skill-issue:one"]),
    { kind: "learn", options: { subsystem: "skill", control: "issues", workspace: "./project", issueId: "skill-issue:one" } });
  assert.deepEqual(parseLearn(["skill", "focus", "-", "--workspace", "./project"]),
    { kind: "learn", options: { subsystem: "skill", control: "focus", workspace: "./project" } });
  assert.deepEqual(parseLearn(["skill", "dispatch", "--issue", "skill-issue:one"]),
    { kind: "learn", options: { subsystem: "skill", control: "dispatch", issueId: "skill-issue:one" } });
  assert.deepEqual(parseLearn(["skill", "dispatch"]), { kind: "learn", options: { subsystem: "skill", control: "dispatch" } });
});

test("skill central commands reject ambiguous allocation and preserve the legacy output-token entry", () => {
  for (const args of [["focus"], ["focus", "-", "--tokens", "100"], ["focus", "-", "--issue", "x"], ["focus", "-", "-"],
    ["issues", "--json", "--json"], ["dispatch", "--json"], ["dispatch", "--issue", "x", "--issue", "y"],
    ["issues", "--workspace", "--issue"], ["issues", "--workspace", "unsafe\npath"]]) {
    assert.equal(parseLearn(["skill", ...args]).kind, "error", args.join(" "));
  }

  assert.deepEqual(parseLearn(["skill", "--tokens", "0", "--calls", "0"]), { kind: "learn", options: { subsystem: "skill",
    grant: { subsystem: "skill", allowance: { maxCalls: 0, maxOutputTokens: 0 } } } });
  assert.deepEqual(parseLearn(["skill", "--calls", "2", "--tokens", "1000"]), { kind: "learn", options: { subsystem: "skill",
    grant: { subsystem: "skill", allowance: { maxCalls: 2, maxOutputTokens: 1000 } } } });
});

test("skill native administration exposes only asset methods and explicit learning requires stdin", () => {
  assert.deepEqual(parseLearn(["skill", "native", "pendingApply", "-"]),
    { kind: "learn", options: { subsystem: "skill", nativeMethod: "pendingApply" } });
  assert.deepEqual(parseLearn(["skill", "explicit", "-"]), { kind: "learn", options: { subsystem: "skill", explicit: true } });
  for (const args of [["native", "pendingProposeSkill", "-"], ["native", "review", "-"], ["native", "pendingApply"], ["explicit"], ["explicit", "-", "--tokens", "10"]]) {
    assert.equal(parseLearn(["skill", ...args]).kind, "error");
  }
});
