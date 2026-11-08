import { runCliCommand, type CliCommandInput, type CliCommandResult } from '../host-adapter/cli-command';

export type CollaborationLearningRuntime = Pick<CliCommandInput, 'process' | 'cliPath' | 'nodeProgram' | 'cwd'>;
export type CollaborationCorrectionSummary = { readonly factId: string; readonly action: 'suspend' | 'restore';
  readonly scopeKind: 'workspace' | 'class' | 'once'; readonly taskFamily?: string; readonly role?: string; readonly taskId?: string;
  readonly evidenceRef: string; readonly replacesCorrectionId?: string };
export type CollaborationPracticeSummary = { readonly familyId: string; readonly versionId: string; readonly title: string;
  readonly hypothesis: string; readonly status: 'trial' | 'suspended'; readonly dependency: string; readonly roles: readonly string[];
  readonly actions: readonly { readonly actionId: string; readonly instruction: string; readonly audience: string; readonly operation: string }[];
  readonly evidenceRefs: readonly string[]; readonly corrections: readonly CollaborationCorrectionSummary[] };
export type CollaborationCycleSummary = { readonly cycleId: string; readonly requestId: string; readonly phase: string;
  readonly maxTokens: number; readonly spentTokens: number; readonly spentCalls: number; readonly reason?: string };
export type CollaborationStatus = { readonly scope: string; readonly boardSequence: number; readonly practices: readonly CollaborationPracticeSummary[];
  readonly cycles: readonly CollaborationCycleSummary[] };
type Result<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string };
type Runner = (input: CliCommandInput) => Promise<CliCommandResult>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4000;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const refs = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 256 && value.every(text);
const scopeIdentity = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

function correction(value: unknown): CollaborationCorrectionSummary | undefined {
  if (!record(value) || !text(value.factId) || (value.action !== 'suspend' && value.action !== 'restore') || !record(value.appliesTo)
    || !['workspace', 'class', 'once'].includes(String(value.appliesTo.kind))
    || !text(value.evidenceRef)
    || (value.appliesTo.kind === 'class' && (!text(value.appliesTo.taskFamily) || !text(value.appliesTo.role)))
    || (value.appliesTo.kind === 'once' && !text(value.appliesTo.taskId))
    || (value.replacesCorrectionId !== undefined && !text(value.replacesCorrectionId))) return undefined;
  return { factId: value.factId, action: value.action, scopeKind: value.appliesTo.kind as CollaborationCorrectionSummary['scopeKind'],
    evidenceRef: value.evidenceRef,
    ...(value.appliesTo.kind === 'class' ? { taskFamily: String(value.appliesTo.taskFamily), role: String(value.appliesTo.role) } : {}),
    ...(value.appliesTo.kind === 'once' ? { taskId: String(value.appliesTo.taskId) } : {}),
    ...(typeof value.replacesCorrectionId === 'string' ? { replacesCorrectionId: value.replacesCorrectionId } : {}) };
}
function practice(value: unknown): CollaborationPracticeSummary | undefined {
  if (!record(value) || ![value.familyId, value.versionId, value.title, value.hypothesis].every(text)
    || (value.status !== 'trial' && value.status !== 'suspended') || !record(value.conditions) || !text(value.conditions.dependency)
    || !refs(value.conditions.roles) || !refs(value.evidenceRefs) || !Array.isArray(value.actions) || value.actions.length > 8
    || !Array.isArray(value.corrections) || value.corrections.length > 256) return undefined;
  const actions: CollaborationPracticeSummary['actions'][number][] = [];
  for (const action of value.actions) {
    if (!record(action) || !text(action.actionId) || !text(action.instruction) || !text(action.audience) || !text(action.operation)) return undefined;
    actions.push({ actionId: action.actionId, instruction: action.instruction, audience: action.audience, operation: action.operation });
  }
  const corrections: CollaborationCorrectionSummary[] = [];
  for (const item of value.corrections) { const parsed = correction(item); if (parsed === undefined) return undefined; corrections.push(parsed); }
  return { familyId: String(value.familyId), versionId: String(value.versionId), title: String(value.title), hypothesis: String(value.hypothesis),
    status: value.status, dependency: value.conditions.dependency, roles: value.conditions.roles, actions, evidenceRefs: value.evidenceRefs, corrections };
}

export function parseCollaborationStatus(stdout: string, expectedScope: string): Result<CollaborationStatus> {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return { ok: false, reason: 'invalid_collaboration_reply' }; }
  if (!record(value) || value.schemaVersion !== 2 || value.ok !== true || !text(value.scope)
    || scopeIdentity(value.scope) !== scopeIdentity(expectedScope) || !count(value.boardSequence)
    || !Array.isArray(value.practices) || value.practices.length > 256 || !Array.isArray(value.cycles) || value.cycles.length > 256) {
    return { ok: false, reason: 'unsupported_collaboration_status' };
  }
  const practices: CollaborationPracticeSummary[] = [], cycles: CollaborationCycleSummary[] = [];
  for (const item of value.practices) { const parsed = practice(item); if (parsed === undefined) return { ok: false, reason: 'invalid_collaboration_practice' }; practices.push(parsed); }
  for (const item of value.cycles) {
    if (!record(item) || !text(item.cycleId) || !text(item.requestId) || !text(item.phase) || !record(item.grant) || !count(item.grant.maxModelTokens)
      || !record(item.spent) || !count(item.spent.modelTokens) || !count(item.spent.modelCalls) || (item.reason !== undefined && !text(item.reason))) {
      return { ok: false, reason: 'invalid_collaboration_cycle' };
    }
    cycles.push({ cycleId: item.cycleId, requestId: item.requestId, phase: item.phase, maxTokens: item.grant.maxModelTokens,
      spentTokens: item.spent.modelTokens, spentCalls: item.spent.modelCalls, ...(typeof item.reason === 'string' ? { reason: item.reason } : {}) });
  }
  return { ok: true, scope: value.scope, boardSequence: value.boardSequence, practices, cycles };
}

export function activeWorkspaceSuspension(practice: CollaborationPracticeSummary): string | undefined {
  return practice.corrections.find(item => item.scopeKind === 'workspace' && item.action === 'suspend'
    && !practice.corrections.some(next => next.action === 'restore' && next.replacesCorrectionId === item.factId))?.factId;
}

/** Reuses the existing bounded CLI transport; Desktop never opens or rewrites Board files. */
export function createCollaborationLearningPort(runtime: CollaborationLearningRuntime, run: Runner = runCliCommand) {
  return {
    async status(signal: AbortSignal): Promise<Result<CollaborationStatus>> {
      const result = await run({ ...runtime, args: ['learn', 'collaboration', 'status', '--workspace', runtime.cwd, '--json'], signal, timeoutMs: 30000 });
      return result.ok ? parseCollaborationStatus(result.stdout, runtime.cwd) : { ok: false, reason: result.reason };
    },
    async correct(input: { readonly familyId: string; readonly action: 'suspend' | 'restore'; readonly evidenceRef: string;
      readonly replacesCorrectionId?: string }, signal: AbortSignal): Promise<Result<{ readonly correctionId: string }>> {
      if (!text(input.familyId) || !text(input.evidenceRef) || !input.evidenceRef.startsWith('user:')
        || (input.action === 'restore' && !text(input.replacesCorrectionId))) return { ok: false, reason: 'explicit_user_correction_required' };
      const result = await run({ ...runtime, args: ['learn', 'collaboration', 'correct', '--workspace', runtime.cwd,
        '--family', input.familyId, '--action', input.action, '--scope', 'workspace', '--evidence-ref', input.evidenceRef,
        ...(input.replacesCorrectionId === undefined ? [] : ['--replaces', input.replacesCorrectionId]), '--json'], signal, timeoutMs: 30000 });
      if (!result.ok) return { ok: false, reason: result.reason };
      let reply: unknown;
      try { reply = JSON.parse(result.stdout); } catch { return { ok: false, reason: 'invalid_collaboration_receipt' }; }
      return record(reply) && reply.schemaVersion === 2 && reply.ok === true && text(reply.correctionId)
        ? { ok: true, correctionId: reply.correctionId } : { ok: false, reason: 'collaboration_correction_not_committed' };
    },
  };
}
