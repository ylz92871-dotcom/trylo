import type { SkillCatalogPort, SkillForkExecutor } from "../../../ports/skills.js";
import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../../../ports/tools.js";
import { SUBAGENT_TOOL_NAME } from "../../../subagent/names.js";
import { SKILL_TOOL_NAME } from "./names.js";

export { SKILL_TOOL_NAME };

/**
 * The model-facing `skill` tool (WP14.2 / L52).
 *
 * One tool for every installed skill: the model names a skill, this loads its
 * composed content and returns it as the tool result, so the *next* turn's work
 * follows the skill's instructions. The catalog is lent in, frozen per turn —
 * the tool holds no cache of its own, which is what makes an uninstall stop
 * being consumable without any clearing step.
 *
 * Approval: the binding declares `needsApproval: true`. A skill's content is
 * third-party text about to steer the run, so which skills may fire is a human
 * decision, the same position the old CLI took; a remembered exact-call grant
 * covers the repeat case. The sandbox planner keeps its own plan for this name
 * (`planSkill`): the call is read-only, but it is not unplanned.
 */

export const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set([SKILL_TOOL_NAME]);

/** The listing, and why it is capped: a catalog with hundreds of skills must not become an unbounded prompt. */
const MAX_LISTED_SKILLS = 30;

export function createSkillTools(catalog: SkillCatalogPort, fork?: SkillForkExecutor): ToolPort {
  return {
    snapshot: () => [binding(catalog.list())],

    async execute(call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> {
      if (call.name !== SKILL_TOOL_NAME) {
        return { outcome: "unknown", code: "unknown_tool", message: `skill tool does not implement ${call.name}` };
      }

      const requested = call.arguments["skill"];
      if (typeof requested !== "string" || requested.trim().length === 0) {
        return { outcome: "error", code: "invalid_arguments", message: "skill requires a non-empty skill name" };
      }

      const args = call.arguments["args"];
      if (args !== undefined && typeof args !== "string") {
        return { outcome: "error", code: "invalid_arguments", message: "skill args must be a string" };
      }

      // A model that reaches for the slash spelling still names the skill.
      const name = requested.trim().replace(/^\//, "");
      const loaded = catalog.load(name, args);
      if (loaded.kind === "unknown_skill") {
        return { outcome: "error", code: "unknown_skill", message: `no installed skill named '${name}'` };
      }

      // The model-side gate lives here, on the model-facing tool — not in the
      // shared loader, whose other consumer is the user's slash (F1/复核): the
      // field means "user-only", so it must never lock the user out.
      if (loaded.skill.descriptor.disableModelInvocation) {
        return {
          outcome: "error",
          code: "model_invocation_disabled",
          message: `skill '${name}' sets disable-model-invocation and cannot be invoked by the model`,
        };
      }

      if (loaded.skill.descriptor.forkExecution) {
        if (fork === undefined) {
          return forkUnavailable(name);
        }
        return fork({
          toolCallId: call.toolCallId,
          name,
          prompt: loaded.skill.content,
          ...(loaded.skill.descriptor.allowedTools === undefined ? {} : { allowedTools: loaded.skill.descriptor.allowedTools }),
          signal,
        });
      }

      return {
        outcome: "result",
        value: {
          name,
          source: loaded.skill.descriptor.source,
          skillRoot: loaded.skill.descriptor.skillRoot.replaceAll("\\", "/"),
          contentHash: loaded.skill.descriptor.contentHash,
          fork: false,
        },
        output: loaded.skill.content,
        truncated: false,
      };
    },

    async cancel(): Promise<void> {
      // Loading is a synchronous read over the frozen snapshot; a forked skill
      // is cancelled through the delegate's own signal handling.
    },
  };
}

function binding(skills: ReadonlyArray<{ name: string; description: string; whenToUse?: string; disableModelInvocation: boolean }>): ToolBinding {
  const invocable = skills.filter((skill) => !skill.disableModelInvocation);
  const listed = invocable.slice(0, MAX_LISTED_SKILLS);
  const lines = listed.map((skill) => {
    const hint = skill.whenToUse === undefined ? "" : ` — use when: ${skill.whenToUse}`;
    return `- ${skill.name}: ${skill.description}${hint}`;
  });
  const overflow = invocable.length - listed.length;
  const suffix = overflow > 0 ? `\n(${overflow} more not listed.)` : "";

  return {
    name: SKILL_TOOL_NAME,
    description:
      "Invoke an installed skill by name. The skill's instructions are loaded as this tool's result and direct the work that follows; follow them exactly. Available skills:\n" +
      (listed.length === 0 ? "(none installed)" : lines.join("\n")) +
      suffix,
    sideEffect: "read_only",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", description: "The skill name, e.g. \"commit-helper\". A leading '/' is accepted." },
        args: { type: "string", description: "Optional argument string passed to the skill's $ARGUMENTS placeholders." },
      },
      required: ["skill"],
      additionalProperties: false,
    },
    needsApproval: true,
    timeoutMs: 60_000,
    outputLimits: { maxBytes: 100_000, maxLines: 4_000 },
  };
}

/**
 * Fork skills ride the subagent tool's own admission: the delegate is the
 * mounted `delegate_subagent` port, so lineage, governance and cancellation
 * stay WP22's single implementation rather than a second spawn path.
 */
/** The one wording for a fork skill the run cannot fork: it is a terminal refusal, never inline fallback. */
function forkUnavailable(name: string): ToolOutcome {
  return {
    outcome: "error",
    code: "skill_fork_unavailable",
    message: `skill '${name}' declares 'context: fork'; forked skills need the subagent runtime (--subagent)`,
  };
}

export function createSkillForkExecutor(input: { readonly delegate: () => ToolPort | undefined }): SkillForkExecutor {
  return async (request) => {
    const port = input.delegate();
    if (port === undefined) {
      return forkUnavailable(request.name);
    }

    return port.execute(
      {
        toolCallId: request.toolCallId,
        name: SUBAGENT_TOOL_NAME,
        arguments: {
          taskName: `skill:${request.name}`,
          prompt: request.prompt,
          ...(request.allowedTools !== undefined && request.allowedTools.length > 0
            ? { allowedTools: [...request.allowedTools] }
            : {}),
        },
      },
      request.signal,
    );
  };
}
