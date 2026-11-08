import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./args.js";
import { switchEnablesCheck, switchEnablesMethod, switchEnablesSkill, switchEnablesTool, switchEnablesUser } from "../../integration/user-learning/switch.js";

test("agent selection mounts reusable agent capabilities without user collection or checking", () => {
  const parsed = parseArgs(["run", "--learning=agent", "--skill-learning-budget", "32000", "--skill-learning-calls", "4", "task"]);

  assert.equal(parsed.kind, "run");

  if (parsed.kind !== "run") return;

  const selected = parsed.options.learning;

  assert.equal(switchEnablesMethod(selected), true);
  assert.equal(switchEnablesTool(selected), true);
  assert.equal(switchEnablesSkill(selected), true);
  assert.equal(switchEnablesUser(selected), false);
  assert.equal(switchEnablesCheck(selected), false);
  assert.deepEqual(parsed.options.skillLearningAllowance, { schemaVersion: 2, unit: "total_model_tokens",
    maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 39000 });
});

test("skill central allocation requires two explicit bounded values and its own selected domain", () => {
  for (const flags of [
    ["--learning=skill", "--skill-learning-budget", "32000"],
    ["--learning=user", "--skill-learning-budget", "32000", "--skill-learning-calls", "4"],
    ["--learning=agent", "--skill-learning-budget", "32000", "--skill-learning-calls", "17"],
    ["--learning=skill", "--skill-learning-budget", "0", "--skill-learning-calls", "4"],
    ["--learning=skill", "--skill-learning-budget", "32000", "--skill-learning-calls", "4", "--skill-learning-calls", "4"],
  ]) assert.equal(parseArgs(["run", ...flags, "task"]).kind, "error");

  const onlySwitch = parseArgs(["run", "--learning=skill", "task"]);

  assert.equal(onlySwitch.kind, "run");

  if (onlySwitch.kind === "run") assert.equal(onlySwitch.options.skillLearningAllowance, undefined);
});
