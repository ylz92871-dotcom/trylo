import type { CliContext } from "./context.js";
import type { ProviderPort } from "../../ports/provider.js";
import type { CentralLearningAllowance } from "../../learning/control/coordination-contract.js";
import type { CentralLearningContextReader } from "../../learning/control/source-context.js";
import type { SkillDailyConnection } from "./skill-daily-provider.js";
import type { ContentDomainFeedbackReader } from "../../integration/learning-content/sources/domain-feedback.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { CentralLearningBudgetRootRef } from "../../learning/control/central-budget-contract.js";

/** Supplied by the independent scope owner. No business session, Team or caller
 * cancellation signal becomes the lifetime of these research workers. */
export type CentralRuntimeDomainsInput = {
  readonly ctx: CliContext;
  readonly boardRoot: string;
  readonly scope: string;
  readonly workspaceId: string;
  /** The source owner's physical identity descriptor grants read-only aliases.
   * Domain actors, grants and dispatch continue to use scope above. */
  readonly compatibleScopes?: readonly string[];
  readonly readCompatibleScopes?: () => readonly string[];
  readonly provider: ProviderPort;
  readonly model: string;
  readonly modelRef: string;
  /** Declared technical input-plus-output ceiling of this connection. */
  readonly contextWindow?: number;
  /** Explicit host generation allocation, kept across native tool forks. */
  readonly maxOutputTokens?: number;
  readonly allowance: CentralLearningAllowance;
  readonly authorizationRef: string;
  readonly rootRef?: CentralLearningBudgetRootRef;
  readonly connection: SkillDailyConnection;
  readonly contextForIssue: CentralLearningContextReader;
  /** Original factual owner; native units count only after their body was actually read. */
  readonly readResearchFeedback?: ContentDomainFeedbackReader;
  readonly readResearchMaterials?: (refs: readonly string[], maximumChars: number, signal: AbortSignal) => Promise<readonly CentralRuntimeMaterial[]>;
  readonly enabled: () => boolean;
};
