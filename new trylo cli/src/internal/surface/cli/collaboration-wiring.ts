import { createCollaborationLearning } from "../../learning/domains/collaboration/index.js";
import { createFileCollaborationBoard } from "../../integration/collaboration-learning/board-port.js";
import { createCollaborationRuntime } from "../../integration/collaboration-learning/runtime.js";
import type { SubagentCollaborationPort } from "../../subagent/collaboration.js";
import type { TurnHostInput } from "./host.js";
import { methodBoardRoot } from "./learning-sink.js";
import type { ProviderPort } from "../../ports/provider.js";
import type { SubagentTeam } from "../../subagent/team.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { createCollaborationSubsystemV2 } from "../../learning/domains/collaboration/v2-service.js";
import { createCollaborationModelAnalyzerV2 } from "../../integration/collaboration-learning/model-analysis-v2.js";
import { createCollaborationSessionV2 } from "../../integration/collaboration-learning/session-v2.js";
import { DEFAULT_COLLABORATION_TOKENS, type CollaborationLearningOption } from "./collaboration-options.js";
import { randomUUID } from "node:crypto";

/** All is the existing explicit learning opt-in. Other learning domains remain unchanged. */
export function collaborationRuntimeFor(input: TurnHostInput): SubagentCollaborationPort | undefined {
  const host = input.learning;
  if (host?.switch !== "all" || input.subagentTeam === undefined) return undefined;

  const enabled = () => host.switch === "all";
  const now = () => new Date(input.now()).toISOString();

  return createCollaborationRuntime({
    learning: createCollaborationLearning({ board: createFileCollaborationBoard(methodBoardRoot(host.homeDir, host.env), enabled),
      now, collect: true }),
    scope: input.workspaceRoot, now, enabled,
    warn: reason => input.sink.stderr(`warning: ${reason}\n`),
  });
}

export type CollaborationLearningWiringV2 = {
  readonly choice?: CollaborationLearningOption | undefined;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly scope: string;
  readonly team: SubagentTeam;
  readonly turnId: string;
  readonly now: () => number;
  readonly signal?: AbortSignal;
  readonly warn: (reason: string) => void;
  readonly newOwnerId?: () => string;
};

/** Construct after the raw provider exists; analysis receives an isolated provider fork. */
export function collaborationSessionFor(input: CollaborationLearningWiringV2 | undefined, provider: ProviderPort, model: string) {
  if (input === undefined || input.choice === "off") return undefined;

  const enabled = () => input.choice !== "off";
  const now = () => new Date(input.now()).toISOString();
  const board = createFileCollaborationBoard(methodBoardRoot(input.homeDir, input.env), enabled);
  const newOwnerId = input.newOwnerId ?? randomUUID;
  const subsystem = createCollaborationSubsystemV2({ board, now, enabled, ownerId: newOwnerId(),
    analyzer: createCollaborationModelAnalyzerV2({ provider, model, enabled, nowMs: input.now }) });

  return createCollaborationSessionV2({ subsystem, scope: input.scope, team: input.team, turnId: input.turnId, resolvedModel: model, now, enabled,
    requestId: `daily-collaboration:${contentHashOf([input.scope, input.team.runId])}`,
    grant: { maxSteps: 4, maxModelCalls: 2, maxModelTokens: input.choice ?? DEFAULT_COLLABORATION_TOKENS, maxPromptChars: 1200 },
    ...(input.signal === undefined ? {} : { signal: input.signal }), warn: input.warn });
}
