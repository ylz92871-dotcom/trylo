import assert from "node:assert/strict";
import test from "node:test";
import { induceSkill, type SkillEpisode } from "./inducer.js";
import { parseSkillEpisodeList } from "./parse-episode.js";

const family = {
  id: "repair-json-report",
  intentClass: "repair_report",
  checkKind: "acceptance" as const,
  language: "json",
  checkSchema: "amount-v1",
};

function episode(id: string, steps: readonly string[], outcome: "success" | "failure" = "success"): SkillEpisode {
  return {
    id, taskFamily: family, outcome, steps,
    trajectory: { nodeIds: steps, stepCount: steps.length, hadChecks: true, hadFailureRecovery: outcome === "failure" },
    checks: ["independent amount checker"],
    ...(outcome === "failure" ? { failureMode: "text replacement changed quoted amounts" } : {}),
  };
}

const structured = ["parse JSON structure", "update numeric fields", "run amount checker"];
const textual = ["replace text", "run amount checker"];

test("skill induction is invariant under episode permutation and prefers independently repeated paths", () => {
  const episodes = [episode("s-text", textual), episode("s-json-1", structured), episode("s-json-2", structured), episode("f-text", textual, "failure")];
  const first = induceSkill(episodes);
  const shuffled = induceSkill([episodes[2]!, episodes[3]!, episodes[0]!, episodes[1]!]);

  assert.deepEqual(first, shuffled);
  assert.equal(first.kind, "draft");

  if (first.kind === "draft") {
    assert.deepEqual(first.draft.steps, structured);
    assert.equal(Array.isArray(Reflect.get(first.draft, "variants")), true);
  }
});

test("explicit condition correction stops the previously supported path instead of treating correction as success", () => {
  const parsed = parseSkillEpisodeList(JSON.stringify({ episodes: [
    episode("s-json-1", structured), episode("s-json-2", structured),
    { ...episode("correction", structured, "failure"), correction: { targetEpisodeIds: ["s-json-1"], scope: "condition", reason: "this path corrupts decimal strings" } },
  ] }));

  assert.equal(parsed.ok, true);

  if (parsed.ok) {
    const result = induceSkill(parsed.value);
    assert.equal(result.kind, "failure");
  }
});

test("incomparable family identities are not silently merged by matching intent text", () => {
  const result = induceSkill([
    episode("s1", structured),
    { ...episode("s2", textual), taskFamily: { ...family, id: "other-workspace-family" } },
    episode("f1", textual, "failure"),
  ]);
  assert.equal(result.kind, "failure");
});

test("duplicate execution identities cannot inflate independent support", () => {
  assert.equal(induceSkill([episode("s1", structured), episode("s1", structured), episode("f1", textual, "failure")]).kind, "failure");
});

test("a check mentioned only in a failed episode is not promoted as a successful check", () => {
  const result = induceSkill([
    episode("s1", structured), episode("s2", structured),
    { ...episode("f1", textual, "failure"), checks: ["unchecked promise"] },
  ]);

  assert.equal(result.kind, "draft");

  if (result.kind === "draft") {
    assert.deepEqual(result.draft.checks, ["independent amount checker"]);
  }
});
