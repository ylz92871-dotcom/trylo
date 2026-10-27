// startTeamTurn — the ONLY legal spawn entry (Foundation spec §7.6.2).
//
// Composer 开始 → validate and prepare the frozen profile → write
// profile.v1.json for the CLI → queue the run and return its send payload. No card, no
// auto-spawn: everything before this click stays solo.
//
// App-only import (surfaces must not import user-learning). Pure where
// possible: fs goes through injected writeFile/readFile; the freeze and
// validation come from launch.ts / profile-validate.ts.

import { validateProfile } from './profile-validate';
import { teamRunsFilePath, type PersistableTeamRun } from '../persist';
import {
  createFrozenTeamRun,
  freezeProfile,
  frozenProfilePath,
  serializeFrozenProfile,
} from './launch';
import { loadTeamRunsForWorkspace, upsertTeamRun } from './team-runs-cache';
import type { TeamProfile } from './profile-types';
import type { UserLearningRuntime } from '../../runtime';

export type LaunchErrorCode =
  | 'invalid_profile'
  | 'empty_goal'
  | 'flag_off'
  | 'turn_busy'
  | 'pending_impact'
  | 'blocked'
  | 'prepare_not_ready'
  | 'in_flight';

const LAUNCH_ERROR_MESSAGE: Record<LaunchErrorCode, string> = {
  invalid_profile: '团队配置无效',
  empty_goal: '缺少目标',
  flag_off: 'Team Access / Composer 未打开',
  turn_busy: '当前会话有正在跑的任务',
  pending_impact: '先处理 Person 里的影响确认',
  blocked: '组队请求被拒绝',
  prepare_not_ready: '团队回合未能准备就绪',
  in_flight: '正在开始这场团队…',
};

export function launchErrorMessage(code: LaunchErrorCode, detail?: string): string {
  return detail ? `${LAUNCH_ERROR_MESSAGE[code]}：${detail}` : LAUNCH_ERROR_MESSAGE[code];
}

/** One launch per conversation; independent origins can prepare concurrently. */
const inFlight = new Set<string>();

export interface StartTeamTurnInput {
  readonly workspaceId?: string;
  readonly workspaceRoot: string;
  readonly conversationId: string;
  readonly product: 'code' | 'work';
  readonly goal: string;
  readonly profile: TeamProfile;
  /** True only when BOTH team flags are on (§9.4). */
  readonly composerLive: boolean;
  readonly preparePrompt: UserLearningRuntime['preparePrompt'];
  readonly isPersonTurnRunning: boolean;
  /** Optional native owner check; refusal precedes profile and history writes. */
  readonly inspectOwner?: () => Promise<void>;
  readonly signal?: AbortSignal;
  /** One identity per launch; conversation identity alone cannot retain history. */
  readonly newRunId?: () => string;
  readonly writeFile: (path: string, body: string) => Promise<void>;
}

export type StartTeamTurnResult =
  | {
      readonly ok: true;
      readonly systemPrompt: string;
      readonly run: PersistableTeamRun;
      readonly teamRunId: string;
      readonly teamMode: true;
      readonly product: 'code' | 'work';
      readonly goal: string;
    }
  | { readonly ok: false; readonly reason: LaunchErrorCode; readonly message: string };

export async function startTeamTurn(input: StartTeamTurnInput): Promise<StartTeamTurnResult> {
  // 1. in-flight lock — a second click never launches twice.
  const origin = JSON.stringify([teamRunsFilePath(input.workspaceRoot), input.conversationId]);
  if (inFlight.has(origin)) {
    return { ok: false, reason: 'in_flight', message: launchErrorMessage('in_flight') };
  }
  inFlight.add(origin);
  try {
    return await runLaunch(input);
  } finally {
    inFlight.delete(origin);
  }
}

async function runLaunch(input: StartTeamTurnInput): Promise<StartTeamTurnResult> {
  const cancelled = (): StartTeamTurnResult => ({ ok: false, reason: 'blocked', message: '本次团队启动已取消，未派发新任务。' });
  if (input.signal?.aborted) return cancelled();
  // 2. flags / goal / profile validation. Failure → composer reason, no
  // fake run (§7.6.2 step 2).
  if (!input.composerLive) {
    return { ok: false, reason: 'flag_off', message: launchErrorMessage('flag_off') };
  }
  const goal = input.goal.trim();
  if (goal.length === 0) {
    return { ok: false, reason: 'empty_goal', message: launchErrorMessage('empty_goal') };
  }
  if (input.profile.surface !== input.product) {
    return { ok: false, reason: 'invalid_profile',
      message: launchErrorMessage('invalid_profile', '团队配置的 Code/Work 类型与当前模式不一致') };
  }
  const allowNoWorker = input.profile.members.some((m) => m.baseRole === 'reviewer')
    && !input.profile.members.some((m) => m.baseRole === 'worker');
  const validation = validateProfile(
    { members: input.profile.members, title: input.profile.title },
    { allowNoWorker },
  );
  if (!validation.ok) {
    return {
      ok: false,
      reason: 'invalid_profile',
      message: launchErrorMessage('invalid_profile', validation.errors[0]),
    };
  }

  // 3. one Person turn per conversation at a time.
  if (input.isPersonTurnRunning) {
    return { ok: false, reason: 'turn_busy', message: launchErrorMessage('turn_busy') };
  }
  if (input.inspectOwner) {
    try { await input.inspectOwner(); }
    catch (error) {
      return { ok: false, reason: 'blocked', message: launchErrorMessage('blocked',
        error instanceof Error ? error.message : String(error)) };
    }
  }
  if (input.signal?.aborted) return cancelled();

  // The exact identity travels through preparation, scratch IO and events.
  const newRunId = input.newRunId ?? (() => `team-${crypto.randomUUID()}`);
  const teamRunId = newRunId();
  const frozenProfile = freezeProfile(input.profile);

  // Preparation may refuse this launch. Do it before any disk or cache
  // mutation so an impact confirmation never leaves a phantom active run.
  const prepared = input.preparePrompt({
    workspaceRoot: input.workspaceRoot,
    product: input.product,
    prompt: goal,
    conversationId: input.conversationId,
    teamRunId,
    confirmedSpawn: true,
    frozenProfile,
  });
  if (prepared.start === 'pending_impact') {
    return { ok: false, reason: 'pending_impact', message: launchErrorMessage('pending_impact') };
  }
  if (prepared.start === 'blocked') {
    return {
      ok: false,
      reason: 'blocked',
      message: prepared.teamSpawn?.reason ?? launchErrorMessage('blocked'),
    };
  }
  if (prepared.start !== 'ready' || !prepared.contract) {
    return { ok: false, reason: 'prepare_not_ready', message: launchErrorMessage('prepare_not_ready') };
  }

  let overlayWriteFailed = false;
  try {
    await input.writeFile(frozenProfilePath(input.workspaceRoot, teamRunId), serializeFrozenProfile(frozenProfile));
  } catch (err) {
    overlayWriteFailed = true;
    // The prompt carries the same frozen overlay when scratch IO fails.
    // eslint-disable-next-line no-console
    console.warn('[team-access] profile.v1.json write failed; falling back to tags:', err);
  }
  if (input.signal?.aborted) return cancelled();
  await loadTeamRunsForWorkspace(input.workspaceRoot, input.workspaceId ?? input.workspaceRoot, 'background');
  if (input.signal?.aborted) return cancelled();
  const run = createFrozenTeamRun({
    teamRunId,
    personConversationId: input.conversationId,
    goal,
    frozenProfile,
    now: Date.now(),
  });

  // 8. hand the send payload back. `appendUserBubble` is decided by the
  // App (it owns the transcript); the system prompt NEVER carries overlay
  // JSON unless the freeze write failed (§8.4 sibling tags).
  const contractRun: PersistableTeamRun = prepared.contract.contractId
    ? { ...run, contractId: prepared.contract.contractId, contractVersion: prepared.contract.version }
    : run;
  await upsertTeamRun(contractRun, input.workspaceRoot);
  let systemPrompt = prepared.systemPrompt;
  if (overlayWriteFailed) {
    const { renderMemberOverlayFallbackTags } = await import('../render-team-access');
    systemPrompt = `${systemPrompt}\n${renderMemberOverlayFallbackTags(frozenProfile)}`;
  }
  if (input.signal?.aborted) {
    const at = Math.max(Date.now(), contractRun.updatedAt);
    await upsertTeamRun({ ...contractRun, status: 'cancelled', lifecycle: 'closed', endedAt: at, updatedAt: at,
      seats: contractRun.seats.map(seat => ({ ...seat, status: 'cancelled', canReceiveInput: false,
        summary: '启动已取消，未开始执行', endedAt: at })) }, input.workspaceRoot);
    return cancelled();
  }
  return {
    ok: true,
    systemPrompt,
    run: contractRun,
    teamRunId,
    teamMode: true,
    product: input.product,
    goal,
  };
}
