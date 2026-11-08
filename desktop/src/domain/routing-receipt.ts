/** Desktop's bounded projection of the additive CLI routing receipt. */
export const ROUTING_RECEIPT_SCHEMA = 'trylo.routing.v1';

export interface RoutingReceipt {
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
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function strings(value: unknown, limit: number): value is string[] {
  return Array.isArray(value) && value.length <= limit && value.every(boundedString);
}

function cost(value: unknown): boolean {
  return record(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, amount]) =>
    ['tokens', 'bytesRead', 'latencyMs'].includes(key)
    && typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 && amount <= 1e12
    && (key === 'latencyMs' || Number.isSafeInteger(amount)));
}

/** Reject unknown authority or oversized payloads rather than interpreting them. */
export function isRoutingReceipt(value: unknown): value is RoutingReceipt {
  if (!record(value)) return false;
  const keys = ['schemaVersion', 'decisionPoint', 'executionId', 'candidateIds', 'selectedPath', 'actualPath',
    'reason', 'versionId', 'outcome', 'cost', 'diagnostics'];
  return Object.keys(value).every(key => keys.includes(key))
    && value.schemaVersion === 1
    && ['decisionPoint', 'executionId', 'selectedPath', 'actualPath', 'reason'].every(key => boundedString(value[key]))
    && strings(value.candidateIds, 8)
    && new Set(value.candidateIds).size === value.candidateIds.length
    && value.candidateIds.some(id => id === value.selectedPath)
    && value.candidateIds.some(id => id === value.actualPath)
    && strings(value.diagnostics, 16)
    && (value.versionId === undefined || boundedString(value.versionId))
    && (value.outcome === undefined || boundedString(value.outcome))
    && (value.cost === undefined || cost(value.cost));
}
