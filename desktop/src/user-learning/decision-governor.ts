import { newId } from './ids';
import type {
  PendingRunChoice,
  PendingRunIntent,
  PolicyDecision,
  ProductSurface,
} from './types';
import type { TeamPendingChoice, TeamSpawnDecision } from './team-access/spawn-score';

export type PrepareStart = 'ready' | 'pending_impact' | 'blocked' | 'pending_team';

export type {
  TeamPendingChoice,
  TeamSpawnDecision,
  TeamSpawnDecisionKind,
} from './team-access/spawn-score';

export function startForDecision(decision: PolicyDecision): PrepareStart {
  if (decision.impactCheck?.interruptUser) return 'pending_impact';
  return 'ready';
}

/** spawn_team/stay_solo → ready; ask_user → pending_team; refuse → blocked. */
export function startForTeamDecision(decision: TeamSpawnDecision): PrepareStart {
  if (decision.decision === 'ask_user') return 'pending_team';
  if (decision.decision === 'refuse') return 'blocked';
  return 'ready';
}

export function explicitInstructionFor(choice: PendingRunChoice): string {
  if (choice === 'baseline') {
    return 'Explicit current task instruction: keep the engineering baseline. Core or high-rollback paths must plan first and keep final verification.';
  }
  if (choice === 'personalization') {
    return 'Explicit current task instruction: apply the user-confirmed scoped personalization. Safety and data integrity still win.';
  }
  return '';
}

export function pendingLaunchDecision(
  pending: PendingRunIntent | undefined,
  choice: PendingRunChoice | TeamPendingChoice,
  now: number,
): 'launch' | 'already_started' | 'missing' | 'expired' | 'dismissed' {
  if (!pending) return 'missing';
  if (pending.resumeCount > 0 || pending.status !== 'pending') return 'already_started';
  if (now > pending.expiresAt) return 'expired';
  if (choice === 'dismiss') return 'dismissed';
  return 'launch';
}

export function createPendingRun(input: {
  readonly workspaceRoot: string;
  readonly product: ProductSurface;
  readonly prompt: string;
  readonly decision: PolicyDecision;
  readonly now: number;
  readonly baseSystemPrompt?: string;
  readonly conversationId?: string;
  readonly turnId?: string;
  readonly projectKey?: string;
  readonly attachments?: readonly string[];
  readonly teamSpawn?: TeamSpawnDecision;
}): PendingRunIntent {
  return {
    id: newId('prun', input.now),
    projectKey: input.projectKey ?? input.workspaceRoot,
    conversationId: input.conversationId ?? input.decision.taskId,
    turnId: input.turnId ?? input.decision.taskId,
    userPrompt: input.prompt,
    workspaceRoot: input.workspaceRoot,
    product: input.product,
    baseSystemPrompt: input.baseSystemPrompt ?? '',
    resolvedAttachments: input.attachments ?? [],
    baselineDecision: {
      ...input.decision,
      injected: false,
      injectionText: '',
      enforced: [],
      active: [],
    },
    personalizedDecision: input.decision,
    expiresAt: input.now + 30 * 60 * 1000,
    resumeCount: 0,
    status: 'pending',
    ...(input.teamSpawn ? { teamSpawn: input.teamSpawn } : {}),
  };
}
