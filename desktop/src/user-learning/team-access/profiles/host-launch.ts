// startTeamTurn — the ONLY legal spawn entry (Foundation spec §7.6.2).
//
// Composer 开始 → freeze the profile → write profile.v1.json (scratch
// for the CLI) → preparePrompt with confirmedSpawn + frozenProfile →
// hand the caller a ready system prompt + queued run. No card, no
// auto-spawn: everything before this click stays solo.
//
// App-only import (surfaces must not import user-learning). Pure where
// possible: fs goes through injected writeFile/readFile; the freeze and
// validation come from launch.ts / profile-validate.ts.

import { validateProfile } from './profile-validate';
import type { PersistableTeamRun } from '../persist';
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

/** Module-level double-click lock (§7.6.2 step 1); App adds no state. */
let inFlight = false;

export interface StartTeamTurnInput {
  readonly workspaceRoot: string;
  readonly conversationId: string;
  readonly product: 'code' | 'work';
  readonly goal: string;
  readonly profile: TeamProfile;
  /** True only when BOTH team flags are on (§9.4). */
  readonly composerLive: boolean;
  readonly preparePrompt: UserLearningRuntime['preparePrompt'];
  readonly isPersonTurnRunning: boolean;
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
  if (inFlight) {
    return { ok: false, reason: 'in_flight', message: launchErrorMessage('in_flight') };
  }
  inFlight = true;
  try {
    return await runLaunch(input);
  } finally {
    inFlight = false;
  }
}

async function runLaunch(input: StartTeamTurnInput): Promise<StartTeamTurnResult> {
  // 2. flags / goal / profile validation. Failure → composer reason, no
  // fake run (§7.6.2 step 2).
  if (!input.composerLive) {
    return { ok: false, reason: 'flag_off', message: launchErrorMessage('flag_off') };
  }
  const goal = input.goal.trim();
  if (goal.length === 0) {
    return { ok: false, reason: 'empty_goal', message: launchErrorMessage('empty_goal') };
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

  // 4. freeze + fresh teamRunId. The id MUST match the one the runtime
  // renders into <trylo_team_access> (team-<conversationId>) because the
  // CLI parses that line to find this very file (§7.6.1).
  const teamRunId = `team-${input.conversationId}`;
  const frozenProfile = freezeProfile(input.profile);

  // 5. write the scratch freeze. Failure degrades: log, continue, and the
  // system prompt carries compact sibling overlay tags instead (§8.4).
  let overlayWriteFailed = false;
  try {
    await input.writeFile(frozenProfilePath(input.workspaceRoot, teamRunId), serializeFrozenProfile(frozenProfile));
  } catch (err) {
    overlayWriteFailed = true;
    // eslint-disable-next-line no-console
    console.warn('[team-access] profile.v1.json write failed; falling back to tags:', err);
  }

  // 6. cache the queued run BEFORE the turn so spawn events can bind.
  await loadTeamRunsForWorkspace(input.workspaceRoot, input.workspaceRoot);
  const run = createFrozenTeamRun({
    teamRunId,
    personConversationId: input.conversationId,
    goal,
    frozenProfile,
    now: Date.now(),
  });
  await upsertTeamRun(run);

  // 7. the Person turn with a confirmed spawn. The scorer's roster comes
  // from the frozen profile; no freeze ⇒ no contract (§7.2.1).
  const prepared = input.preparePrompt({
    workspaceRoot: input.workspaceRoot,
    product: input.product,
    prompt: goal,
    conversationId: input.conversationId,
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

  // 8. hand the send payload back. `appendUserBubble` is decided by the
  // App (it owns the transcript); the system prompt NEVER carries overlay
  // JSON unless the freeze write failed (§8.4 sibling tags).
  const contractRun: PersistableTeamRun = prepared.contract.contractId
    ? { ...run, contractId: prepared.contract.contractId, contractVersion: prepared.contract.version }
    : run;
  await upsertTeamRun(contractRun);
  let systemPrompt = prepared.systemPrompt;
  if (overlayWriteFailed) {
    const { renderMemberOverlayFallbackTags } = await import('../render-team-access');
    systemPrompt = `${systemPrompt}\n${renderMemberOverlayFallbackTags(frozenProfile)}`;
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
