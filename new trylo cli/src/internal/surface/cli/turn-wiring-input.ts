import type { LocalRuleLookup } from "../../adapters/project-instructions/appendix.js";
import type { MemoryReadPort } from "../../ports/memory.js";
import type { UserLearningRuntime, UserMemoryService } from "../../integration/user-learning/index.js";
import type { ToolGapRuntime } from "../../integration/tool-learning/index.js";
import type { McpRuntime } from "../../adapters/mcp-runtime/index.js";
import type { SubagentEventSink } from "../../subagent/index.js";
import { createMethodLearningWiring } from "./learning-sink.js";
import type { TurnHostInput } from "./host.js";
import type { WiringInput } from "./wiring.js";
import { agentMessages } from "./agent-instructions.js";

/**
 * Everything `wirePorts` is told, assembled in one place.
 *
 * A function rather than a spread because the mapping is a real translation: an
 * absent `--learning` switch must reach the wiring as an absent field, never as
 * `false`, because that difference is the difference between a run that
 * constructs nothing and a run that constructs an empty board (I1).
 *
 * The host owns the clock — the wiring and the loop never read one — and the
 * method subsystem is lent a clock and a place to report a failed write only
 * when a `--learning` switch actually opened one.
 */
export function turnWiringInput(
  input: TurnHostInput,
  mcp: McpRuntime | undefined,
  userLearning: UserLearningRuntime | undefined,
  toolGap: ToolGapRuntime | undefined,
  subagentEventSink?: SubagentEventSink | undefined,
  localRules?: LocalRuleLookup | undefined,
  memory?: MemoryReadPort | undefined,
  memoryWrite?: UserMemoryService | undefined,
): WiringInput {
  return {
    turnId: input.turnId,
    ...(input.toolSelection === undefined ? {} : { toolSelection: input.toolSelection }),
    ...(input.resumeRecords === undefined ? {} : { workflowRecords: input.resumeRecords }),
    ...(input.questions === undefined ? {} : { questions: input.questions }),
    ...(input.execution === undefined ? {} : { execution: input.execution }),
    providerId: input.providerId,
    ...(input.providerKind === undefined ? {} : { providerKind: input.providerKind }),
    ...(input.reasoningSummary === undefined ? {} : { reasoningSummary: input.reasoningSummary }),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    model: input.model,
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    ...(input.tokenManager === undefined ? {} : { tokenManager: input.tokenManager }),
    ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
    ...(input.warm === undefined ? {} : { warm: input.warm }),
    workspaceRoot: input.workspaceRoot,
    ...(input.fileAccess === undefined ? {} : { fileAccess: input.fileAccess }),
    checkpointRoot: input.checkpointRoot,
    permission: input.permission,
    ...(input.execPolicy === undefined ? {} : { execPolicy: input.execPolicy }),
    ...(input.grants === undefined ? {} : { grants: input.grants }),
    nowMs: input.now(),
    ...(mcp === undefined ? {} : { mcp: { tools: mcp.tools, toolNames: mcp.toolNames } }),
    ...(userLearning === undefined ? {} : { userLearning }),
    ...(toolGap === undefined ? {} : { toolGap }),
    ...(input.permissionLedger === undefined ? {} : { permissionLedger: input.permissionLedger }),
    allowWeb: input.allowWeb === true,
    ...(input.web === undefined ? {} : { web: input.web }),
    ...(memory === undefined ? {} : { memory }),
    ...(memoryWrite === undefined ? {} : { memoryWrite }),
    // Lent straight through: the surface that owns the terminal owns the words,
    // and nothing between it and the loop is allowed to hold a second copy.
    ...(input.pendingInput === undefined ? {} : { pendingInput: input.pendingInput }),
    ...(localRules === undefined ? {} : { localRules }),
    callerMessages: agentMessages(input.projectContext?.messages),
    ...(input.skills === undefined ? {} : { skills: input.skills }),
    ...(input.compactSummary === undefined ? {} : { compactSummary: input.compactSummary }),
    // WP12 L60: already-validated servers ride straight through, the roles
    // precedent — absent means the catalog never heard of navigation.
    ...(input.lspServers === undefined ? {} : { languageServers: input.lspServers }),
    // WP05 C06/C07: same ride-through; absent is the direct path.
    ...(input.shellMode === undefined ? {} : { shellMode: input.shellMode }),
    ...(subagentEventSink === undefined
      ? {}
      : {
          subagent: {
            // Two doors, one switch: the fixture provider is the offline test
            // path, `--subagent` is the opt-in for every real provider.
            enabled: input.providerId === "fixture-subagent" || input.subagentEnabled === true,
            onEvent: subagentEventSink,
            // C44/L27: absent means no agent_type is offered and the spawn
            // tool's text is exactly what it was before roles existed.
            ...(input.subagentRoles === undefined ? {} : { roles: input.subagentRoles }),
          },
        }),
    ...(input.learning === undefined
      ? {}
      : {
          learning: createMethodLearningWiring(input.learning, {
            now: () => new Date(input.now()).toISOString(),
            warn: (message) => input.sink.stderr(`warning: ${message}\n`),
          }),
        }),
  };
}
