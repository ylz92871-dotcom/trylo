import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { SurfaceHost } from '../SurfaceHost';
import { FIXTURE_TEAM_RUN } from './team-fixture';
import type { TeamRun } from './team-types';

it('preserves member drafts across Person / Team switches and isolates another team', () => {
  const run: TeamRun = { ...FIXTURE_TEAM_RUN, lifecycle: 'open', status: 'running', selectedSeatId: 'e1',
    seats: [{ id: 'e1', memberId: 'm1', taskId: 't1', seat: 'worker', status: 'running', summary: '正在检查',
      canReceiveInput: true }] };
  const props = { personView: <p>主对话</p>, teamRun: run, onSelectTeamSeat: () => {}, onTeamMemberInput: async () => {} };
  const view = render(<SurfaceHost {...props} collaborationSurface="team" />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '切换后保留中文草稿 🚀' } });
  view.rerender(<SurfaceHost {...props} collaborationSurface="person" />);
  view.rerender(<SurfaceHost {...props} collaborationSurface="team" />);
  expect(screen.getByRole('textbox')).toHaveValue('切换后保留中文草稿 🚀');
  view.rerender(<SurfaceHost {...props} teamRun={{ ...run, id: 'another-team' }} collaborationSurface="team" />);
  expect(screen.getByRole('textbox')).toHaveValue('');
  view.rerender(<SurfaceHost {...props} collaborationSurface="team" />);
  expect(screen.getByRole('textbox')).toHaveValue('切换后保留中文草稿 🚀');
});
