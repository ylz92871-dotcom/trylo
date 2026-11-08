import { act, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EventReasoningNote } from './EventReasoningNote';
import type { ThinkingMessage } from './types';

const note = (preview: string, partial = true, id = 'reasoning-1'): ThinkingMessage => ({
  id, kind: 'thinking', role: 'assistant', createdAt: 1, turn: 1,
  preview, summary: '查看布局', fullLength: preview.length, partial,
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function animateTimers() {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  // jsdom's RAF captures its own clock; bind frames to the controlled clock.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
}
const body = (container: HTMLElement) => container.querySelector('.code-reasoning__passage-text')!.textContent!;

it('reveals a large received fragment over frames instead of inserting a whole paragraph', () => {
  animateTimers();
  const raw = '正在逐项检查页面布局和输入框尺寸。'.repeat(40);
  const view = render(<EventReasoningNote message={note(raw)} />);
  const first = body(view.container);
  expect(first.length).toBeGreaterThan(0);
  expect(first.length).toBeLessThan(raw.length);
  expect(raw.startsWith(first)).toBe(true);
  act(() => { vi.advanceTimersByTime(48); });
  const middle = body(view.container);
  expect(middle.length).toBeGreaterThan(first.length);
  expect(middle.length).toBeLessThan(raw.length);
  expect(raw.startsWith(middle)).toBe(true);
  act(() => { vi.advanceTimersByTime(180); });
  expect(body(view.container)).toBe(raw);
});

it('shows short real deltas immediately and flushes the exact final Markdown', () => {
  animateTimers();
  const view = render(<EventReasoningNote message={note('查')} />);
  expect(body(view.container)).toBe('查');
  view.rerender(<EventReasoningNote message={note('查看布局')} />);
  expect(body(view.container)).toBe('查看布局');
  const final = '查看布局：'.repeat(100) + '\n\n**完成**';
  view.rerender(<EventReasoningNote message={note(final, false)} />);
  expect([...view.container.querySelectorAll('.code-reasoning__passage-text p')].map(p => p.textContent)).toEqual(['查看布局：'.repeat(100), '完成']);
  expect(view.container.querySelector('strong')?.textContent).toBe('完成');
  act(() => { vi.advanceTimersByTime(300); });
  expect([...view.container.querySelectorAll('.code-reasoning__passage-text p')].map(p => p.textContent)).toEqual(['查看布局：'.repeat(100), '完成']);
});

it('keeps the latest snapshot while streaming and clears pending frames on note changes', () => {
  animateTimers();
  const first = '检查组件。'.repeat(90);
  const view = render(<EventReasoningNote message={note(first)} />);
  act(() => { vi.advanceTimersByTime(48); });
  view.rerender(<EventReasoningNote message={note(first + '更新结果。'.repeat(60))} />);
  act(() => { vi.advanceTimersByTime(128); });
  expect(body(view.container)).toBe(first + '更新结果。'.repeat(60));
  view.rerender(<EventReasoningNote message={note('新的思考', true, 'reasoning-2')} />);
  act(() => { vi.advanceTimersByTime(300); });
  expect(body(view.container)).toBe('新的思考');
  view.rerender(<EventReasoningNote message={note(first, true, 'reasoning-3')} />);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('renders received text immediately when reduced motion is requested', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const raw = '检查无动画显示。'.repeat(100);
  const view = render(<EventReasoningNote message={note(raw)} />);
  expect(body(view.container)).toBe(raw);
});

it('replaces incompatible snapshots without leaking prior text or cutting Unicode pairs', () => {
  animateTimers();
  const view = render(<EventReasoningNote message={note('A'.repeat(23) + '😀' + '旧内容'.repeat(80))} />);
  expect(body(view.container)).toBe('A'.repeat(23));
  const changed = '新内容🧭'.repeat(80);
  view.rerender(<EventReasoningNote message={note(changed)} />);
  expect(changed.startsWith(body(view.container))).toBe(true);
  act(() => { vi.advanceTimersByTime(180); });
  expect(body(view.container)).toBe(changed);
});
