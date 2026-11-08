import type { ParsedCommand } from "./args-primitives.js";
import { usageError } from "./args-tokens.js";
import { familyHelpCommand } from "./usage.js";
import { parseCheckLearn, type CheckLearnOptions } from "./args-check-learning.js";
import { parseCollaborationGovernance, type CollaborationGovernanceOptions } from "./args-collaboration-governance.js";
import { retiredRoutingInput } from "./retired-routing.js";
import { parseHermesSkillLearn, type HermesSkillLearnOptions } from "./args-hermes-skill.js";
import { parseCollaborationIssues, type CollaborationIssueOptions } from "./args-collaboration-issues.js";
import { parseAgentLearningRead, type AgentLearningReadOptions } from "./args-agent-learning-read.js";
import { parseFeedbackRead, type FeedbackReadOptions } from "./args-feedback-read.js";
import { parseCentralLearning, type CentralLearningCommandOptions } from "./args-central-learning.js";

export type LegacyLearnOptions = {
  readonly subsystem: "collaboration";
  readonly maxEpisodes: number;
  readonly maxPromptChars: number;
};

export type PersistentLearnOptions = { readonly subsystem: "collaboration"; readonly resume: boolean;
  readonly grant: import("../../learning/domains/collaboration/v2-contracts.js").CollaborationGrantV2 };

export type LearnOptions = LegacyLearnOptions | PersistentLearnOptions | CheckLearnOptions | CollaborationGovernanceOptions | CollaborationIssueOptions | HermesSkillLearnOptions | AgentLearningReadOptions | FeedbackReadOptions | CentralLearningCommandOptions;

const HINT = "try `trylo learn skill --tokens N --calls N`; collaboration: --tokens <0..1000000> or --resume; legacy: --budget <0..256>";

/** A caller allocates work; episode selection and analysis belong to the subsystem. */
export function parseLearn(argv: readonly string[]): ParsedCommand {
  if (argv[0] === "central") return parseCentralLearning(argv.slice(1));

  if (argv[0] === "routing") return retiredRoutingInput();

  if (argv.includes("--help") || argv.includes("-h")) return familyHelpCommand("learn");

  if (argv[0] === "feedback") return parseFeedbackRead(argv.slice(1));

  if (argv[0] === "inspect") return parseAgentLearningRead(argv.slice(1));

  if (argv[0] === "skill") return parseHermesSkillLearn(argv.slice(1));

  if (argv[0] === "check") return parseCheckLearn(argv.slice(1));

  if (argv[0] !== "collaboration") return usageError("learn requires the skill, collaboration or check subsystem", HINT);

  if (argv[1] === "issues" || argv[1] === "coordinate") return parseCollaborationIssues(argv.slice(1));

  if (argv[1] === "status" || argv[1] === "correct") return parseCollaborationGovernance(argv.slice(1));

  if (argv.includes("--tokens") || argv.includes("--resume")) return parsePersistent(argv.slice(1));

  const values = new Map<string, number>();

  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]!;
    const raw = argv[index + 1];
    const limit = flag === "--budget" ? 256 : flag === "--prompt-chars" ? 4000 : undefined;
    if (limit === undefined || values.has(flag) || raw === undefined || !/^\d+$/.test(raw)
      || !Number.isSafeInteger(Number(raw)) || Number(raw) > limit) {
      return usageError("invalid or duplicate learning budget option", HINT);
    }

    values.set(flag, Number(raw));
  }

  const maxEpisodes = values.get("--budget");
  if (maxEpisodes === undefined) return usageError("learn requires an explicit --budget", HINT);

  return { kind: "learn", options: { subsystem: "collaboration", maxEpisodes,
    maxPromptChars: values.get("--prompt-chars") ?? 1200 } };
}

function parsePersistent(argv: readonly string[]): ParsedCommand {
  if (argv.length === 1 && argv[0] === "--resume") return { kind: "learn", options: {
    subsystem: "collaboration", resume: true,
    grant: { maxSteps: 0, maxModelCalls: 0, maxModelTokens: 0, maxPromptChars: 1200 } } };

  const limits: Readonly<Record<string, number>> = { "--tokens": 1000000, "--calls": 16, "--steps": 64, "--prompt-chars": 100000 };
  const values = new Map<string, number>();

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]!, raw = argv[index + 1], limit = limits[flag];
    if (limit === undefined || values.has(flag) || raw === undefined || !/^\d+$/.test(raw)
      || !Number.isSafeInteger(Number(raw)) || Number(raw) > limit) return usageError("invalid or duplicate persistent learning allowance", HINT);
    values.set(flag, Number(raw));
  }

  const maxModelTokens = values.get("--tokens");
  if (maxModelTokens === undefined) return usageError("persistent learning requires --tokens", HINT);

  return { kind: "learn", options: { subsystem: "collaboration", resume: false,
    grant: { maxModelTokens, maxModelCalls: values.get("--calls") ?? 2, maxSteps: values.get("--steps") ?? 4,
      maxPromptChars: values.get("--prompt-chars") ?? 40000 } } };
}
