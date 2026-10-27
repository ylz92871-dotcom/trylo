/** Desktop's reading of additive CLI budget facts; no dependency on CLI code. */
export interface SubagentBudget {
  readonly tokenLimit: number;
  readonly tokensUsed: number;
  readonly tokensRemaining: number;
  readonly timeoutMs: number;
  readonly timeRemainingMs: number;
  readonly timeoutMode: 'wall' | 'active';
}
export type SubagentInputMode = 'append' | 'replace_queued' | 'restart';
export type SendSubagentInput = (agentId: string, text: string, mode?: SubagentInputMode) => Promise<void>;

export type SubagentToolActivity =
  | { readonly id: string; readonly kind: 'tool'; readonly tool: string }
  | { readonly id: string; readonly kind: 'result'; readonly tool?: string; readonly ok: boolean };

export function isSubagentToolActivity(value: unknown): value is SubagentToolActivity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && row.id.length > 0
    && (row.kind === 'tool' ? typeof row.tool === 'string' && row.tool.length > 0
      : row.kind === 'result' && typeof row.ok === 'boolean' && (row.tool === undefined || typeof row.tool === 'string'));
}

export function isSubagentBudget(value: unknown): value is SubagentBudget {
  if (value === null || typeof value !== 'object') return false;
  const budget = value as Record<string, unknown>;
  return ['tokenLimit', 'tokensUsed', 'tokensRemaining', 'timeoutMs', 'timeRemainingMs']
    .every(key => { const count = budget[key]; return typeof count === 'number' && Number.isFinite(count) && count >= 0; })
    && (budget.timeoutMode === 'active' || budget.timeoutMode === 'wall');
}
