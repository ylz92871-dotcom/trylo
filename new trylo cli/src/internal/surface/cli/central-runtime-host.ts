import type { CentralRuntimeDriver } from "../../adapters/central-learning-runtime/index.js";
import type { CentralLearningConfiguration, CentralRuntimeExecutionPort } from "../../learning/central/runtime/contracts.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { ensureCentralLearningBudget } from "../../integration/central-learning/budget.js";
import { createCentralLearningDriver } from "../../integration/central-learning/runtime-driver.js";
import { createCentralModelDeliberation } from "../../integration/central-learning/deliberation.js";
import { CENTRAL_SINGLE_ACTION_VERSION } from "../../integration/central-learning/change-single-action-version.js";
import { centralGenerationLimits } from "../../integration/central-learning/deliberation-generation.js";
import { createCentralDeliberationReceiptsAtRoot } from "../../integration/central-learning/deliberation-receipts.js";
import { createCentralRuntimeOrganization } from "../../integration/central-learning/runtime-organization.js";
import { createCentralRuntimeSource } from "../../integration/central-learning/runtime-source.js";
import { createCentralAccountingFundingAtRoot } from "../../integration/learning-content/central-accounting-funding.js";
import { createUserPeerRuntimeAdapter } from "../../integration/user-learning/index.js";
import { createUserLearningPeerFor } from "./user-learning-config.js";
import { createCentralRuntimeDomains } from "./central-runtime-domains.js";
import { createCentralRuntimeMaterials } from "./central-runtime-materials.js";
import { centralRuntimeSources } from "./central-runtime-sources.js";
import { centralRuntimeProvider } from "./central-runtime-provider.js";
import { isCentralRuntimeConfiguration } from "./central-runtime-configuration.js";
import { createCentralRuntimeContextReader } from "../../integration/central-learning/runtime-context.js";
import { centralLearningGenerationRef, centralLearningModelRef, centralLearningProviderConnectionRef } from "./central-learning-model.js";
import { createCentralRuntimeReadWorkspaceAccess } from "./central-runtime-read-access.js";
import { createRuntimeCentralAdvisoryPublisher } from "../../integration/central-learning/runtime-central-advisory-publication.js";
import { createRuntimeCentralAdvisoryContext } from "../../integration/central-learning/runtime-central-advisory-context.js";
import { createCentralRuntimeAdvisoryAccess } from "./central-runtime-advisory-access.js";
import type { CliContext } from "./context.js";
import { centralRuntimeResultSignal } from "./central-runtime-signal.js";

/** Independent CLI process composition. No business Execution Loop, session writer, team or approval channel is borrowed. */
export async function createCentralRuntimeHost(ctx: CliContext, supplied: unknown) {
  if (!isCentralRuntimeConfiguration(supplied)) throw new Error("runtime_configuration_invalid");

  const readAccess = createCentralRuntimeReadWorkspaceAccess(ctx);
  if (readAccess.identity !== undefined) ctx = { ...ctx, get workspaceIdentity() { return readAccess.identity!; } };

  let open = true;
  const enabled = () => open, now = () => new Date(ctx.now()).toISOString();
  const sourceFactories = centralRuntimeSources(ctx, supplied.workspaceId, { maximumChars: supplied.allowance.maxPromptChars, enabled,
    readWorkspaceAccess: readAccess.snapshot });
  const authorizationRef = supplied.rootRef?.authorizationRef
    ?? `central-run-authorization:${contentHashOf({ scope: ctx.cwd, allowance: supplied.allowance })}`;
  const ready = await ensureCentralLearningBudget({ boardRoot: sourceFactories.boardRoot, scope: ctx.cwd,
    allowance: supplied.allowance, authorizationRef, enabled, now,
    ...(supplied.rootRef === undefined ? {} : { rootRef: supplied.rootRef }) });
  if (!ready.ok) throw new Error(ready.reason);

  const configuration = { ...supplied, rootRef: ready.rootRef };
  // Operation envelope stays bounded. rootRef separately restores the cumulative managed authorization and real spending.
  const allowance = supplied.allowance;
  const connection = centralRuntimeProvider(ctx, configuration);
  if (!connection.ok) throw new Error(connection.reason);

  // Prefer the existing decision tool's typed schema. JSON-object mode only
  // promises valid JSON and is a fallback for connections without tool support.
  const outputMode = connection.capabilities.tools ? "action_tool" : "action_json";
  const generationLimits = centralGenerationLimits(undefined, configuration.generationLimits);

  if (!connection.capabilities.tools && !connection.provider.responseFormats?.includes("json_object")) {
    throw new Error("central_deliberation_output_capability_unavailable");
  }

  const bound = { boardRoot: sourceFactories.boardRoot, scope: ctx.cwd, budgetId: ready.projection.budget.budgetId, now, enabled };
  const centralFunding = createCentralAccountingFundingAtRoot({ ...bound,
    owner: { kind: "central_deliberation", ownerId: `central-runtime:${contentHashOf(ctx.cwd)}` } });
  const sources = createCentralRuntimeMaterials({ ctx, workspaceId: configuration.workspaceId, enabled, secrets: connection.secrets });
  const advisoryOptions = { boardRoot: bound.boardRoot, scope: ctx.cwd, enabled, secrets: connection.secrets,
    access: createCentralRuntimeAdvisoryAccess({ ctx, workspaceId: configuration.workspaceId, enabled, secrets: connection.secrets }) };
  const advisoryContext = createRuntimeCentralAdvisoryContext(advisoryOptions);
  const advisories = { ...createRuntimeCentralAdvisoryPublisher(advisoryOptions), recall: advisoryContext.recall };
  const contextForIssue = createCentralRuntimeContextReader({ boardRoot: bound.boardRoot, scope: ctx.cwd, enabled,
    fallback: sourceFactories.contextForIssue });
  const domains = createCentralRuntimeDomains({ ctx, boardRoot: bound.boardRoot, scope: ctx.cwd,
    compatibleScopes: sourceFactories.compatibleScopes,
    readCompatibleScopes: sourceFactories.readCompatibleScopes,
    workspaceId: configuration.workspaceId, provider: connection.provider, model: connection.model,
    ...(connection.capabilities.contextWindow === undefined ? {} : { contextWindow: connection.capabilities.contextWindow }),
    connection: connection.connection,
    modelRef: centralLearningModelRef(connection.connection),
    maxOutputTokens: generationLimits.defaultMaxOutputTokens,
    allowance, authorizationRef, rootRef: ready.rootRef, contextForIssue, enabled,
    readResearchFeedback: sourceFactories.domainFeedback,
    readResearchMaterials: (refs, maximumChars, signal) => source.read(ctx.cwd, refs, maximumChars, signal) });
  const user = !configuration.userLearning ? undefined : createUserPeerRuntimeAdapter(createUserLearningPeerFor({
    homeDir: ctx.homeDir, env: ctx.env, workspaceId: configuration.workspaceId, now: ctx.now,
    warn: reason => ctx.stderr(`warning: user_learning:${reason}\n`) }, { provider: connection.provider, model: connection.model,
    maxOutputTokens: generationLimits.maxOutputTokens, enabled, fundingOwnerId: ctx.cwd,
    funding: createCentralAccountingFundingAtRoot({ ...bound, owner: { kind: "user_learning", ownerId: ctx.cwd } }) }));
  const source = createCentralRuntimeSource({ boardRoot: bound.boardRoot, scope: ctx.cwd, ports: domains.ports,
    enabled, secrets: connection.secrets, domainFeedback: sourceFactories.domainFeedback,
    providerConnection: { providerId: connection.providerId, model: connection.model, decisionFormat: outputMode,
      decisionVersion: CENTRAL_SINGLE_ACTION_VERSION,
      providerConnectionRef: centralLearningProviderConnectionRef(connection.connection) },
    compatibleScopes: sourceFactories.compatibleScopes,
    readCompatibleScopes: sourceFactories.readCompatibleScopes,
    nativeFeedbackChanges: sourceFactories.nativeFeedbackChanges,
    pageReader: sources.pageReader,
    peerReadContracts: user === undefined ? [] : [user.readContract.version],
    peerSources: [sources, advisoryContext.source, ...(user === undefined ? [] : [user.source])] });
  const execution: CentralRuntimeExecutionPort = {
    consult: input => input.subject.plane === "user" && user !== undefined ? user.execution.consult(input) : domains.execution.consult(input),

    prepare: input => {
      const forUser = input.intent.subject.plane === "user"
        || input.intent.subject.plane === "central" && input.operation.destination?.plane === "user";
      if (forUser) {
        if (user === undefined) throw new Error("user_learning_not_enabled");
        return user.execution.prepare(input);
      }

      return domains.execution.prepare(input);
    },

    execute: (work, signal) => work.frame.kind === "user_learning" && user !== undefined ? user.execution.execute(work, signal) : domains.execution.execute(work, signal),
    recover: (work, signal) => work.frame.kind === "user_learning" && user !== undefined ? user.execution.recover(work, signal) : domains.execution.recover(work, signal),
  };
  const core = createCentralLearningDriver({ ...bound, source, execution, advisories,
    deliberation: createCentralModelDeliberation({ provider: connection.provider, model: connection.model,
      outputMode,
      generationLimits,
      ...(connection.capabilities.contextWindow === undefined ? {} : { contextWindow: connection.capabilities.contextWindow }),
      funding: centralFunding, enabled, secrets: connection.secrets,
      receipts: createCentralDeliberationReceiptsAtRoot({ ...bound, secrets: connection.secrets }) }),
    organization: createCentralRuntimeOrganization({ boardRoot: bound.boardRoot, scope: ctx.cwd,
      workspaceId: configuration.workspaceId, enabled, secrets: connection.secrets }) });
  const semantic: CentralLearningConfiguration = { schemaVersion: 1, configurationRef: `runtime-configuration:${contentHashOf(configuration)}`,
    providerConnectionRef: centralLearningProviderConnectionRef(connection.connection),
    generationRef: centralLearningGenerationRef(connection.connection, { maxOutputTokens: generationLimits.defaultMaxOutputTokens,
      maxSelectableOutputTokens: generationLimits.maxOutputTokens }),
    generationLimits,
    authorizationRef, allowance, rootRef: ready.rootRef,
    ...(configuration.thoughtMaxTokens === undefined ? {} : { thoughtMaxTokens: configuration.thoughtMaxTokens }) };
  let publishedProviderWait = false;
  const driver: CentralRuntimeDriver = {
    drive: async input => {
      readAccess.observeSourceWorkspaceRoots(input.wake.sourceWorkspaceRoots ?? []);
      const result = await core.drive({ scope: input.scope.workspaceRoot, configuration: semantic, wake: input.wake,
        signal: input.signal, publish: progress => input.publish({ message: progress.reason, state: progress.state,
          sourceRefs: progress.sourceRefs.slice(0, 32), ...(progress.wakeAt === undefined ? {} : { wakeAt: progress.wakeAt }) }) });
      const providerWait = connection.connection.accountId === undefined ? undefined : result.providerWait;
      if (providerWait !== undefined || publishedProviderWait) input.publish({ message: result.reason,
        sourceRefs: result.sourceRefs.slice(0, 32), ...(providerWait === undefined ? {} : { providerWait }) });

      publishedProviderWait = providerWait !== undefined;

      return centralRuntimeResultSignal(result);
    },

    async close() {
      open = false;
      await core.close?.();
      await domains.close();
    },
  };

  return { configuration, driver };
}
