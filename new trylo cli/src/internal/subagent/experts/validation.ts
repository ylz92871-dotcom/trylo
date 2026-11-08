import { ExpertLibraryError } from "./contracts.js";
import type { ExpertConfiguration, ExpertLibrarySnapshot, ExpertRequest, ExpertRequestAssociation } from "./contracts.js";

type Row = Record<string, unknown>;

const row = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 8000): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const list = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 64 && v.every(x => text(x));
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const roles = ["person", "architect", "worker", "reviewer", "verifier", "cad-planner", "cad-verifier"];
const states = ["awaiting_creation", "authorized", "awaiting_retention", "revision_requested", "saved", "temporary", "rejected"];
const fields = ["displayName", "specialty", "situations", "responsibilities", "constraints", "collaboration", "baseRole", "role", "toolRefs", "methods", "sources"];

export function validateConfiguration(value: unknown): ExpertConfiguration {
  if (!row(value) || !Object.keys(value).every(key => fields.includes(key))
    || !text(value.displayName, 24) || !text(value.specialty, 1000) || !roles.includes(String(value.baseRole))
    || !list(value.situations) || value.situations.length === 0 || !list(value.responsibilities) || value.responsibilities.length === 0
    || !list(value.constraints) || !list(value.collaboration) || !list(value.toolRefs)
    || !validRole(value.role) || value.role.name !== value.baseRole
    || !Array.isArray(value.sources) || value.sources.length > 32 || !value.sources.every(validSource)
    || !Array.isArray(value.methods) || value.methods.length === 0 || value.methods.length > 32
    || !value.methods.every(method => row(method) && text(method.title, 200) && text(method.instructions)
      && list(method.sourceUris) && method.sourceUris.length > 0 && method.sourceUris.every(uri => Array.isArray(value.sources) && value.sources.some((source: unknown) => row(source) && source.uri === uri)))) {
    throw new ExpertLibraryError("invalid_input", "Invalid expert configuration or method without a real source association");
  }
  return value as ExpertConfiguration;
}

function validSource(v: unknown): boolean {
  return row(v) && ["official", "community", "installed_skill", "user"].includes(String(v.kind))
    && text(v.title, 500) && text(v.uri, 2000) && text(v.excerpt, 8000)
    && (v.kind !== "official" && v.kind !== "community" || /^https?:\/\//.test(String(v.uri)));
}

function validRole(v: unknown): v is Row {
  if (!row(v) || !text(v.name, 200) || !text(v.description, 2000)) return false;
  const allowed = ["name", "description", "prompt", "model", "allowedTools", "disallowedTools", "skills", "maxIterations", "nicknameCandidates"];
  if (!Object.keys(v).every(key => allowed.includes(key))) return false;
  return ["prompt", "model"].every(key => v[key] === undefined || text(v[key]))
    && ["allowedTools", "disallowedTools", "skills", "nicknameCandidates"].every(key => v[key] === undefined || list(v[key]))
    && (v.maxIterations === undefined || integer(v.maxIterations) && v.maxIterations > 0);
}

export function validateEdits(value: unknown): Partial<ExpertConfiguration> {
  if (!row(value) || !Object.keys(value).every(key => fields.includes(key))) throw new ExpertLibraryError("invalid_input", "Unknown expert edit field");

  for (const [key, item] of Object.entries(value)) {
    const valid = key === "displayName" ? text(item, 24) : key === "specialty" ? text(item, 1000)
      : key === "baseRole" ? roles.includes(String(item)) : key === "role" ? validRole(item)
        : key === "sources" ? Array.isArray(item) && item.length <= 32 && item.every(validSource)
          : key === "methods" ? Array.isArray(item) && item.length > 0 && item.length <= 32 && item.every(m => row(m) && text(m.title, 200) && text(m.instructions) && list(m.sourceUris) && m.sourceUris.length > 0)
            : list(item);
    if (!valid) throw new ExpertLibraryError("invalid_input", `Invalid expert edit field: ${key}`);
  }

  return value as Partial<ExpertConfiguration>;
}

export function validateAssociation(value: unknown): ExpertRequestAssociation {
  if (!row(value) || !Object.keys(value).every(key => ["issueId", "jobId", "grantId", "correlationRef"].includes(key))
    || !Object.values(value).every(item => text(item, 250))) throw new ExpertLibraryError("invalid_input", "Invalid expert request association");
  return value as ExpertRequestAssociation;
}

function validRequest(v: unknown): v is ExpertRequest {
  if (!row(v) || !text(v.requestId, 200) || !text(v.expertId, 200) || !text(v.experienceKey, 250)
    || !["settings", "personal_agent", "collaboration"].includes(String(v.origin)) || !text(v.instruction)
    || !integer(v.baseVersion) || !integer(v.revision) || !integer(v.createdAt)
    || !states.includes(String(v.state)) || !row(v.userEdits)) return false;

  validateEdits(v.userEdits);

  if (v.association !== undefined) validateAssociation(v.association);

  if (v.useScope !== undefined && (!row(v.useScope) || !text(v.useScope.workspaceId, 250) || !text(v.useScope.taskId, 250))) return false;

  if (v.preparation !== undefined && !["build", "reuse_configuration"].includes(String(v.preparation))) return false;

  if (v.preparation === "reuse_configuration" && (v.baseVersion === 0 || v.configuration === undefined)) return false;

  if (v.configuration !== undefined) {
    validateConfiguration(v.configuration);
    validateConfiguration({ ...v.configuration, ...v.userEdits });
  }

  if (v.creationAuthorization !== undefined && !text(v.creationAuthorization)) return false;

  if (["awaiting_retention", "revision_requested", "saved", "temporary"].includes(String(v.state)) && v.configuration === undefined) return false;

  if (["authorized", "awaiting_retention", "revision_requested", "saved", "temporary"].includes(String(v.state)) && !text(v.creationAuthorization)) return false;

  return (v.feedback === undefined || text(v.feedback)) && (v.retentionAuthorization === undefined || text(v.retentionAuthorization))
    && (v.state !== "saved" || text(v.retentionAuthorization));
}

export function validateRequest(value: unknown): ExpertRequest {
  if (!validRequest(value)) throw new ExpertLibraryError("invalid_input", "Invalid expert request");
  return value;
}

export function validateVersion(value: unknown): import("./contracts.js").ExpertVersion {
  if (!row(value) || !text(value.expertId, 200) || !text(value.experienceKey, 250) || !integer(value.version) || value.version < 1
    || !integer(value.createdAt) || !text(value.requestId, 200) || value.draft !== undefined) throw new ExpertLibraryError("invalid_input", "Invalid expert version");
  validateConfiguration(value.configuration);
  return value as import("./contracts.js").ExpertVersion;
}

/** Persisted state is validated before becoming authoritative; no legacy schema is guessed. */
export function validateSnapshot(value: unknown): ExpertLibrarySnapshot {
  if (!row(value) || value.schemaVersion !== 1 || !integer(value.sequence) || !Array.isArray(value.experts) || !Array.isArray(value.requests)
    || !value.requests.every(validRequest)) throw new ExpertLibraryError("invalid_input", "Invalid expert library snapshot");

  const requests = value.requests;
  const expertsValid = value.experts.every(expert => row(expert) && text(expert.expertId, 200) && text(expert.experienceKey, 250)
    && ["active", "archived"].includes(String(expert.status)) && Array.isArray(expert.versions) && expert.versions.length > 0
    && expert.versions.every((version: unknown, index: number) => {
      if (!row(version) || version.expertId !== expert.expertId || version.experienceKey !== expert.experienceKey || version.version !== index + 1
        || !integer(version.createdAt) || !text(version.requestId, 200)) return false;
      validateConfiguration(version.configuration);
      return requests.some(request => request.requestId === version.requestId && request.state === "saved"
        && request.expertId === expert.expertId && request.baseVersion === index && request.experienceKey === expert.experienceKey
        && sameValue(request.configuration, version.configuration));
    }));
  if (!expertsValid || new Set(requests.map(r => r.requestId)).size !== requests.length
    || new Set(value.experts.map(e => row(e) ? e.expertId : "")).size !== value.experts.length) throw new ExpertLibraryError("invalid_input", "Invalid expert identity/version relationships");

  const keys = new Map<string, string>();

  for (const entry of [...requests, ...value.experts]) {
    if (keys.has(entry.expertId) && keys.get(entry.expertId) !== entry.experienceKey) throw new ExpertLibraryError("invalid_input", "Expert experience attribution changed");
    keys.set(entry.expertId, entry.experienceKey);
  }

  if (new Set(keys.values()).size !== keys.size) throw new ExpertLibraryError("invalid_input", "Experience key belongs to more than one expert");

  return value as ExpertLibrarySnapshot;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  if (!row(a) || !row(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}
