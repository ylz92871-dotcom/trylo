import { shouldInsertInTaskCognition } from './cognition-insert';
import type { UserLearningRuntime } from './runtime';
import type {
  CognitionSession,
  LearningDirective,
  ProductSurface,
  UserLearningSettings,
} from './types';

export interface LearningInteractionInput {
  readonly workspaceRoot: string;
  readonly conversationId: string;
  readonly turnId?: string;
  readonly product: ProductSurface;
  readonly prompt: string;
  readonly baseSystemPrompt?: string;
  readonly explicitInstruction?: string;
  readonly settings: UserLearningSettings;
  readonly hasPendingLearningUi: boolean;
  readonly learningDirective?: LearningDirective;
}

export interface LearningInteractionResult {
  readonly prepared: ReturnType<UserLearningRuntime['preparePrompt']>;
  readonly cognition?: CognitionSession;
}

/**
 * The single product-neutral pre-send coordinator for Code and Work.
 *
 * Required Impact/approval remains blocking through `prepared.start`.
 * Optional in-task Cognition is created only after a ready decision and never
 * changes the run start state. React owns only the returned session's view.
 */
export function prepareLearningInteraction(
  runtime: UserLearningRuntime,
  input: LearningInteractionInput,
): LearningInteractionResult {
  const prepared = runtime.preparePrompt({
    workspaceRoot: input.workspaceRoot,
    product: input.product,
    prompt: input.prompt,
    baseSystemPrompt: input.baseSystemPrompt,
    explicitInstruction: input.explicitInstruction,
    conversationId: input.conversationId,
    turnId: input.turnId,
  });

  if (
    prepared.start !== 'ready'
    || input.settings.userLearningV2Coordinator === false
    || input.learningDirective?.collectNewLearning === false
  ) return { prepared };

  const question = runtime.maybeCognitionPrompt({
    prompt: input.prompt,
    product: input.product,
    conversationId: input.conversationId,
  });
  if (!shouldInsertInTaskCognition({
    settings: input.settings,
    preparedStart: prepared.start,
    pendingCardOnThisConversation: input.hasPendingLearningUi,
    question,
  }) || !question) {
    return { prepared };
  }

  return {
    prepared,
    cognition: runtime.startCognition(
      question,
      input.workspaceRoot,
      input.product,
      input.conversationId,
    ),
  };
}
