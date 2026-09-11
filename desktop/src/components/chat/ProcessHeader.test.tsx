// Trylo Desktop — ProcessHeader tests.
//
// 2026-09-04 (CLI 单核): the Work runtime / ControlPlane connection
// awareness (M3 §11.1, the old 「执行端启动失败」 red banner) retired with
// the workd daemon. The header now derives everything from the shared
// CLI-supervisor view state — these tests pin the label/tone table and
// the idle/hide behavior.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProcessHeader } from './ProcessHeader';

const base = {
  messages: [] as const,
  running: false,
  workspace: 'D:/repo',
};

const liveMessages = [
  {
    id: 'u1',
    kind: 'text' as const,
    role: 'user' as const,
    createdAt: 1000,
    turnId: 'u1',
    text: 'do the thing',
    partial: false,
  },
] as never[];

describe('ProcessHeader idle / hide behavior', () => {
  it('an idle empty surface shows the ready label and the workspace', () => {
    render(<ProcessHeader {...base} />);
    expect(screen.getByText('已就绪')).toBeTruthy();
    expect(screen.getByText('repo')).toBeTruthy();
  });

  it('a finished conversation hides the header entirely', () => {
    const { container } = render(
      <ProcessHeader {...base} messages={liveMessages} viewState="completed" />,
    );
    expect(container.firstElementChild).toBeNull();
  });

  it('a cancelled conversation hides the header entirely', () => {
    const { container } = render(
      <ProcessHeader {...base} messages={liveMessages} viewState="cancelled" />,
    );
    expect(container.firstElementChild).toBeNull();
  });
});

describe('ProcessHeader label/tone per ViewState (§11.4)', () => {
  // A minimal running-tool message so the tail derivation
  // reaches `tool_running`.
  const runningTool = [
    {
      id: 't1',
      kind: 'tool' as const,
      role: 'assistant' as const,
      createdAt: 1000,
      turnId: 'u1',
      tool: 'read',
      summary: 'read a.ts',
      status: 'running',
    },
  ];

  it('renders the same label + tone from the explicit shared viewState', () => {
    const cases: Array<[string, string, string]> = [
      // state, expected label, expected dot tone class
      ['tool_running', '正在执行…', 'process-header__dot--running'],
      ['thinking', '思考中…', 'process-header__dot--running'],
      ['waiting_first_output', '正在执行…', 'process-header__dot--running'],
      ['awaiting_input', '等待你的回复', 'process-header__dot--ready'],
      ['reconnecting', '正在重新连接…', 'process-header__dot--running'],
      ['completed', '已完成', 'process-header__dot--ready'],
      ['failed', '失败', 'process-header__dot--error'],
      ['cancelled', '已停止', 'process-header__dot--error'],
    ] as const;
    for (const [state, label, tone] of cases) {
      const { unmount } = render(
        <ProcessHeader {...base} viewState={state as never} />,
      );
      expect(screen.getByText(label)).toBeTruthy();
      expect(document.querySelector(`.${tone}`)).not.toBeNull();
      unmount();
    }
  });

  it('derives the running label from Code props alone (single core)', () => {
    const messages = runningTool as never[];
    render(<ProcessHeader {...base} running messages={messages} />);
    expect(screen.getByText('正在执行…')).toBeTruthy();
    expect(
      document.querySelector('.process-header__dot--running'),
    ).not.toBeNull();
  });

  it('the header dot pulses in every active phase, never when parked or terminal', () => {
    // reconnecting → header pulse is the primary; thinking →
    // secondary beside the footer dots; awaiting_input/completed
    // → parked/terminal, fully static.
    for (const state of ['reconnecting', 'thinking', 'waiting_first_output', 'tool_running', 'finalizing'] as const) {
      const view = render(
        <ProcessHeader {...base} viewState={state} />,
      );
      expect(
        document.querySelector('.process-header__dot--pulse'),
        state,
      ).not.toBeNull();
      view.unmount();
    }
    for (const state of ['awaiting_input', 'completed'] as const) {
      const view = render(<ProcessHeader {...base} viewState={state} />);
      expect(
        document.querySelector('.process-header__dot--pulse'),
        state,
      ).toBeNull();
      view.unmount();
    }
  });
});
