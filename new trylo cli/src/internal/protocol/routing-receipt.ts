/** Additive v1 wire receipt. It describes an actual execution choice, never grants authority. */
export type CliRoutingReceipt = {
  readonly schemaVersion: 1;
  readonly decisionPoint: string;
  readonly executionId: string;
  readonly candidateIds: readonly string[];
  readonly selectedPath: string;
  readonly actualPath: string;
  readonly reason: string;
  readonly versionId?: string;
  readonly outcome?: string;
  readonly cost?: { readonly tokens?: number; readonly bytesRead?: number; readonly latencyMs?: number };
  readonly diagnostics: readonly string[];
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identity(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256; }

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }

function quantity(value: unknown, integer: boolean): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12 && (!integer || Number.isSafeInteger(value));
}

export function isCliRoutingReceipt(value: unknown): value is CliRoutingReceipt {
  if (!record(value) || !keys(value, ["schemaVersion", "decisionPoint", "executionId", "candidateIds", "selectedPath", "actualPath", "reason", "versionId", "outcome", "cost", "diagnostics"])
    || value.schemaVersion !== 1 || !identity(value.decisionPoint) || !identity(value.executionId)
    || !identity(value.selectedPath) || !identity(value.actualPath) || !identity(value.reason)
    || (value.versionId !== undefined && !identity(value.versionId)) || (value.outcome !== undefined && !identity(value.outcome))
    || !Array.isArray(value.candidateIds) || value.candidateIds.length < 1 || value.candidateIds.length > 8
    || !value.candidateIds.every(identity) || new Set(value.candidateIds).size !== value.candidateIds.length
    || !value.candidateIds.includes(value.selectedPath) || !value.candidateIds.includes(value.actualPath)
    || !Array.isArray(value.diagnostics) || value.diagnostics.length > 16 || !value.diagnostics.every(identity)) return false;

  if (value.cost === undefined) return true;

  return record(value.cost) && keys(value.cost, ["tokens", "bytesRead", "latencyMs"])
    && Object.keys(value.cost).length > 0 && (value.cost.tokens === undefined || quantity(value.cost.tokens, true))
    && (value.cost.bytesRead === undefined || quantity(value.cost.bytesRead, true))
    && (value.cost.latencyMs === undefined || quantity(value.cost.latencyMs, false));
}

/** Normalize only existing execution receipts; omitted costs remain unknown. */
export function projectRoutingReceipt(toolName: string, toolValue: unknown): CliRoutingReceipt | undefined {
  if (!record(toolValue) || !record(toolValue.routing)) return undefined;

  const raw = toolValue.routing;
  const decision = record(raw.decision) ? raw.decision : raw;
  const decisionPoint = toolName === "read_file" ? "read_file.strategy.v1" : toolName === "spawn_agent" ? "subagent.context.v1" : undefined;
  if (decisionPoint === undefined) return undefined;

  const candidateIds = raw.candidateIds ?? decision.candidateIds;
  const receipt = { schemaVersion: 1, decisionPoint,
    executionId: raw.executionId ?? raw.selectionExecutionId, candidateIds,
    selectedPath: decision.path, actualPath: raw.actualPath, reason: decision.reason,
    ...(decision.versionId === undefined ? {} : { versionId: decision.versionId }),
    ...(raw.outcome === undefined ? {} : { outcome: raw.outcome }),
    ...(raw.bytesRead === undefined && raw.latencyMs === undefined ? {} : { cost: {
      ...(raw.bytesRead === undefined ? {} : { bytesRead: raw.bytesRead }),
      ...(raw.latencyMs === undefined ? {} : { latencyMs: raw.latencyMs }),
    } }), diagnostics: raw.diagnostics };

  return isCliRoutingReceipt(receipt) ? receipt : undefined;
}
