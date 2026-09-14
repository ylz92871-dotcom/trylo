/**
 * Trylo Team — five-seat roster mirror.
 *
 * Desktop must not import trylo-cli sources (different build boundaries),
 * so the five seat IDs and display names are duplicated here from
 * `trylo cli/src/tools/AgentTool/team-roster/types.ts`. The
 * `seats.test.ts` lock-in asserts both sides carry the same five IDs in
 * the same order. If the CLI roster ever grows or reorders, this file
 * is the place to update, and the test will fail loud.
 *
 * Spec §3 — shared/ is the only place that should know seat IDs and
 * display names. Every other surface component reads from here.
 */
import type { TryloTeamSeatId } from '../team/team-types';

export interface TeamSeatDescriptor {
  readonly id: TryloTeamSeatId;
  /** Display name used in the chip, summary card, and seat detail header. */
  readonly displayName: string;
  /** Single-letter abbreviation used in compact contexts (chip leading). */
  readonly short: string;
  /** One-line role summary; appears on the detail header. */
  readonly role: string;
  /**
   * Independence level, mirroring the CLI roster. UI uses this to add the
   * "独立" hint to Reviewer / Verifier headers — it is a visible signal
   * that the seat cannot be commanded to pass.
   */
  readonly independence: 'none' | 'review' | 'verify';
  /**
   * Token name (one of the existing palette entries) used for the
   * thin identity bar at the top of the seat card and the leading
   * accent in the chip. No new colors — see tokens.css.
   */
  readonly accent: 'brand' | 'ice-blue' | 'brand-soft' | 'ink-fog';
}

export const TRYLO_TEAM_SEAT_IDS_DESKTOP: readonly TryloTeamSeatId[] = [
  'person',
  'architect',
  'worker',
  'reviewer',
  'verifier',
  'cad-planner',
  'cad-verifier',
] as const;

export const TRYLO_TEAM_SEAT_DISPLAY_NAME_DESKTOP: Record<TryloTeamSeatId, string> = {
  person: 'Person',
  architect: 'Architect',
  worker: 'Worker',
  reviewer: 'Reviewer',
  verifier: 'Verifier',
  'cad-planner': 'CAD Planner',
  'cad-verifier': 'CAD Verifier',
};

export const TEAM_SEAT_DESCRIPTORS: Readonly<Record<TryloTeamSeatId, TeamSeatDescriptor>> = {
  person: {
    id: 'person',
    displayName: 'Person',
    short: 'P',
    role: '用户意图 / 否决',
    independence: 'none',
    accent: 'brand',
  },
  architect: {
    id: 'architect',
    displayName: 'Architect',
    short: 'A',
    role: '方案设计，不写代码',
    independence: 'none',
    accent: 'ice-blue',
  },
  worker: {
    id: 'worker',
    displayName: 'Worker',
    short: 'W',
    role: '唯一默认可写的执行者',
    independence: 'none',
    accent: 'ice-blue',
  },
  reviewer: {
    id: 'reviewer',
    displayName: 'Reviewer',
    short: 'R',
    role: '独立审查，不能被指令 pass',
    independence: 'review',
    accent: 'brand-soft',
  },
  verifier: {
    id: 'verifier',
    displayName: 'Verifier',
    short: 'V',
    role: '独立验收，不能被指令 pass',
    independence: 'verify',
    accent: 'brand-soft',
  },
  'cad-planner': {
    id: 'cad-planner',
    displayName: 'CAD Planner',
    short: 'P',
    role: '冻结机械设计施工包，不建模',
    independence: 'none',
    accent: 'ice-blue',
  },
  'cad-verifier': {
    id: 'cad-verifier',
    displayName: 'CAD Verifier',
    short: 'V',
    role: '按断言表独立验收 CAD 证据',
    independence: 'verify',
    accent: 'brand-soft',
  },
};

export const TEAM_SEAT_ORDER: readonly TryloTeamSeatId[] = TRYLO_TEAM_SEAT_IDS_DESKTOP;

export function isTeamSeatId(value: string): value is TryloTeamSeatId {
  return (TRYLO_TEAM_SEAT_IDS_DESKTOP as readonly string[]).includes(value);
}

export function seatDescriptor(id: TryloTeamSeatId): TeamSeatDescriptor {
  return TEAM_SEAT_DESCRIPTORS[id];
}
