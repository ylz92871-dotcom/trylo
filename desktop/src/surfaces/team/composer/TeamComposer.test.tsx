import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { TeamComposer } from './TeamComposer';
import { blankCustomDraft, setGoal, type ComposerDraft } from './composer-store';

const MODEL_CHOICES = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'claude-main', label: '当前主模型 · claude-main' },
];

/** Stateful harness: the real host holds the draft (the singleton in
 *  production); without this the onChange round-trip is lost. */
function StatefulComposer(overrides: {
  readonly composerLive?: boolean;
  readonly initialDraft: ComposerDraft;
  readonly onStart?: (goal: string) => void;
  readonly onSaveAs?: (name: string) => void;
}) {
  const [draft, setDraft] = useState(overrides.initialDraft);
  return (
    <TeamComposer
      draft={draft}
      modelChoices={MODEL_CHOICES}
      composerLive={overrides.composerLive ?? true}
      allowNoWorker={false}
      canOverwriteSaved={false}
      onChange={setDraft}
      onStart={overrides.onStart ?? (() => undefined)}
      onSaveAs={overrides.onSaveAs ?? (() => undefined)}
      onBackToIdle={() => undefined}
    />
  );
}

function renderComposer(overrides: {
  readonly composerLive?: boolean;
  readonly onStart?: (goal: string) => void;
  readonly draft?: ReturnType<typeof blankCustomDraft>;
  readonly onSaveAs?: (name: string) => void;
} = {}) {
  const draft = overrides.draft ?? setGoal(blankCustomDraft('code'), '把导出路径改成配置项');
  return render(
    <StatefulComposer
      initialDraft={draft}
      composerLive={overrides.composerLive}
      onStart={overrides.onStart}
      onSaveAs={overrides.onSaveAs}
    />,
  );
}

describe('TeamComposer (Foundation spec §10.4)', () => {
  it('shows title, goal input, and a duty roster — inspector stays closed', () => {
    renderComposer();
    expect(screen.getByText('自定义团队')).toBeTruthy();
    expect(screen.getByDisplayValue('把导出路径改成配置项')).toBeTruthy();
    expect(screen.getByText('代表你')).toBeTruthy();
    expect(screen.getByText('动手')).toBeTruthy();
    expect(screen.queryByText('选择左侧成员查看配置')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('开始 always renders; flags off ⇒ disabled with the flag reason', () => {
    renderComposer({ composerLive: false });
    const start = screen.getByRole('button', { name: '开始' });
    expect(start.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/在设置里打开 Team/)).toBeTruthy();
  });

  it('empty goal disables 开始 with 缺少目标 (never hides the button)', () => {
    renderComposer({ draft: blankCustomDraft('code') });
    expect(screen.getByRole('button', { name: '开始' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('缺少目标')).toBeTruthy();
  });

  it('a complete draft enables 开始 and forwards the goal', () => {
    const onStart = vi.fn();
    renderComposer({ onStart });
    const start = screen.getByRole('button', { name: '开始' });
    expect(start.hasAttribute('disabled')).toBe(false);
    fireEvent.click(start);
    expect(onStart).toHaveBeenCalledWith('把导出路径改成配置项');
  });

  it('removing the worker surfaces the needs-a-worker reason', () => {
    const draft = blankCustomDraft('code');
    const withoutWorker = { ...draft, members: [draft.members[0]!] };
    renderComposer({ draft: setGoal(withoutWorker, '有个目标') });
    expect(screen.getByText('需要一个 Worker，或改用只审模板')).toBeTruthy();
  });

  it('另存为模板 opens the name dialog and saves (builtin: no overwrite)', () => {
    const onSaveAs = vi.fn();
    renderComposer({ onSaveAs });
    fireEvent.click(screen.getByRole('button', { name: '另存为' }));
    fireEvent.change(screen.getByPlaceholderText('模板名称'), { target: { value: '前端小改' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSaveAs).toHaveBeenCalledWith('前端小改');
    expect(screen.queryByRole('button', { name: '覆盖保存' })).toBeNull();
  });

  it('Person row shows the disabled remove affordance (组队必须有 Person)', () => {
    renderComposer();
    const personRow = screen.getAllByRole('button', { name: /移除 / })[0]!;
    expect(personRow.hasAttribute('disabled')).toBe(true);
  });

  it('model picker lists Inherit and main model only after 高级', () => {
    renderComposer();
    fireEvent.click(screen.getByText('动手'));
    fireEvent.click(screen.getByRole('button', { name: '高级' }));
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.options).toHaveLength(2);
    expect(select.options[0]!.value).toBe('inherit');
  });
});
