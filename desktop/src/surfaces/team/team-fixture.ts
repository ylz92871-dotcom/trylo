/**
 * P0 fixture for the team surface. Spec §8 — a 3-seat run
 * (Person completed, Worker running, Reviewer queued) so the
 * bottom strip proves it won't draw Architect / Verifier.
 *
 * This file MUST stay separate from any live projection; the spec
 * forbids writing fixtures into the conversation history file.
 */
import { emptyTeamRun } from './team-store';
import type { TeamProfile } from './team-profile-types';
import type { SeatInstance, TeamRun } from './team-types';

const FIXTURE_BASE_TIME = 1_730_000_000_000; // 2026-09-03 fixed timestamp so tests are stable

export const FIXTURE_SEATS: readonly SeatInstance[] = [
  {
    id: 'fixture-seat-person',
    seat: 'person',
    status: 'completed',
    summary: '意图已收口',
    prompt: '把 P3 收口 + 写 UI。',
    result: '已和用户确认验收清单（PR-B 五条 + 视觉两条）。',
    startedAt: FIXTURE_BASE_TIME,
    endedAt: FIXTURE_BASE_TIME + 4_000,
    durationMs: 4_000,
  },
  {
    id: 'fixture-seat-worker',
    seat: 'worker',
    status: 'running',
    summary: '正在实现三个 React 组件',
    prompt:
      '按 spec §3 落地 desktop/src/surfaces/，' +
      '新增 team-types / team-store / TeamSurface / SeatStrip / SeatDetail，' +
      '以及对应 CSS。',
    startedAt: FIXTURE_BASE_TIME + 4_000,
  },
  {
    id: 'fixture-seat-reviewer',
    seat: 'reviewer',
    status: 'queued',
    summary: '排队中，等 Worker 完成后开始',
  },
];

/** Ephemeral frozen profile for the fixture (Foundation spec §10.10). */
export const FIXTURE_FROZEN_PROFILE: TeamProfile = {
  schemaVersion: 1,
  id: 'fixture-team-run-001',
  origin: 'custom',
  surface: 'code',
  title: '把 P3 收口 + 写 UI',
  createdAt: FIXTURE_BASE_TIME,
  updatedAt: FIXTURE_BASE_TIME,
  members: FIXTURE_SEATS.map((seat) => ({
    memberId: `fixture-member-${seat.id}`,
    baseRole: seat.seat,
    displayName: seat.seat.charAt(0).toUpperCase() + seat.seat.slice(1),
    overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' },
  })),
};

export const FIXTURE_TEAM_RUN: TeamRun = emptyTeamRun({
  id: 'fixture-team-run-001',
  workspaceId: 'fixture-workspace',
  personConversationId: 'fixture-person-conversation',
  status: 'running',
  createdAt: FIXTURE_BASE_TIME,
  frozenProfile: FIXTURE_FROZEN_PROFILE,
  summary: {
    title: '把 P3 收口 + 写 UI',
    goal:
      '把 P3 的 ApprovalCard 接线做完，同时出第一版 Person | Team 双表面 UI。' +
      '需要 Worker 实现三个 React 组件，Reviewer 独立检查 spec §3 / §11 的硬约束，' +
      'Person 负责收尾对接。',
    oneLiner: '实现 Person | Team 双表面，把 ApprovalCard 接到 managed-work，让 fixture 跑通三席。',
    explicit:
      '不要重命名 TopLevelMode；不要把 Person 改成 tab；新建 desktop/src/surfaces/。',
    inferred:
      '用户对"UI 太重"敏感：首版应尽量轻，视觉权重低于 Code | Work。',
    baseline:
      '新代码必须使用 desktop/src/styles/tokens.css 现有 token；不许造新颜色。',
  },
  seats: FIXTURE_SEATS,
});
