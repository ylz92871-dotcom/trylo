import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { detectPromptPatch } from "./detector.js";
import {
  attributeSingleEpisode,
  attributeTwoPromptGains,
  type PromptGainEpisode,
} from "./attribution.js";
import { taskFamiliesComparable } from "./task-family.js";
import { FORBIDDEN_BOARD_ACTIONS } from "../../../../domains/shared/board-command.js";

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

function cloneEpisode(
  episode: PromptGainEpisode,
  patch: Partial<PromptGainEpisode>,
): PromptGainEpisode {
  return { ...episode, ...patch };
}

test("two comparable prompt-only gains create a draft proposal, not activation", () => {
  const { episodes } = loadPositivePair();
  const first = episodes[0];
  const second = episodes[1];

  assert.ok(first && second);
  const detected = detectPromptPatch({ episodes: [first, second] });

  assert.equal(detected.kind, "draft");

  if (detected.kind !== "draft") {
    return;
  }

  assert.equal(detected.draft.status, "draft");
  assert.equal(detected.draft.activationEligible, false);
  assert.equal(detected.draft.kind, "prompt_patch");
  assert.equal(detected.draft.command.kind, "submit_draft");
  assert.equal(detected.draft.causalObservationRefs.length, 2);
  assert.equal(detected.draft.baselinePromptHash, first.baselinePromptHash);
  assert.equal("permission" in detected.draft, false);

  for (const action of FORBIDDEN_BOARD_ACTIONS) {
    assert.equal(action in detected.draft, false);
  }
});

test("one successful episode is insufficient_evidence", () => {
  const { episodes } = loadPositivePair();
  const first = episodes[0];

  assert.ok(first);
  const detected = detectPromptPatch({ episodes: [first] });

  assert.equal(detected.kind, "failure");

  if (detected.kind === "failure") {
    assert.equal(detected.code, "insufficient_evidence");
  }

  assert.equal(attributeSingleEpisode(first).code, "insufficient_evidence");
});

test("dissimilar task families are not attributed to prompt", () => {
  const { episodes } = loadPositivePair();
  const first = episodes[0];
  const second = episodes[1];

  assert.ok(first && second);
  const other = cloneEpisode(second, {
    taskFamily: {
      ...second.taskFamily,
      intentClass: "write_release_notes",
    },
  });

  assert.equal(taskFamiliesComparable(first.taskFamily, other.taskFamily), false);
  const result = attributeTwoPromptGains(first, other);

  assert.equal(result.kind, "failure");

  if (result.kind === "failure") {
    assert.equal(result.code, "insufficient_attribution");
    assert.equal(result.confounders.includes("intentClass"), true);
  }
});

test("model change with prompt change is insufficient_attribution", () => {
  const { episodes } = loadPositivePair();
  const first = episodes[0];
  const second = episodes[1];

  assert.ok(first && second);
  const changed = cloneEpisode(second, {
    versions: { ...second.versions, model: "other-model" },
  });
  const result = attributeTwoPromptGains(first, changed);

  assert.equal(result.kind, "failure");

  if (result.kind === "failure") {
    assert.equal(result.code, "insufficient_attribution");
    assert.deepEqual(result.confounders, ["model"]);
  }
});

test("toolset change with prompt change is insufficient_attribution", () => {
  const { episodes } = loadPositivePair();
  const first = episodes[0];
  const second = episodes[1];

  assert.ok(first && second);
  const changed = cloneEpisode(second, {
    versions: { ...second.versions, toolset: "other-tools" },
  });
  const result = attributeTwoPromptGains(first, changed);

  assert.equal(result.kind, "failure");

  if (result.kind === "failure") {
    assert.deepEqual(result.confounders, ["toolset"]);
  }
});

test("code and workflow confounders block prompt credit", () => {
  const { episodes } = loadPositivePair();
  const first = episodes[0];
  const second = episodes[1];

  assert.ok(first && second);
  const code = attributeTwoPromptGains(
    first,
    cloneEpisode(second, {
      versions: { ...second.versions, codeBaseline: "git:deadbeef" },
    }),
  );
  const flow = attributeTwoPromptGains(
    first,
    cloneEpisode(second, {
      versions: { ...second.versions, workflow: "wf:new" },
    }),
  );

  assert.equal(code.kind, "failure");
  assert.equal(flow.kind, "failure");

  if (code.kind === "failure") {
    assert.deepEqual(code.confounders, ["codeBaseline"]);
  }

  if (flow.kind === "failure") {
    assert.deepEqual(flow.confounders, ["workflow"]);
  }
});

test("prompt patch cannot smuggle permission or tool switch", () => {
  const { episodes } = loadPositivePair();
  const detected = detectPromptPatch({
    episodes,
    extraClaims: ["permission:skip_approval", "tool_switch:network"],
  });

  assert.equal(detected.kind, "failure");

  if (detected.kind === "failure") {
    assert.equal(detected.code, "forbidden_payload");
  }
});

test("self-generated tests cannot attribute a prompt gain", () => {
  const { episodes } = loadPositivePair();
  const first = episodes[0];
  const second = episodes[1];

  assert.ok(first && second);
  const fake = cloneEpisode(second, {
    candidateExternal: { ...second.candidateExternal, selfGenerated: true },
  });
  const result = attributeTwoPromptGains(first, fake);

  assert.equal(result.kind, "failure");

  if (result.kind === "failure") {
    assert.equal(result.code, "insufficient_evidence");
  }
});

test("same conversation is not two independent dialogues", () => {
  const { episodes } = loadPositivePair();
  const first = episodes[0];
  const second = episodes[1];

  assert.ok(first && second);
  const result = attributeTwoPromptGains(
    first,
    cloneEpisode(second, { conversationId: first.conversationId }),
  );

  assert.equal(result.kind, "failure");

  if (result.kind === "failure") {
    assert.equal(result.code, "insufficient_evidence");
  }
});

test("opposite external directions do not create a strong candidate", () => {
  const { episodes } = loadPositivePair();
  const first = episodes[0];
  const second = episodes[1];

  assert.ok(first && second);
  const worse = cloneEpisode(second, {
    candidateExternal: { ...second.candidateExternal, result: "fail" },
    baselineExternal: { ...second.baselineExternal, result: "pass" },
  });
  const result = attributeTwoPromptGains(first, worse);

  assert.equal(result.kind, "failure");

  if (result.kind === "failure") {
    assert.equal(result.code, "insufficient_evidence");
  }
});

test("proposal eligible record never sets activationEligible", () => {
  const { episodes } = loadPositivePair();
  const first = episodes[0];
  const second = episodes[1];

  assert.ok(first && second);
  const result = attributeTwoPromptGains(first, second);

  assert.equal(result.kind, "proposal_eligible");

  if (result.kind === "proposal_eligible") {
    assert.equal(result.record.proposalEligible, true);
    assert.equal(result.record.activationEligible, false);
    assert.equal(result.record.threshold, 2);
  }
});
