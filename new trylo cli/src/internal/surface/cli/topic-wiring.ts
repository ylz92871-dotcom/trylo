import type { TurnHostInput } from "./host.js";
import { createTopicLearningRuntime, type TopicLearningRuntime } from "../../integration/learning-topics/runtime.js";
import { isLearningSwitch, switchEnablesMethod, switchEnablesTool } from "../../integration/user-learning/switch.js";
import { createMethodLearningWiring, methodBoardRoot } from "./learning-sink.js";
import { workspaceIdentity } from "./wiring-catalog.js";
import { createTopicLearningSystem } from "../../integration/learning-topics/system.js";
import { createDefaultReadTopicConfiguration } from "../../learning/agent/subsystems/tool/read-strategy/index.js";
import { createUserStatementTopicProjector } from "../../integration/learning-topics/semantic-evidence.js";
import { isLegacyBootstrapText } from "./user-input-source.js";
import { toolReadStrategyEnabled } from "./tool-read-strategy.js";

function topicSwitchEnabled(value: string | undefined): boolean {
  return isLearningSwitch(value) && (switchEnablesMethod(value) || switchEnablesTool(value));
}

/** Each enabled domain may use the shared topic channel; strict response schemas retain their format. */
export function topicRuntimeFor(input: TurnHostInput): TopicLearningRuntime | undefined {
  if (input.learning === undefined || !topicSwitchEnabled(input.learning.switch) || input.responseSchema !== undefined) return undefined;

  const learning = createMethodLearningWiring(input.learning, { now: () => new Date(input.now()).toISOString(),
    warn: message => input.sink.stderr(`warning: ${message}\n`) });
  const boardRoot = methodBoardRoot(learning.homeDir, learning.env), scope = workspaceIdentity(input.workspaceRoot);
  const enabled = () => topicSwitchEnabled(input.learning?.switch);

  try {
    if (input.topicLearning !== undefined && input.readTopicPool !== undefined) throw new Error("topic_pool_configuration_conflict");

    const authoredUserSource = input.userSourceAvailable !== false && !isLegacyBootstrapText(input.text);
    const secrets = input.apiKey === undefined ? [] : [input.apiKey];
    const userStatement = createUserStatementTopicProjector({
      collect: () => enabled() && input.userLearning !== undefined && authoredUserSource,
      secrets,
    });
    const toolEnabled = toolReadStrategyEnabled(input);
    const local = input.topicLearning === undefined && toolEnabled
      ? createDefaultReadTopicConfiguration({ boardRoot, scope, collect: () => toolReadStrategyEnabled(input), nowMs: input.now,
        ...(input.readTopicPool === undefined ? {} : { pool: input.readTopicPool }) }) : undefined;
    const baseConfiguration = input.topicLearning ?? local?.configuration;
    if (input.topicBindings !== undefined && baseConfiguration?.bindings !== undefined
      && input.topicBindings !== baseConfiguration.bindings) throw new Error("topic_binding_source_conflict");

    const configuration = baseConfiguration === undefined ? undefined : input.topicBindings === undefined ? baseConfiguration
      : { ...baseConfiguration, bindings: input.topicBindings };
    const control = configuration === undefined ? undefined : {
      system: createTopicLearningSystem({ boardRoot, scope, enabled, configuration }),
      requestId: `turn:${input.sessionId}:${input.turnId}`, totalQuota: configuration.perTurnQuota,
    };

    return createTopicLearningRuntime({ boardRoot, scope, sessionId: input.sessionId, turnId: input.turnId, enabled, secrets, emit: learning.emit,

      projectEvidence(event) {
        const admitted = input.topicEvidence?.(event);
        if (admitted?.origin === "user_statement" && !authoredUserSource) return undefined;
        return admitted ?? userStatement(event);
      },

      ...(local === undefined ? {} : { offerReadOpportunity: local.offer, bindReadRuntime: local.bindRuntime }),
      ...(control === undefined ? {} : { control }) });
  } catch {
    // An invalid learning binding disables this optional path, never the user's execution turn.
    try { input.sink.stderr("topic_learning_degraded: configuration_unavailable\n"); }
    catch { /* A broken diagnostic sink cannot turn a learning setup failure into a task failure. */ }
    return undefined;
  }
}
