import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Message } from './Message';
import { CompactionCard } from './CompactionCard';
import { applyEvents } from './events';
import { latestContextTokens, type ChatMessage, type CompactionMessage } from './types';

const result: CompactionMessage = { id: 'compact', kind: 'compaction', role: 'system', createdAt: 2, reason: 'auto', tokensBefore: 180000, tokensAfter: 40000 };

it('identifies compression counts as estimates rather than exact provider billing', () => {
  const view = render(<CompactionCard message={result} />);
  expect(view.container.querySelector('.compaction__unit')?.textContent).toContain('估算');
});
afterEach(cleanup);

it('renders runtime start and completion through one treatment without changing canonical events or readings', () => {
  const initial: ChatMessage[] = [];
  const pending = applyEvents(initial, [{ type: 'compaction_trigger', seq: 1, ts: 1, trigger: 'auto', preTokens: 180000, postTokens: 0 }]);
  const notice = pending.at(-1)!;
  const source = JSON.stringify(pending);
  const view = render(<Message message={notice} />);
  expect(screen.getByRole('status').textContent).toBe('正在压缩上下文');
  expect(view.container.querySelector('.compaction')?.getAttribute('data-state')).toBe('running');
  expect(view.container.querySelector('.runtime-notice')).toBeNull();
  expect(view.container.textContent).not.toMatch(/0%|100%|→|0k/);
  expect(JSON.stringify(pending)).toBe(source);
  const complete = applyEvents(pending, [{ type: 'compact', seq: 2, ts: 2, kind: 'after', reason: 'auto', tokensBefore: 180000, tokensAfter: 40000 }]);
  view.rerender(<Message message={complete.at(-1)!} />);
  expect(view.container.querySelector('[data-state="running"]')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('上下文已压缩');
  expect(screen.getByLabelText('压缩前：180k tokens；压缩后：40k tokens')).toBeTruthy();
  expect(latestContextTokens(complete)).toBe(40000);
});

it('keeps the exact failure reason inspectable and removes pending UI without claiming completion', () => {
  const detail = 'mid_stream:network — verify endpoint\nThe runtime did not commit the compacted window.';
  const pending = applyEvents([], [{ type: 'compaction_trigger', seq: 1, ts: 1, trigger: 'manual', preTokens: 180000, postTokens: 0 }]);
  const failed = applyEvents(pending, [{ type: 'compact', seq: 2, ts: 2, kind: 'after', reason: detail, status: 'failed' }]);
  const view = render(<Message message={failed.at(-1)!} />);
  expect(screen.getByRole('status').textContent).toBe('上下文压缩未完成');
  const disclosure = view.container.querySelector('details')!;
  expect(disclosure.open).toBe(false);
  expect(disclosure.querySelector('pre')?.textContent).toBe(detail);
  fireEvent.click(screen.getByText('查看原因'));
  expect(disclosure.open).toBe(true);
  expect(view.container.querySelector('.compaction__usage')).toBeNull();
  expect(view.container.querySelector('[data-state="running"]')).toBeNull();
  expect(view.container.querySelector('button')).toBeNull();
  expect(failed.some(message => message.kind === 'compaction')).toBe(false);
});

it.each([
  [{ tokensBefore: undefined, tokensAfter: undefined }, null],
  [{ tokensBefore: NaN, tokensAfter: Infinity }, null],
  [{ tokensBefore: -1, tokensAfter: 0 }, null],
  [{ tokensBefore: 180000, tokensAfter: undefined }, '压缩前：180k tokens；压缩后：— tokens'],
  [{ tokensBefore: undefined, tokensAfter: 3400 }, '压缩前：— tokens；压缩后：3.4k tokens'],
] as const)('does not invent missing legacy counts: %j', (counts, label) => {
  const view = render(<CompactionCard message={{ ...result, ...counts }} />);
  expect(screen.getByRole('status').textContent).toBe('上下文已压缩');
  if (label) {
    const usage = screen.getByLabelText(label);
    expect(usage).toBeTruthy();
    expect(usage.title).not.toMatch(/减少|增加/);
  }
  else expect(view.container.querySelector('.compaction__usage')).toBeNull();
  expect(view.container.textContent).not.toMatch(/undefined|NaN|Infinity/);
});

it('keeps ordinary notices and assistant prose on their existing routes', () => {
  const view = render(<Message message={{ id: 'n', kind: 'notice', role: 'system', createdAt: 1, text: '模型已连接' }} />);
  expect(view.container.querySelector('.runtime-notice')?.textContent).toContain('模型已连接');
  expect(view.container.querySelector('.compaction')).toBeNull();
  view.rerender(<Message message={{ id: 'a', kind: 'text', role: 'assistant', createdAt: 2, text: 'Compacting context is a runtime operation.' }} />);
  expect(view.container.querySelector('.compaction')).toBeNull();
  expect(view.container.textContent).toContain('Compacting context is a runtime operation.');
});


it('labels before and after usage explicitly and reports the reduction rather than mistaking remaining tokens for freed tokens', () => {
  render(<CompactionCard message={{ ...result, tokensBefore: 184175, tokensAfter: 172965 }} />);
  expect(screen.getByText('压缩前 184k')).toBeTruthy();
  expect(screen.getByText('压缩后 173k')).toBeTruthy();
  const usage = screen.getByLabelText('压缩前：184k tokens；压缩后：173k tokens');
  expect(usage.title).toBe('压缩前：184,175 tokens；压缩后：172,965 tokens；减少：11,210 tokens');
});
