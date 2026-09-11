// Renders the PA-only `<trylo_team_access>` block (PR-7, spec §14.3).
//
// Everything the CLI last-mile needs lives inside this one block: the
// spawn protocol, DAG fields, the serialized contract JSON, and (only
// when Enforced) the five per-seat translation tags. Shadow omits the
// translation tags but keeps the contract — the contract is a task
// specification, not personalization. Block budget: 2800 tokens.
import { estimateTokens, sourceHash } from '../ids';
import { OVERLAY_FALLBACK_PROMPT_MAX_CHARS } from './profiles/profile-types';
import type { EnforcementMode } from '../types';
import {
  CONTRACT_TAG,
  type EngineeringContract,
  type TeamAccessSeatId,
} from './contract-types';
import { serializeContract } from './contract-serialize';
import type { TeamTranslationProjection } from './translation-compiler';
import type { TeamSpawnDecision } from './spawn-score';

export const TEAM_ACCESS_TAG = 'trylo_team_access';
export const TEAM_TRANSLATION_TAG = 'trylo_team_translation';

export const MAX_TEAM_ACCESS_TOKENS = 2800;

const HOLD_NONE = 'none';

/**
 * Work `stay_solo` negative protocol — no contract, no translation.
 *
 * stay_solo forbids TEAM FORMATION (the five team-stage seats), not the
 * CLI's explicit subagent dispatch: specialist seats like cad-planner /
 * cad-verifier (and custom agents) are spawned via Agent(subagent_type)
 * as one-shot helpers, never as a team — they must stay dispatchable
 * here or the CAD freeze→build→verify workflow is unreachable solo.
 */
export function renderStaySoloProtocol(): string {
  return [
    `<${TEAM_ACCESS_TAG}>`,
    'decision: stay_solo',
    'Do not spawn team seats (person/architect/worker/reviewer/verifier) and do not form a team. Stay solo.',
    'Explicit specialist subagents are not team formation: dispatch them via Agent(subagent_type) when the task calls for their workflow (e.g. cad-planner to freeze a CAD construction package, cad-verifier to review/verify it).',
    `</${TEAM_ACCESS_TAG}>`,
  ].join('\n');
}

/** Structural frozen-profile view for the block (canonical TeamProfile
 *  fits; render-team-access stays free of the profiles module). */
export interface FrozenRosterProfile {
  readonly id: string;
  readonly members: readonly {
    readonly memberId: string;
    readonly baseRole: string;
    readonly displayName: string;
  }[];
}

/**
 * Full team-access block (Foundation spec §8.4). `seatProjections` must
 * contain all five seats. Enforced renders each seat's translation tag;
 * Shadow omits them. The header carries the COMPACT ROSTER from the
 * frozen profile (member_id + baseRole + displayName) — the heuristic
 * `recommendedSeats` line is gone, and overlay JSON NEVER appears here
 * (the 2800 budget cannot hold 6×2k overlays; the freeze file is the
 * overlay channel, with write-fail sibling tags OUTSIDE this block).
 */
export function renderTeamAccessBlock(input: {
  readonly decision: TeamSpawnDecision;
  readonly contract: EngineeringContract;
  readonly seatProjections: Readonly<Record<TeamAccessSeatId, TeamTranslationProjection>>;
  readonly mode: EnforcementMode;
  readonly teamRunId: string;
  readonly frozenProfile?: FrozenRosterProfile;
  /** Machine line for the PA (spec §11.2): `worker` while a blocking
   *  high-risk clarification is open — the PA must not spawn a worker. */
  readonly hold?: 'none' | 'worker';
}): string {
  const d = input.decision;
  const lines: string[] = [
    `<${TEAM_ACCESS_TAG}>`,
    `decision: ${d.decision}`,
    `contractId: ${input.contract.contractId}`,
    `teamRunId: ${input.teamRunId}`,
    ...(input.frozenProfile ? [`profileId: ${input.frozenProfile.id}`] : []),
    `TRYLO_TEAM_HOLD: ${input.hold ?? HOLD_NONE}`,
    '',
    '## Protocol',
    '- Spawn only person|architect|worker|reviewer|verifier via subagent_type.',
    '- Pass member_id exactly as listed. Do not invent ids.',
    '- Do not spawn general-purpose as a team seat.',
    '- Do not tell reviewer/verifier to pass.',
    '- Person output: Intent / Veto / User questions / Representation notes.',
    '- You do not paste contract tags; the runtime attaches them to seats.',
  ];
  if (input.frozenProfile) {
    lines.push('', '## Roster');
    for (const member of input.frozenProfile.members) {
      lines.push(`- member_id=${member.memberId} baseRole=${member.baseRole} displayName=${member.displayName}`);
    }
  }
  lines.push(
    '',
    `<${CONTRACT_TAG}>`,
    serializeContract(input.contract),
    `</${CONTRACT_TAG}>`,
  );
  if (input.mode === 'enforced') {
    for (const seat of Object.keys(input.seatProjections) as readonly TeamAccessSeatId[]) {
      const projection = input.seatProjections[seat]!;
      if (projection.instructions.length === 0) continue;
      lines.push(
        '',
        `<${TEAM_TRANSLATION_TAG} audience="seat:${seat}">`,
        projection.instructions.join('\n'),
        `</${TEAM_TRANSLATION_TAG}>`,
      );
    }
  }
  lines.push(`</${TEAM_ACCESS_TAG}>`);
  return lines.join('\n');
}

/**
 * Write-fail-only sibling tags (Foundation spec §8.4): appended AFTER
 * `</trylo_team_access>` by host-launch when profile.v1.json could not
 * be written. Prompt overlays truncate to 400 chars; these tags are NOT
 * part of the 2800 budget and the CLI extracts them before stripping.
 */
export interface FrozenOverlayProfile extends FrozenRosterProfile {
  readonly members: readonly {
    readonly memberId: string;
    readonly baseRole: string;
    readonly displayName: string;
    readonly overlay?: {
      readonly model?: string;
      readonly tools?: readonly string[];
      readonly skills?: readonly string[];
      readonly systemPromptOverlay?: string;
    };
  }[];
}

export function renderMemberOverlayFallbackTags(profile: FrozenOverlayProfile): string {
  return profile.members
    .map((member) => {
      const compact = {
        model: member.overlay?.model ?? 'inherit',
        ...(member.overlay?.tools ? { tools: member.overlay.tools } : {}),
        skills: member.overlay?.skills ?? [],
        systemPromptOverlay: (member.overlay?.systemPromptOverlay ?? '').slice(
          0,
          OVERLAY_FALLBACK_PROMPT_MAX_CHARS,
        ),
      };
      return `<trylo_member_overlay member_id="${member.memberId}">${JSON.stringify(compact)}</trylo_member_overlay>`;
    })
    .join('\n');
}

/** Diagnostics hash of the block source; not a security boundary. */
export function teamAccessHash(block: string): string {
  return sourceHash([block]);
}

export function teamAccessTokenCount(block: string): number {
  return estimateTokens(block);
}
