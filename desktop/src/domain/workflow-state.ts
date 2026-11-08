/** Desktop's versioned wire projection. The CLI remains the execution owner. */
export interface WorkflowState {
  readonly type: 'workflow_state';
  readonly version: 1;
  readonly workflowVersionId: string;
  readonly traceId: string;
  readonly sessionId: string;
  readonly executionId?: string;
  readonly branchId?: string;
  readonly state: 'running' | 'waiting' | 'cancelled' | 'budget_exhausted' | 'interrupted' | 'completed' | 'failed';
  readonly outcome: 'success' | 'failure' | 'unknown';
  readonly steps: readonly { readonly nodeId: string; readonly status: 'passed' | 'failed'; readonly input: string; readonly output: string; readonly evidenceRefs: readonly string[];
    readonly dependsOn?: readonly string[]; readonly inputBindings?: Readonly<Record<string, string>>; readonly outputDigest?: string; readonly recoveryTo?: string }[];
  readonly cost?: { readonly tokens: number; readonly wallMs: number };
  readonly budgetReceipt?: { readonly initialTokens: number; readonly grantedTokens: number; readonly observedOutputTokens: number;
    readonly reservedUnknownTokens: number; readonly remainingTokens: number; readonly usageUncertain: boolean };
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096; }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function texts(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 128 && value.every(text) && new Set(value).size === value.length; }
function bindings(value: unknown): boolean { return object(value) && Object.keys(value).length <= 128 && Object.entries(value).every(([key, item]) => text(key) && text(item)); }
function persistedFact(value: unknown): string | undefined {
  return JSON.stringify(object(value) ? Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0) : value);
}
function validBudget(value: unknown): boolean {
  if (!object(value) || !count(value.initialTokens) || value.initialTokens === 0 || !count(value.grantedTokens)
    || !count(value.observedOutputTokens) || !count(value.reservedUnknownTokens) || !count(value.remainingTokens) || typeof value.usageUncertain !== 'boolean') return false;
  const total = value.initialTokens + value.grantedTokens;
  return Number.isSafeInteger(total) && value.remainingTokens === Math.max(0, total - value.observedOutputTokens - value.reservedUnknownTokens);
}
export function isWorkflowState(value: unknown): value is WorkflowState {
  if (!object(value) || value.type !== 'workflow_state' || value.version !== 1
    || !text(value.workflowVersionId) || !text(value.traceId) || !text(value.sessionId)
    || !['running', 'waiting', 'cancelled', 'budget_exhausted', 'interrupted', 'completed', 'failed'].includes(String(value.state))
    || !['success', 'failure', 'unknown'].includes(String(value.outcome)) || (value.branchId !== undefined && !text(value.branchId))
    || (value.executionId !== undefined && !text(value.executionId)) || (value.budgetReceipt !== undefined && !validBudget(value.budgetReceipt))
    || !Array.isArray(value.steps) || value.steps.length > 2048) return false;
  if (!value.steps.every(step => object(step) && text(step.nodeId) && text(step.input) && text(step.output)
    && (step.status === 'passed' || step.status === 'failed') && texts(step.evidenceRefs) && step.evidenceRefs.length > 0
    && (step.dependsOn === undefined || texts(step.dependsOn)) && (step.inputBindings === undefined || bindings(step.inputBindings))
    && (step.outputDigest === undefined || (typeof step.outputDigest === 'string' && /^[a-f0-9]{64}$/.test(step.outputDigest)))
    && (step.recoveryTo === undefined || text(step.recoveryTo)))) return false;
  if (value.outcome === 'success') {
    if (value.state !== 'completed' || value.steps.length === 0) return false;
    const latest = new Map(value.steps.map(step => [step.nodeId, step.status]));
    if ([...latest.values()].some(status => status !== 'passed')) return false;
  }
  return value.cost === undefined || (object(value.cost) && count(value.cost.tokens) && count(value.cost.wallMs));
}
export function workflowStateLabel(state: WorkflowState): string {
  if (state.outcome === 'success') return '流程检查已通过';
  if (state.state === 'completed') return state.outcome === 'failure' ? '执行结束，流程检查未通过' : '执行结束，流程检查未完成';
  return ({ running: '流程执行中', waiting: '流程等待中', cancelled: '流程已取消', budget_exhausted: '流程额度已用完',
    interrupted: '流程中断，等待恢复', failed: '流程执行失败' } as const)[state.state];
}

export function workflowReceiptIdentity(value: WorkflowState): string {
  return JSON.stringify([value.sessionId, value.workflowVersionId, value.executionId ?? value.traceId]);
}

export function sameWorkflowReceipt(left: WorkflowState, right: WorkflowState): boolean {
  return left.sessionId === right.sessionId && left.workflowVersionId === right.workflowVersionId
    && (left.executionId !== undefined && right.executionId !== undefined ? left.executionId === right.executionId : left.traceId === right.traceId);
}

/** This only rejects conflicting display facts; it never advances execution. */
export function acceptsWorkflowUpdate(previous: WorkflowState, next: WorkflowState, seenTraceIds: readonly string[]): boolean {
  if (!sameWorkflowReceipt(previous, next) || (previous.branchId !== undefined && previous.branchId !== next.branchId)
    || previous.steps.length > next.steps.length || (previous.traceId !== next.traceId && seenTraceIds.includes(next.traceId))) return false;
  if (previous.outcome === 'success' && (next.outcome !== 'success' || next.state !== 'completed' || previous.steps.length !== next.steps.length)) return false;
  // Resuming creates a new trace. A replay within the closed trace cannot
  // reopen its display receipt, including an attempt with no checkpoints.
  if (previous.traceId === next.traceId && previous.state !== 'running' && previous.state !== 'waiting'
    && (next.state === 'running' || next.state === 'waiting')) return false;
  return previous.steps.every((step, index) => {
    const incoming = next.steps[index];
    if (incoming === undefined || step.nodeId !== incoming.nodeId || step.status !== incoming.status || step.input !== incoming.input || step.output !== incoming.output
      || JSON.stringify(step.evidenceRefs) !== JSON.stringify(incoming.evidenceRefs)) return false;
    return (['dependsOn', 'inputBindings', 'outputDigest', 'recoveryTo'] as const).every(key => step[key] === undefined || persistedFact(step[key]) === persistedFact(incoming[key]));
  });
}
