import type { CollaborationCapabilities } from "./collaboration-capabilities.js";
import type { CollaborationResourcePort } from "../../learning/agent/subsystems/collaboration/orchestration/index.js";
import type { CollaborationExperienceStore, PrepareExperienceInput } from "../../learning/agent/subsystems/collaboration/experience/index.js";
import type { CollaborationResourceReceipt, CollaborationRuntimeReceipt } from "../../protocol/collaboration-resource.js";
import { COLLABORATION_RESOURCE_LIMITS } from "../../protocol/collaboration-resource.js";
import { discoverCollaborationTools, discoverCollaborationExperience, discoverCollaborationExperts } from "../../learning/agent/subsystems/collaboration/resources/index.js";

export function collaborationResources(options: {
  readonly capabilities: CollaborationCapabilities; readonly experience: CollaborationExperienceStore;
  readonly owners: (issueId?: string) => Promise<readonly { readonly ref: string; readonly input: PrepareExperienceInput }[]>;
  readonly record: (receipt: CollaborationRuntimeReceipt) => Promise<{ readonly ok: boolean; readonly reason?: string }>;
  readonly now: () => string;
  readonly currentTeamRunId?: string | undefined;
}): CollaborationResourcePort {
  return { async query(input) {
    const base = { schemaVersion: 1 as const, scope: input.issue.scope, issueId: input.issue.issueId, jobId: input.jobId,
      grantId: input.grantId, requestId: input.requestId, owner: input.owner, query: input.query,
      boundary: { executionId: `learning:${input.jobId}`, taskId: input.issue.issueId, round: 1, role: "collaboration_learning" } };
    const query: CollaborationResourceReceipt = { ...base, phase: "resource_query", receiptId: `${input.requestId}:query`,
      resultRefs: [], summary: "Resource query requested by the collaboration loop", recordedAt: options.now() };
    const recorded = await options.record(query);
    if (!recorded.ok) return { ok: false, reason: recorded.reason ?? "resource_receipt_unavailable" };

    let summary: unknown, resultRefs: string[] = [], unavailable = false;

    try {
      if (input.signal.aborted) return { ok: false, reason: "learning_aborted" };
      switch (input.owner) {
        case "tool": {
          const result = await discoverCollaborationTools(options.capabilities.toolLibrary, { ...input, currentTeamRunId: options.currentTeamRunId });
          summary = result;
          resultRefs = [...result.sourceRefs];
          unavailable = !result.catalog.result.ok || result.memberViews.some(view => view.binding === "current_team" && !view.result.ok);
          break;
        }
        case "expert": {
          const result = discoverCollaborationExperts(options.capabilities.expertHost.library, { query: input.query });
          summary = result;
          resultRefs = [...result.sourceRefs];
          break;
        }
        case "experience": {
          const result = await discoverCollaborationExperience(options.experience, { ...input, owners: await options.owners(input.issue.issueId) });
          resultRefs = [...result.sourceRefs];
          unavailable = result.ownerViews.some(view => !view.ok);
          summary = result;
          break;
        }
        case "research": {
          const url = /^https?:\/\/\S+$/.test(input.query);
          const outcome = await options.capabilities.executeAuthorized({ toolCallId: input.requestId,
            name: url ? "web_fetch" : "web_search", arguments: url ? { url: input.query } : { query: input.query } }, input.signal);

          summary = outcome;

          if (outcome.outcome === "result") {
            resultRefs.push(`tool-result:${input.requestId}`);
            if (typeof outcome.value.url === "string") resultRefs.push(outcome.value.url);
          } else unavailable = true;

          break;
        }
      }
    } catch (error) {
      summary = { unavailable: error instanceof Error ? error.message : "Resource unavailable" };
      unavailable = true;
    }

    const result: CollaborationResourceReceipt = { ...base, phase: "resource_result", receiptId: `${input.requestId}:result`,
      resultRefs: [...new Set(resultRefs)], summary: JSON.stringify(summary).slice(0, COLLABORATION_RESOURCE_LIMITS.summaryMaxChars),
      status: unavailable ? "unavailable" : resultRefs.length ? "available" : "empty", recordedAt: options.now() };
    const persisted = await options.record(result);

    return persisted.ok ? { ok: true, summary, sourceRefs: [result.receiptId, ...result.resultRefs] }
      : { ok: false, reason: persisted.reason ?? "resource_receipt_unavailable" };
  } };
}
