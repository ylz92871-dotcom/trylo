import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { LearnOptions } from "./args-learn.js";
import type { CliContext } from "./context.js";
import { tryloHome } from "./session-paths.js";

/** Independent entry: legacy deterministic V1 and the persistent autonomous V2 share the command family. */
export async function handleLearn(ctx: CliContext, options: LearnOptions): Promise<ExitCode> {
  if (options.subsystem === "central") return (await import("./commands-central-learning.js")).handleCentralLearning(ctx, options);

  if (options.subsystem === "feedback") return (await import("./commands-feedback-read.js")).handleFeedbackRead(ctx, options);

  if ("readOnly" in options) return (await import("./commands-agent-learning-read.js")).handleAgentLearningRead(ctx, options);

  if (options.subsystem === "skill" && "nativeMethod" in options) return (await import("./commands-skill-native.js")).handleSkillNative(ctx, options);

  if (options.subsystem === "skill" && "explicit" in options) return (await import("./commands-skill-explicit.js")).handleSkillExplicit(ctx);

  if (options.subsystem === "skill") return "control" in options
    ? (await import("./commands-skill-control.js")).handleSkillControl(ctx, options)
    : (await import("./commands-hermes-skill.js")).handleHermesSkillLearn(ctx, options);

  if (options.subsystem === "check") return (await import("./commands-check-learning.js")).handleCheckLearning(ctx, options);

  if ("control" in options) return (await import("./commands-collaboration-issues.js")).handleCollaborationIssues(ctx, options);

  if ("operation" in options) return (await import("./commands-collaboration-governance.js")).handleCollaborationGovernance(ctx, options);

  if (!("maxEpisodes" in options)) return (await import("./commands-learn-v2.js")).handlePersistentLearn(ctx, options);

  const { createFileCollaborationBoard } = await import("../../integration/collaboration-learning/board-port.js");
  const { createCollaborationLearning } = await import("../../learning/domains/collaboration/index.js");
  const board = createFileCollaborationBoard(`${tryloHome(ctx.homeDir, ctx.env)}/learning/board`);
  const learning = createCollaborationLearning({ board, now: () => new Date(ctx.now()).toISOString() });
  const result = await learning.invoke({ subsystem: options.subsystem,
    budget: { maxEpisodes: options.maxEpisodes, maxPromptChars: options.maxPromptChars } });

  ctx.stdout(`${JSON.stringify(result)}\n`);

  return result.ok ? EXIT_CODES.OK : EXIT_CODES.EXECUTION_FAILURE;
}
