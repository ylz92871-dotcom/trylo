import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PersonTeamComposeHint, PersonTeamStatusBar } from './PersonTeamStatusBar';
import { FIXTURE_FROZEN_PROFILE, FIXTURE_TEAM_RUN } from '../team/team-fixture';
import { applySeatPatch, emptyTeamRun } from '../team/team-store';
import type { TeamRun } from '../team/team-types';

const MINIMAL_SUMMARY = {
  title: '做 X',
  goal: '把 X 做完。',
  oneLiner: '把 X 做完。',
};

describe('surfaces/person/PersonTeamStatusBar (Foundation spec §10.7)', () => {
  it('renders nothing when there is no run', () => {
    const { container } = render(
      <PersonTeamStatusBar run={null} onOpenTeam={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for a terminal run', () => {
    const run: TeamRun = { ...FIXTURE_TEAM_RUN, status: 'completed' };
    const { container } = render(
      <PersonTeamStatusBar run={run} onOpenTeam={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('prefers the specialist over Person when both are running', () => {
    const run: TeamRun = emptyTeamRun({
      id: 'r',
      workspaceId: 'w',
      personConversationId: 'c',
      status: 'running',
      summary: MINIMAL_SUMMARY,
      frozenProfile: FIXTURE_FROZEN_PROFILE,
      seats: [
        { id: 'p', seat: 'person', displayName: '代表你', status: 'running', summary: '派出成员' },
        { id: 'w', seat: 'worker', displayName: '动手', status: 'running', summary: '改 Login.tsx' },
      ],
    });
    render(<PersonTeamStatusBar run={run} onOpenTeam={() => {}} />);
    expect(screen.getByText(/动手 运行中 · 改 Login.tsx/)).toBeTruthy();
    expect(screen.getByText(/团队进行中/).textContent).not.toContain('代表你');
  });

  it('one line: 团队进行中 · <active member> <status> · <summary>', () => {
    render(
      <PersonTeamStatusBar run={FIXTURE_TEAM_RUN} onOpenTeam={() => {}} />,
    );
    const line = screen.getByText(/团队进行中 · 动手 运行中 · 正在实现/);
    // No icon/pill chrome; the only affordance is the 查看 button.
    expect(line.querySelector('svg')).toBeNull();
    expect(screen.getByRole('button', { name: '查看' })).toBeTruthy();
  });

  it('never mentions queued-only members in the active fragment', () => {
    render(
      <PersonTeamStatusBar run={FIXTURE_TEAM_RUN} onOpenTeam={() => {}} />,
    );
    const line = screen.getByText(/团队进行中/);
    expect(line.textContent).not.toContain('Reviewer');
  });

  it('compose hint is a single quiet line', () => {
    const onCompose = vi.fn();
    render(<PersonTeamComposeHint onCompose={onCompose} />);
    fireEvent.click(screen.getByRole('button', { name: '组一组' }));
    expect(onCompose).toHaveBeenCalledTimes(1);
  });

  it('invokes onOpenTeam when 查看 is clicked', () => {
    const onOpen = vi.fn();
    render(
      <PersonTeamStatusBar run={FIXTURE_TEAM_RUN} onOpenTeam={onOpen} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('does not render when run.seats is empty (never a 组队 nag)', () => {
    const run: TeamRun = emptyTeamRun({
      id: 'r',
      workspaceId: 'w',
      personConversationId: 'c',
      summary: MINIMAL_SUMMARY,
      frozenProfile: FIXTURE_FROZEN_PROFILE,
    });
    const { container } = render(
      <PersonTeamStatusBar run={run} onOpenTeam={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('still renders when the only seat is queued (run is still active)', () => {
    const run: TeamRun = emptyTeamRun({
      id: 'r',
      workspaceId: 'w',
      personConversationId: 'c',
      summary: MINIMAL_SUMMARY,
      frozenProfile: FIXTURE_FROZEN_PROFILE,
      seats: [{ id: 's-w', seat: 'worker', status: 'queued', summary: '排队' }],
    });
    render(<PersonTeamStatusBar run={run} onOpenTeam={() => {}} />);
    expect(screen.getByText(/团队进行中 · 等待开始/)).toBeTruthy();
  });

  it('two workers never render as "Worker · Worker" — displayName wins', () => {
    const run: TeamRun = emptyTeamRun({
      id: 'r',
      workspaceId: 'w',
      personConversationId: 'c',
      status: 'running',
      summary: MINIMAL_SUMMARY,
      frozenProfile: FIXTURE_FROZEN_PROFILE,
      seats: [
        { id: 'w1', seat: 'worker', displayName: 'Worker · 代码', status: 'completed', summary: 'a' },
        { id: 'w2', seat: 'worker', displayName: 'Worker · 文档', status: 'running', summary: '正在写文档' },
      ],
    });
    render(<PersonTeamStatusBar run={run} onOpenTeam={() => {}} />);
    expect(screen.getByText(/Worker · 文档 运行中 · 正在写文档/)).toBeTruthy();
  });

  it('survives a seat being patched without re-mounting (store pure functions)', () => {
    const patched: TeamRun = applySeatPatch(FIXTURE_TEAM_RUN, 'fixture-seat-worker', { status: 'completed', result: 'done' });
    expect(patched.seats.find((s) => s.id === 'fixture-seat-worker')?.status).toBe('completed');
    render(<PersonTeamStatusBar run={patched} onOpenTeam={() => {}} />);
    // Worker completed; the run still has a queued member so it renders.
    expect(screen.getByText(/团队进行中/)).toBeTruthy();
  });
});
