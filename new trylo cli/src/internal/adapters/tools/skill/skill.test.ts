import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../../../protocol/envelope.js";
import type { SkillCatalogPort, SkillDescriptor, SkillForkRequest } from "../../../ports/skills.js";
import type { ToolCallRequest } from "../../../ports/tools.js";
import { createSkillTools, SKILL_TOOL_NAME } from "./index.js";

/**
 * The model-facing `skill` tool (WP14.2 / L52).
 *
 * The tests pin the consumption contract, not the file layout: a loaded skill
 * reaches the model as the tool result, an unknown or model-disabled skill is a
 * typed error, and `context: fork` never silently degrades to inline — it either
 * delegates or refuses with a terminal code.
 */

function descriptor(overrides: Partial<SkillDescriptor> = {}): SkillDescriptor {
  return {
    name: "commit-helper",
    description: "Drafts commits",
    source: "project",
    skillRoot: "/ws/.trylo/skills/commit-helper",
    path: "/ws/.trylo/skills/commit-helper/SKILL.md",
    contentHash: "abc123",
    body: "Write the message using $ARGUMENTS.",
    userInvocable: true,
    disableModelInvocation: false,
    forkExecution: false,
    ...overrides,
  };
}

function catalogOf(...skills: SkillDescriptor[]): SkillCatalogPort {
  return {
    list: () => skills,
    load(name, args) {
      const descriptor = skills.find((skill) => skill.name === name);
      if (descriptor === undefined) {
        return { kind: "unknown_skill", name };
      }

      // No gate here on purpose: the loader only loads. Where the
      // disable-model-invocation line is enforced is exactly what these tests
      // pin — a fake that re-implemented the gate could only prove itself.
      const dir = descriptor.skillRoot.replaceAll("\\", "/");
      let content = `Base directory for this skill: ${dir}\n\n${descriptor.body}`;

      content = content.replaceAll("${TRYLO_SKILL_DIR}", dir).replaceAll("${CLAUDE_SKILL_DIR}", dir);
      content = content.replaceAll("$ARGUMENTS", args ?? "");

      return { kind: "loaded", skill: { descriptor, content } };
    },
  };
}

function call(arguments_: JsonObject): ToolCallRequest {
  return { toolCallId: "t1", name: SKILL_TOOL_NAME, arguments: arguments_ };
}

test("the binding is offered for approval and lists invocable skills", () => {
  const tools = createSkillTools(
    catalogOf(descriptor(), descriptor({ name: "internal", disableModelInvocation: true })),
  );
  const [binding] = tools.snapshot();

  assert.equal(binding?.name, "skill");
  assert.equal(binding?.needsApproval, true);
  assert.equal(binding?.sideEffect, "read_only");
  assert.match(binding?.description ?? "", /commit-helper/);
  assert.doesNotMatch(binding?.description ?? "", /internal/);
});

test("a model call loads the skill content as the tool result", async () => {
  const tools = createSkillTools(catalogOf(descriptor()));
  const outcome = await tools.execute(call({ skill: "commit-helper", args: "keep short" }), new AbortController().signal);
  assert.equal(outcome.outcome, "result");
  if (outcome.outcome !== "result") return;
  assert.match(outcome.output, /Base directory for this skill: \/ws\/.trylo\/skills\/commit-helper/);
  assert.match(outcome.output, /Write the message using keep short\./);
});

test("a leading slash in the requested name still resolves", async () => {
  const tools = createSkillTools(catalogOf(descriptor()));
  const outcome = await tools.execute(call({ skill: "/commit-helper" }), new AbortController().signal);
  assert.equal(outcome.outcome, "result");
});

test("an unknown skill is a typed error, not a shrug", async () => {
  const tools = createSkillTools(catalogOf());
  const outcome = await tools.execute(call({ skill: "nope" }), new AbortController().signal);
  assert.equal(outcome.outcome, "error");
  if (outcome.outcome !== "error") return;
  assert.equal(outcome.code, "unknown_skill");
});

test("a disable-model-invocation skill refuses the model with its own code", async () => {
  const tools = createSkillTools(catalogOf(descriptor({ disableModelInvocation: true })));
  const outcome = await tools.execute(call({ skill: "commit-helper" }), new AbortController().signal);
  assert.equal(outcome.outcome, "error");
  if (outcome.outcome !== "error") return;
  assert.equal(outcome.code, "model_invocation_disabled");
});

test("a missing skill argument is refused before the catalog is consulted", async () => {
  const tools = createSkillTools(catalogOf());
  const outcome = await tools.execute(call({}), new AbortController().signal);
  assert.equal(outcome.outcome, "error");
  if (outcome.outcome !== "error") return;
  assert.equal(outcome.code, "invalid_arguments");
});

test("a fork skill without an executor refuses terminally instead of going inline", async () => {
  const tools = createSkillTools(catalogOf(descriptor({ forkExecution: true })));
  const outcome = await tools.execute(call({ skill: "commit-helper" }), new AbortController().signal);
  assert.equal(outcome.outcome, "error");
  if (outcome.outcome !== "error") return;
  assert.equal(outcome.code, "skill_fork_unavailable");
});

test("a fork skill delegates the loaded content through the executor", async () => {
  const seen: SkillForkRequest[] = [];
  const tools = createSkillTools(
    catalogOf(descriptor({ forkExecution: true, allowedTools: ["read_file"] })),
    async (request) => {
      seen.push(request);
      return { outcome: "result", value: {}, output: "fork result", truncated: false };
    },
  );
  const outcome = await tools.execute(call({ skill: "commit-helper", args: "x" }), new AbortController().signal);

  assert.equal(outcome.outcome, "result");

  if (outcome.outcome !== "result") return;

  assert.equal(outcome.output, "fork result");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.name, "commit-helper");
  assert.match(seen[0]?.prompt ?? "", /Write the message using x\./);
  assert.deepEqual([...(seen[0]?.allowedTools ?? [])], ["read_file"]);
});
