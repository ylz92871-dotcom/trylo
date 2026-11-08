import type { SubagentMemberConfigurationMetadata } from "./member-configuration.js";

/** A recovery locator and exact-version evidence, never a serialized tool, role or grant. */
export type SubagentConfigurationCheckpoint = Pick<SubagentMemberConfigurationMetadata,
  "configurationRef" | "configurationVersion" | "identity" | "experienceVersionIds" | "profileId"> & {
  readonly boundary: "composition" | "handoff";
  readonly expertAdoption?: { readonly runId: string; readonly memberId: string; readonly boundary: "composition" | "handoff" };
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 512;
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const boundary = (value: unknown) => value === "composition" || value === "handoff";

export function isSubagentConfigurationCheckpoint(value: unknown): value is SubagentConfigurationCheckpoint {
  if (!record(value) || !only(value, ["configurationRef", "configurationVersion", "identity", "experienceVersionIds", "profileId", "boundary", "expertAdoption"])
    || !text(value.configurationRef) || !text(value.configurationVersion) || !boundary(value.boundary)
    || value.profileId !== undefined && !text(value.profileId) || !record(value.identity)) return false;

  const identity = value.identity, draft = identity.draft, adoption = value.expertAdoption;

  return only(identity, ["expertId", "version", "experienceKey", "draft"]) && text(identity.expertId) && positive(identity.version) && text(identity.experienceKey)
    && (draft === undefined || record(draft) && only(draft, ["requestId", "revision"]) && text(draft.requestId) && positive(draft.revision))
    && Array.isArray(value.experienceVersionIds) && value.experienceVersionIds.length <= 32 && value.experienceVersionIds.every(text)
    && (adoption === undefined || record(adoption) && only(adoption, ["runId", "memberId", "boundary"])
      && text(adoption.runId) && text(adoption.memberId) && adoption.boundary === value.boundary);
}

export function configurationCheckpoint(metadata: SubagentMemberConfigurationMetadata): SubagentConfigurationCheckpoint | undefined {
  const originalBoundary = metadata.boundary ?? metadata.expertAdoption?.boundary;
  if (originalBoundary === undefined) return undefined;

  return { configurationRef: metadata.configurationRef, configurationVersion: metadata.configurationVersion, boundary: originalBoundary,
    identity: { expertId: metadata.identity.expertId, version: metadata.identity.version, experienceKey: metadata.identity.experienceKey,
      ...(metadata.identity.draft === undefined ? {} : { draft: { requestId: metadata.identity.draft.requestId, revision: metadata.identity.draft.revision } }) },
    experienceVersionIds: [...metadata.experienceVersionIds], ...(metadata.profileId === undefined ? {} : { profileId: metadata.profileId }),
    ...(metadata.expertAdoption === undefined ? {} : { expertAdoption: { runId: metadata.expertAdoption.runId,
      memberId: metadata.expertAdoption.memberId, boundary: metadata.expertAdoption.boundary } }) };
}

export function matchesConfigurationCheckpoint(metadata: SubagentMemberConfigurationMetadata, saved: SubagentConfigurationCheckpoint): boolean {
  const current = configurationCheckpoint(metadata);
  return current !== undefined && current.configurationRef === saved.configurationRef && current.configurationVersion === saved.configurationVersion
    && current.boundary === saved.boundary && current.profileId === saved.profileId
    && current.identity.expertId === saved.identity.expertId && current.identity.version === saved.identity.version
    && current.identity.experienceKey === saved.identity.experienceKey && current.identity.draft?.requestId === saved.identity.draft?.requestId
    && current.identity.draft?.revision === saved.identity.draft?.revision
    && JSON.stringify(current.experienceVersionIds) === JSON.stringify(saved.experienceVersionIds)
    && current.expertAdoption?.runId === saved.expertAdoption?.runId && current.expertAdoption?.memberId === saved.expertAdoption?.memberId
    && current.expertAdoption?.boundary === saved.expertAdoption?.boundary;
}
