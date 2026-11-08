import type { RunScaffold } from "./run-command.js";
import type { CentralLearningOption } from "./central-learning-options.js";
import { isReasoningEffort, type ReasoningEffort } from "../../ports/provider.js";
import { isCentralLearningAllowance } from "../../learning/control/coordination-parse.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { fields, identity } from "../../validation/json-shape.js";
import { runtimeRecord } from "../../adapters/central-learning-runtime/contracts.js";
import type { CentralLearningBudgetRootRef } from "../../learning/control/central-budget-contract.js";
import { isCentralLearningBudgetRootRef } from "../../learning/control/central-budget-parse.js";
import { isPublicCentralRuntimeEndpoint } from "./central-runtime-endpoint.js";
import { isCentralThoughtMaxTokens } from "../../learning/central/runtime/validation.js";
import { isCentralGenerationLimits, type CentralGenerationLimits } from "../../learning/central/runtime/generation.js";

/** Public connection choice and references. Credentials stay in the original resolver, never this intent. */
export type CentralRuntimeConfiguration = {
  readonly schemaVersion: 1; readonly providerId: string; readonly model: string;
  readonly endpointHash: string; readonly endpoint?: string; readonly accountId?: string; readonly reasoningEffort?: ReasoningEffort;
  readonly workspaceId: string; readonly allowance: CentralLearningOption; readonly userLearning: boolean;
  readonly thoughtMaxTokens?: number;
  readonly generationLimits?: CentralGenerationLimits;
  readonly rootRef?: CentralLearningBudgetRootRef;
};

export function centralRuntimeConfiguration(scaffold: RunScaffold): CentralRuntimeConfiguration | undefined {
  if (scaffold.endpoint !== "" && !isPublicCentralRuntimeEndpoint(scaffold.endpoint, scaffold.apiKey)) return undefined;
  return scaffold.centralLearning === undefined ? undefined : { schemaVersion: 1, providerId: scaffold.providerId,
    model: scaffold.model, endpointHash: contentHashOf(scaffold.endpoint), workspaceId: scaffold.workspaceId,
    ...(scaffold.endpoint === "" ? {} : { endpoint: scaffold.endpoint }),
    allowance: scaffold.centralLearning, userLearning: scaffold.learning === "user" || scaffold.learning === "all",
    ...(scaffold.centralLearningThoughtMaxTokens === undefined ? {} : { thoughtMaxTokens: scaffold.centralLearningThoughtMaxTokens }),
    ...(scaffold.accountId === undefined ? {} : { accountId: scaffold.accountId }),
    ...(scaffold.reasoningEffort === undefined ? {} : { reasoningEffort: scaffold.reasoningEffort }) };
}

export function isCentralRuntimeConfiguration(value: unknown): value is CentralRuntimeConfiguration {
  if (!runtimeRecord(value)) return false;

  const keys = ["schemaVersion", "providerId", "model", "endpointHash", "workspaceId", "allowance", "userLearning",
    ...(value.endpoint === undefined ? [] : ["endpoint"]),
    ...(value.rootRef === undefined ? [] : ["rootRef"]),
    ...(value.thoughtMaxTokens === undefined ? [] : ["thoughtMaxTokens"]),
    ...(value.generationLimits === undefined ? [] : ["generationLimits"]),
    ...(value.accountId === undefined ? [] : ["accountId"]), ...(value.reasoningEffort === undefined ? [] : ["reasoningEffort"])];

  return fields(value, keys) && value.schemaVersion === 1 && identity(value.providerId) && identity(value.model)
    && identity(value.endpointHash) && identity(value.workspaceId) && isCentralLearningAllowance(value.allowance)
    && typeof value.userLearning === "boolean" && (value.accountId === undefined || identity(value.accountId))
    && (value.endpoint === undefined || isPublicCentralRuntimeEndpoint(value.endpoint) && contentHashOf(value.endpoint) === value.endpointHash)
    && (value.rootRef === undefined || isCentralLearningBudgetRootRef(value.rootRef))
    && (value.thoughtMaxTokens === undefined || isCentralThoughtMaxTokens(value.thoughtMaxTokens))
    && (value.generationLimits === undefined || isCentralGenerationLimits(value.generationLimits))
    && (value.reasoningEffort === undefined || typeof value.reasoningEffort === "string" && isReasoningEffort(value.reasoningEffort));
}
