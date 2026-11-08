import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { TeamEventFeed } from './TeamEventFeed';
import { FIXTURE_TEAM_RUN } from '../team-fixture';
import { Message } from '../../../components/chat/Message';
import type { ChatMessage } from '../../../components/chat/types';
afterEach(cleanup);

it('shows current-run compaction transitions through the shared renderer without leaking other notices or old runs', () => {
  const run = { ...FIXTURE_TEAM_RUN, reports: [], handoffs: [], seats: [] };
  const notice = (id: string, text: string, createdAt = run.createdAt + 1): ChatMessage => ({ id, kind: 'notice', role: 'system', text, createdAt });
  const common = { run, onSelectSeat: () => {}, onOpenHandoff: () => {}, environment: { renderEvent: (message: ChatMessage) => <Message message={message} /> } };
  const view = render(<TeamEventFeed {...common} personMessages={[
    notice('old', 'Compacting context (180k → —)…', run.createdAt - 1),
    notice('other', 'other runtime diagnostic'), notice('pending', 'Compacting context (180k → —)…'),
  ]} />);
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(screen.getByRole('status').textContent).toBe('正在压缩上下文');
  expect(view.container.textContent).not.toContain('other runtime diagnostic');
  view.rerender(<TeamEventFeed {...common} personMessages={[notice('failure', '上下文压缩未完成：not committed')]} />);
  expect(screen.getByRole('status').textContent).toBe('上下文压缩未完成');
  view.rerender(<TeamEventFeed {...common} personMessages={[{ id: 'done', kind: 'compaction', role: 'system', createdAt: run.createdAt + 3, reason: 'auto', tokensBefore: 180000, tokensAfter: 40000 }]} />);
  expect(screen.getByRole('status').textContent).toBe('上下文已压缩');
  expect(screen.getAllByRole('status')).toHaveLength(1);
});
