import type { ExpertIdentity, ExpertRequest, ExpertUseScope } from "../../subagent/experts/index.js";

/** Read-only candidate projection. Instantiation and the original approval service still own admission. */
export function temporaryExpertIdentityForScope(request: ExpertRequest | undefined, useScope: ExpertUseScope): ExpertIdentity | undefined {
  if (!request?.configuration || !request.creationAuthorization
    || (request.state !== "awaiting_retention" && request.state !== "temporary")
    || request.useScope?.workspaceId !== useScope.workspaceId || request.useScope?.taskId !== useScope.taskId) return undefined;
  return { expertId: request.expertId, version: request.baseVersion + 1, experienceKey: request.experienceKey,
    draft: { requestId: request.requestId, revision: request.revision } };
}
