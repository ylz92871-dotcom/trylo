import type { CapabilityDemand, ToolLibrary, ToolLibraryContext, ToolLibraryEntry, ToolLibraryFilter, ToolLibraryOptions } from "./contracts.js";
import { configurationBlock, resolveEntries } from "./resolution.js";

export function libraryFailure(code: string, message: string) { return { ok: false as const, code, message }; }

function validContext(context: ToolLibraryContext): boolean {
  return [context?.memberId, context?.scope].every(value => typeof value === "string" && value.trim().length > 0 && value.length <= 512);
}

function validIds(ids: readonly string[]): boolean {
  return Array.isArray(ids) && ids.length <= 256 && ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 1024);
}

/** Search is advisory; only exact capability/name matches may satisfy a capability demand automatically. */
function matches(entry: ToolLibraryEntry, filter: ToolLibraryFilter): boolean {
  if (filter.origin !== undefined && filter.origin !== entry.source.kind) return false;
  const terms = (filter.text ?? "").trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const text = [entry.id, entry.name, entry.description, ...entry.capabilities, entry.source.label].join(" ").toLocaleLowerCase();
  return terms.every(term => text.includes(term));
}

export function createToolLibrary(options: ToolLibraryOptions): ToolLibrary {
  // Resolve access and inventory together for one consistent scope.
  async function read(context: ToolLibraryContext) {
    if (!validContext(context)) return libraryFailure("invalid_context", "memberId and scope are required");

    const access = await options.access(context);
    if (!access.ok) return access;

    const entries: ToolLibraryEntry[] = [];

    for (const source of options.sources) {
      const result = await source.read(context);
      if (!result.ok) return result;
      entries.push(...result.value);
    }

    // Every source ID and runtime name must have one unambiguous owner.
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) return libraryFailure("duplicate_tool_id", "source adapters must publish unique tool identities");

    const names = access.value.tools.snapshot().map(binding => binding.name);
    if (new Set(names).size !== names.length) return libraryFailure("duplicate_runtime_name", "runtime tool names are ambiguous");

    return { ok: true as const, entries, access: access.value };
  }

  const resolve: ToolLibrary["resolve"] = async (context, ids) => {
    if (!validIds(ids)) return libraryFailure("invalid_selection", "select at most 256 whole tool IDs");
    const state = await read(context);
    return state.ok ? { ok: true, value: resolveEntries(state.entries, state.access, ids) } : state;
  };

  return {
    async query(context, filter = {}) {
      if ((filter.text?.length ?? 0) > 1024 || (filter.limit !== undefined && (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > 256))) return libraryFailure("invalid_filter", "query limit is 1–256 and text is bounded");

      const state = await read(context);
      if (!state.ok) return state;

      const selected = state.entries.filter(entry => matches(entry, filter)).sort((a, b) => a.id.localeCompare(b.id));

      return { ok: true, value: { formatVersion: 1, total: selected.length, items: selected.slice(0, filter.limit ?? 100).map(entry => {
        const reason = configurationBlock(entry, state.access);
        return { ...entry, configured: entry.runtimeName !== undefined && (state.access.configuredNames === undefined
          ? state.access.tools.snapshot().some(binding => binding.name === entry.runtimeName) : state.access.configuredNames.includes(entry.runtimeName)),
        configuration: reason === undefined ? "configurable" as const : "blocked" as const, ...(reason === undefined ? {} : { reason }) };
      }) } };
    },
    resolve,
    async resolveReferences(context, references) {
      if (!Array.isArray(references) || references.some(ref => typeof ref?.toolId !== "string" || typeof ref.runtimeName !== "string" || typeof ref.bindingHash !== "string")) return libraryFailure("invalid_reference", "runtime references are malformed");
      const result = await resolve(context, references.map(ref => ref.toolId));
      if (!result.ok) return result;
      // A changed binding requires a fresh resolution, even when its name survives.
      const stale = references.filter(ref => !result.value.references.some(current => current.toolId === ref.toolId && current.runtimeName === ref.runtimeName && current.bindingHash === ref.bindingHash));
      if (stale.length > 0) return libraryFailure("stale_reference", "tool binding changed; resolve the requested IDs again");
      return result;
    },
    async configure(context, ids) {
      if (options.configure === undefined) return libraryFailure("configuration_writer_unavailable", "host has not connected its existing member configuration writer");
      const result = await resolve(context, ids);
      if (!result.ok) return result;
      if (result.value.rejected.length > 0) return libraryFailure("selection_rejected", result.value.rejected.map(row => `${row.toolId}: ${row.code}`).join("; "));
      const saved = await options.configure(context, result.value.references.map(ref => ref.runtimeName));
      return saved.ok ? { ok: true, value: result.value.references } : saved;
    },
    async requestCapability(context, demand, signal) {
      if (!validDemand(demand)) return libraryFailure("invalid_demand", "requestKey, capability and taskId must be bounded nonempty strings");

      if (signal.aborted) return libraryFailure("cancelled", "capability request cancelled");

      const state = await read(context);
      if (!state.ok) return state;

      const capability = demand.capability.trim().toLocaleLowerCase();
      const target = demand.targetToolId === undefined ? undefined : state.entries.find(entry => entry.id === demand.targetToolId && entry.source.kind === "learned");
      if (demand.targetToolId !== undefined && target === undefined) return libraryFailure("revision_target_unavailable", "revision target must be an existing learned asset in this scope");

      // Only an exact advertised capability can satisfy the demand without learning.
      const ids = demand.targetToolId === undefined ? state.entries.filter(entry => [entry.name, ...entry.capabilities].some(value => value.toLocaleLowerCase() === capability)).map(entry => entry.id) : [];
      const existing = resolveEntries(state.entries, state.access, ids);
      if (existing.references.length > 0) return { ok: true, value: { kind: "existing", references: existing.references } };

      if (ids.length > 0) return libraryFailure("existing_capability_unavailable", existing.rejected.map(row => `${row.toolId}: ${row.code}`).join("; "));

      if (options.learning === undefined) return libraryFailure("learning_unavailable", "host has not connected the Board tool-learning adapter");

      const submitted = target?.source.reference === undefined ? demand : { ...demand, relatedRefs: [...(demand.relatedRefs ?? []), target.source.reference] };
      const result = await options.learning.request(context, submitted, signal);

      return result.ok ? { ok: true, value: { kind: "request", request: result.value } } : result;
    },
    async getRequest(context, requestId) {
      const access = validContext(context) ? await options.access(context) : libraryFailure("invalid_context", "member and scope are required");
      if (!access.ok) return access;

      if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 256) return libraryFailure("invalid_request_id", "request ID is invalid");

      if (options.learning === undefined) return libraryFailure("learning_unavailable", "host has not connected tool learning");

      const result = await options.learning.get(context, requestId);
      if (!result.ok) return result;

      // Completed learning is not runtime availability. Only return IDs that actually resolve now.
      const resolved = await resolve(context, result.value.toolIds);

      return resolved.ok ? { ok: true, value: { ...result.value, toolIds: resolved.value.references.map(ref => ref.toolId) } } : resolved;
    },
  };
}

function validDemand(demand: CapabilityDemand): boolean {
  return [demand?.requestKey, demand?.capability, demand?.taskId].every(value => typeof value === "string" && value.trim().length > 0 && value.length <= 512)
    && (demand.targetToolId === undefined || (typeof demand.targetToolId === "string" && demand.targetToolId.length > 0 && demand.targetToolId.length <= 512))
    && (demand.relatedRefs === undefined || (Array.isArray(demand.relatedRefs) && demand.relatedRefs.length <= 32 && demand.relatedRefs.every(ref => typeof ref === "string" && ref.length > 0 && ref.length <= 512)));
}
