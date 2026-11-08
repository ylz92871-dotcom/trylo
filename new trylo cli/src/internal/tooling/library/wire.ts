import type { CapabilityRequest, CapabilityResponse, LibraryResult, ToolLibraryCatalog, ToolLibraryEntry, ToolRuntimeReference } from "./contracts.js";

function record(raw: unknown): raw is Record<string, unknown> { return raw !== null && typeof raw === "object" && !Array.isArray(raw); }

function text(raw: unknown): raw is string { return typeof raw === "string" && raw.length > 0 && raw.length <= 8192; }

function strings(raw: unknown): raw is string[] { return Array.isArray(raw) && raw.length <= 256 && raw.every(text); }

function entry(raw: unknown): raw is ToolLibraryEntry {
  return record(raw) && text(raw.id) && text(raw.name) && typeof raw.description === "string" && raw.description.length <= 65536 && strings(raw.capabilities)
    && record(raw.source) && ["builtin", "mcp", "plugin", "learned", "external"].includes(String(raw.source.kind)) && text(raw.source.label)
    && (raw.source.reference === undefined || text(raw.source.reference)) && (raw.source.version === undefined || text(raw.source.version))
    && record(raw.availability) && (raw.availability.state === "available" || (["unavailable", "unknown"].includes(String(raw.availability.state)) && text(raw.availability.reason)))
    && (raw.runtimeName === undefined || text(raw.runtimeName)) && (raw.lifecycle === undefined || text(raw.lifecycle));
}

export function isToolLibraryCatalog(raw: unknown): raw is ToolLibraryCatalog {
  return record(raw) && raw.formatVersion === 1 && Array.isArray(raw.items) && raw.items.length <= 256
    && typeof raw.total === "number" && Number.isSafeInteger(raw.total) && raw.total >= raw.items.length
    && raw.items.every(item => record(item) && typeof item.configured === "boolean" && ["configurable", "blocked"].includes(String(item.configuration))
      && (item.reason === undefined || text(item.reason)) && entry(item)) && new Set(raw.items.map(item => item.id)).size === raw.items.length;
}

export function isToolRuntimeReferences(raw: unknown): raw is readonly ToolRuntimeReference[] {
  return Array.isArray(raw) && raw.length <= 256 && raw.every(item => record(item) && text(item.toolId) && text(item.runtimeName)
    && typeof item.bindingHash === "string" && /^[a-f0-9]{64}$/.test(item.bindingHash));
}

export function isCapabilityRequest(raw: unknown): raw is CapabilityRequest {
  return record(raw) && text(raw.requestId) && text(raw.state) && text(raw.capability) && strings(raw.toolIds)
    && (raw.reason === undefined || text(raw.reason)) && (raw.assetVersionId === undefined || text(raw.assetVersionId)) && (raw.relatedRefs === undefined || strings(raw.relatedRefs));
}

export function isCapabilityResponse(raw: unknown): raw is CapabilityResponse {
  return record(raw) && ((raw.kind === "existing" && isToolRuntimeReferences(raw.references)) || (raw.kind === "request" && isCapabilityRequest(raw.request)));
}

export function decodeLibraryResult<T>(raw: unknown, accepts: (value: unknown) => value is T): LibraryResult<T> {
  if (record(raw) && raw.ok === true && accepts(raw.value)) return { ok: true, value: raw.value };
  if (record(raw) && raw.ok === false && text(raw.code) && text(raw.message)) return { ok: false, code: raw.code, message: raw.message };
  return { ok: false, code: "invalid_library_reply", message: "工具库响应格式不受支持，请刷新或检查宿主连接。" };
}
