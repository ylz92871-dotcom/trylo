import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TeamSurface } from './TeamSurface';
import { resetComposerDraftForTests } from './composer/composer-draft';
import { FIXTURE_FROZEN_PROFILE, FIXTURE_TEAM_RUN } from './team-fixture';
import { emptyTeamRun } from './team-store';
import type { TeamProfile } from './team-profile-types';
import type { TeamRun } from './team-types';

afterEach(() => {
  resetComposerDraftForTests();
});

function runWith(overrides: Partial<TeamRun>): TeamRun {
  return { ...FIXTURE_TEAM_RUN, ...overrides };
}

function terminalRun(id: string): TeamRun {
  return emptyTeamRun({
    id,
    workspaceId: 'ws',
    personConversationId: 'conv',
    status: 'completed',
    summary: { title: 'T', goal: 'g', oneLiner: '跑完的团队' },
    frozenProfile: FIXTURE_FROZEN_PROFILE,
    seats: [
      { id: 's1', seat: 'worker', status: 'completed', summary: '完成' },
    ],
  });
}

describe('surfaces/team/TeamSurface (Foundation spec §10.3 / §10.5)', () => {
  it('no run → the light idle with template rows, no LandingSurface hero', () => {
    render(<TeamSurface run={null} onSelectSeat={() => {}} />);
    expect(screen.getByText(/在设置里打开 Team|选一个模板/)).toBeTruthy();
    expect(screen.getByText('实现小改动')).toBeTruthy();
    expect(screen.getByText('只审不写')).toBeTruthy();
    // Landing empty + fixture CTA are gone for good.
    expect(screen.queryByRole('button', { name: '加载示例' })).toBeNull();
    expect(screen.queryByRole('button', { name: '回到 Person' })).toBeNull();
  });

  it('flags off ⇒ no dead 开始 button, templates stay visible', () => {
    render(<TeamSurface run={null} onSelectSeat={() => {}} />);
    expect(screen.queryByRole('button', { name: '开始' })).toBeNull();
    expect(screen.getByText(/在设置里打开 Team/)).toBeTruthy();
  });

  it('composerLive + last prompt ⇒ 用刚才那句话组一组', () => {
    const onSuggest = vi.fn();
    render(
      <TeamSurface
        run={null}
        onSelectSeat={() => {}}
        onSuggest={onSuggest}
        canSuggest
        composerLive
        lastPrompt="把登录页收口"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '用刚才那句话组一组' }));
    expect(onSuggest).toHaveBeenCalled();
  });

  it('flags off even with a prompt ⇒ continue entry hidden', () => {
    render(
      <TeamSurface
        run={null}
        onSelectSeat={() => {}}
        onSuggest={() => {}}
        canSuggest
        composerLive={false}
        lastPrompt="x"
      />,
    );
    expect(screen.queryByRole('button', { name: '用刚才那句话组一组' })).toBeNull();
  });

  it('a live run renders the member list — one row per seat, no bottom strip', () => {
    render(<TeamSurface run={FIXTURE_TEAM_RUN} onSelectSeat={() => {}} />);
    expect(screen.getByText(FIXTURE_TEAM_RUN.summary.oneLiner)).toBeTruthy();
    expect(screen.getByText('进行中')).toBeTruthy();
    // Member rows show displayName (role fallback) + status words.
    expect(screen.getByRole('button', { name: /代表你 已完成/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /动手 运行中/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /审查 排队/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /动手 运行中/ })).toHaveLength(1);
  });

  it('clicking a member selects it; clicking the expanded member collapses it', () => {
    const onSelect = vi.fn();
    const first = render(<TeamSurface run={FIXTURE_TEAM_RUN} onSelectSeat={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /动手 运行中/ }));
    expect(onSelect).toHaveBeenCalledWith('fixture-seat-worker');
    first.unmount();

    render(
      <TeamSurface
        run={runWith({ selectedSeatId: 'fixture-seat-worker' })}
        onSelectSeat={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /动手 运行中/ }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('an expanded member shows the quiet detail: 收起, 独立 — no 返回摘要 identity', () => {
    render(
      <TeamSurface
        run={runWith({ selectedSeatId: 'fixture-seat-reviewer' })}
        onSelectSeat={() => {}}
        onCancelSeat={() => {}}
      />,
    );
    expect(screen.getByText('收起')).toBeTruthy();
    expect(screen.getByText('独立')).toBeTruthy();
    expect(screen.queryByText('返回摘要')).toBeNull();
  });

  it('a terminal run STAYS in the run view with the muted 新团队 button', () => {
    render(<TeamSurface run={terminalRun('done-1')} onSelectSeat={() => {}} />);
    expect(screen.getByText('跑完的团队')).toBeTruthy();
    expect(screen.getByRole('button', { name: '新团队' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
  });

  it('新团队 flips to idle without clearing the run', () => {
    render(<TeamSurface run={terminalRun('done-2')} onSelectSeat={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '新团队' }));
    expect(screen.getByText(/在设置里打开 Team|选一个模板/)).toBeTruthy();
  });

  it('新团队 stays on idle when the parent re-renders the same terminal run', () => {
    const run = terminalRun('done-stay');
    const { rerender } = render(<TeamSurface run={run} onSelectSeat={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '新团队' }));
    rerender(<TeamSurface run={run} onSelectSeat={() => {}} />);
    expect(screen.getByText(/在设置里打开 Team|选一个模板/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '新团队' })).toBeNull();
  });

  it('composer goal typing actually updates the input (singleton + re-render)', () => {
    const profile: TeamProfile = {
      schemaVersion: 1,
      id: 'small-change',
      origin: 'builtin',
      surface: 'code',
      title: '实现小改动',
      createdAt: 1,
      updatedAt: 1,
      members: [
        { memberId: 'm-p', baseRole: 'person', displayName: '代表你', overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' } },
        { memberId: 'm-w', baseRole: 'worker', displayName: '动手', overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' } },
      ],
    };
    render(
      <TeamSurface
        run={null}
        composerLive
        templateProfiles={[profile]}
        onSelectSeat={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('实现小改动'));
    const input = screen.getByPlaceholderText('这场团队要完成什么');
    fireEvent.change(input, { target: { value: '把登录页收口' } });
    expect(screen.getByDisplayValue('把登录页收口')).toBeTruthy();
  });

  it('Escape collapses the expanded member', () => {
    const onSelect = vi.fn();
    render(
      <TeamSurface
        run={runWith({ selectedSeatId: 'fixture-seat-worker' })}
        onSelectSeat={onSelect}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('stop renders for a live run and is wired through onStopRun', () => {
    const onStop = vi.fn();
    render(
      <TeamSurface run={FIXTURE_TEAM_RUN} onSelectSeat={() => {}} onStopRun={onStop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
