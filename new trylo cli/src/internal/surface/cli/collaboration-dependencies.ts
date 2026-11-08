import type { createCollaborationControl, CollaborationCentralWorker } from "../../learning/agent/subsystems/collaboration/control/index.js";
import { isCollaborationPlan } from "../../learning/agent/subsystems/collaboration/orchestration/index.js";
import type { CollaborationCapabilities } from "./collaboration-capabilities.js";
import type { BoardStore } from "../../learning/control/store-port.js";

/** PA requests consent; only a centrally claimed worker may spend the associated construction budget. */
export function collaborationDependencies(options: { readonly scope: string; readonly taskId: string;
  readonly board: Pick<BoardStore, "load">; readonly control: ReturnType<typeof createCollaborationControl>;
  readonly capabilities: CollaborationCapabilities }) {
  const context = (signal: AbortSignal) => ({ signal, useScope: { workspaceId: options.scope, taskId: options.taskId } });
  return {
    async request(dependencyId: string, signal: AbortSignal) {
      const current = await options.control.read(options.scope);
      if (!current.ok) return current;

      const dependency = current.dependencies.find(d => d.dependencyId === dependencyId);
      const issue = current.issues.find(i => i.issueId === dependency?.issueId);
      if (!dependency || issue?.decision.kind !== "focused_learning") return { ok: false, reason: "dependency_no_longer_needed" };

      const loaded = await options.board.load();
      if (!loaded.ok) return loaded;

      const [versionId, indexText] = dependency.correlationRef.split("#need:");
      const asset = loaded.state.assets.find(a => a.scope === options.scope && a.versionId === versionId);
      if (!asset || !isCollaborationPlan(asset.content)) return { ok: false, reason: "dependency_plan_missing" };

      const need = asset.content.needs[Number(indexText)];
      if (!need || need.owner !== dependency.owner) return { ok: false, reason: "dependency_plan_invalid" };

      if (need.owner === "expert") {
        const library = options.capabilities.expertHost.library;
        let request = dependency.requestId ? library.request(dependency.requestId) : await library.submitRequest({ origin: "personal_agent",
          ...(need.expertId === undefined ? {} : { expertId: need.expertId }),
          requestId: `expert-${dependency.dependencyId.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
          instruction: need.instruction, association: { issueId: issue.issueId, jobId: dependency.jobId,
            grantId: dependency.grantId, correlationRef: dependency.correlationRef } }, context(signal));
        if (dependency.requestId && request.state === "awaiting_creation") request = await library.authorizeCreation(request.requestId, context(signal));

        const state = request.state === "authorized" || request.state === "revision_requested"
          ? { kind: "authorized" as const, authorizationRef: request.creationAuthorization! }
          : request.state === "rejected" ? { kind: "rejected" as const, reason: "user_declined_expert_creation" }
          : ["awaiting_retention", "temporary", "saved"].includes(request.state) ? { kind: "ready" as const,
              resultRef: request.requestId, resultVersion: String(request.revision), evidenceRefs: [request.creationAuthorization!] }
          : { kind: "waiting" as const, reason: "awaiting_user_creation_consent" };

        return options.control.updateDependency({ dependencyId, expectedRevision: dependency.revision, requestId: request.requestId, state });
      }

      const library = options.capabilities.toolLibrary;
      const response = dependency.requestId
        ? await library.getRequest({ memberId: need.memberId, scope: options.scope }, dependency.requestId)
        : await library.requestCapability({ memberId: need.memberId, scope: options.scope }, { requestKey: dependency.dependencyId,
          capability: need.instruction, taskId: options.taskId,
          relatedRefs: [issue.issueId, dependency.jobId, dependency.grantId, dependency.correlationRef] }, signal);
      if (!response.ok) return response;

      if ("kind" in response.value && response.value.kind === "existing") return options.control.updateDependency({
        dependencyId, expectedRevision: dependency.revision, state: { kind: "ready", resultRef: dependency.correlationRef,
          resultVersion: response.value.references.map(r => r.bindingHash).join(":"), evidenceRefs: response.value.references.map(r => r.toolId) } });

      const request = "kind" in response.value && response.value.kind === "request" ? response.value.request
        : "requestId" in response.value ? response.value : undefined;
      if (!request) return { ok: false, reason: "tool_request_invalid" };

      return options.control.updateDependency({ dependencyId, expectedRevision: dependency.revision, requestId: request.requestId,
        state: request.assetVersionId && request.toolIds.length ? { kind: "ready", resultRef: request.assetVersionId,
          resultVersion: request.assetVersionId, evidenceRefs: request.toolIds }
          : ["failed", "cancelled", "rejected"].includes(request.state) ? { kind: "failed", reason: request.reason ?? request.state }
          : { kind: "waiting", reason: request.reason ?? request.state } });
    },

    async prepare(input: Parameters<CollaborationCentralWorker["run"]>[0]) {
      const resultRefs: string[] = [];

      for (const dependency of input.dependencies) {
        if (dependency.state.kind !== "authorized") continue;

        if (dependency.owner !== "expert" || !dependency.requestId) return { ok: false as const, reason: "authorized_dependency_unsupported" };

        const request = await options.capabilities.buildExpert(dependency.requestId, input.funding, input.signal);
        if (!request.configuration || !["awaiting_retention", "temporary", "saved"].includes(request.state)) return { ok: false as const, reason: "expert_build_not_ready" };

        const observed = await options.control.updateDependency({ dependencyId: dependency.dependencyId, expectedRevision: dependency.revision,
          state: { kind: "ready", resultRef: request.requestId, resultVersion: String(request.revision), evidenceRefs: [request.creationAuthorization!] } });
        if (!observed.ok) return observed;

        resultRefs.push(request.requestId);
      }

      return { ok: true as const, resultRefs };
    },
  };
}
