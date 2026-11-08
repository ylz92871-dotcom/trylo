import { cleanup, fireEvent, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationDisclosureProvider } from './conversation-disclosure';
import { CodeReasoningTranscript } from './CodeReasoningTranscript';
import { ToolCard } from './ToolCard';
import { FileChangeCards } from './FileChangeCard';
import type { ThinkingMessage, ToolMessage } from './types';

afterEach(cleanup);
const note: ThinkingMessage = { id: 'note', kind: 'thinking', role: 'assistant', createdAt: 1,
  turnId: 'user', phaseId: 'phase', summary: '先核对文件', preview: '原始思考正文。\n第二行也保留。', fullLength: 17, turn: 1, partial: false };
const tool: ToolMessage = { id: 'tool', kind: 'tool', role: 'assistant', createdAt: 2,
  turnId: 'user', phaseId: 'phase', tool: 'Bash', summary: '检查文件', status: 'done',
  input: { command: 'git diff --stat' }, outputText: '检查完成。' };
const entries = [note, tool];
const phase = (items = entries) => <CodeReasoningTranscript entries={items} active={false} turnId="user" phaseId="phase" />;
const head = (container: HTMLElement, selector = '.code-reasoning__head') => container.querySelector(selector)!;

describe('reader disclosure choices survive virtual row recycling', () => {
  it('restores both the process and its manually opened tool with their original content', () => {
    const tree = (show: boolean) => <ConversationDisclosureProvider messages={entries}>{show && phase()}</ConversationDisclosureProvider>;
    const view = render(tree(true));
    fireEvent.click(head(view.container));
    fireEvent.click(head(view.container, '.tool__head'));
    view.rerender(tree(false));
    expect(view.container.querySelector('.code-reasoning')).toBeNull();
    view.rerender(tree(true));
    expect(head(view.container)).toHaveAttribute('aria-expanded', 'true');
    expect(head(view.container, '.tool__head')).toHaveAttribute('aria-expanded', 'true');
    expect(view.container.querySelector('.code-reasoning__passage-text')?.textContent).toBe(note.preview);
    expect(view.getByText(tool.outputText!)).toBeInTheDocument();
  });

  it('keeps an explicitly closed error process closed after recycling and new output', () => {
    const failed: ToolMessage = { ...tool, status: 'error', outputError: 'Exit code 1' };
    const tree = (show: boolean, row = failed) => <ConversationDisclosureProvider messages={[note, row]}>{show && phase([note, row])}</ConversationDisclosureProvider>;
    const view = render(tree(true));
    expect(head(view.container)).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(head(view.container));
    view.rerender(tree(false));
    view.rerender(tree(true, { ...failed, outputText: '补充错误信息' }));
    expect(head(view.container)).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps different runs of the same phase independent', () => {
    const other = { ...note, id: 'other-note' };
    const tree = (show: boolean) => <ConversationDisclosureProvider messages={[...entries, other]}>{show && <>{phase()}{phase([other])}</>}</ConversationDisclosureProvider>;
    const view = render(tree(true));
    fireEvent.click(head(view.container));
    view.rerender(tree(false)); view.rerender(tree(true));
    expect([...view.container.querySelectorAll('.code-reasoning__head')].map(el => el.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
  });

  it('still derives automatic tool expansion from current status', () => {
    const tree = (status: ToolMessage['status']) => <ConversationDisclosureProvider messages={[tool]}><ToolCard message={{ ...tool, status }} variant="event" /></ConversationDisclosureProvider>;
    const view = render(tree('running'));
    expect(head(view.container, '.tool__head')).toHaveAttribute('aria-expanded', 'true');
    view.rerender(tree('done'));
    expect(head(view.container, '.tool__head')).toHaveAttribute('aria-expanded', 'false');
    view.rerender(tree('error'));
    expect(head(view.container, '.tool__head')).toHaveAttribute('aria-expanded', 'true');
  });

  it('prunes removed messages and releases choices at the conversation boundary', () => {
    const tree = (messages = entries, key = 'a') => <ConversationDisclosureProvider key={key} messages={messages}>{messages.length > 0 && phase()}</ConversationDisclosureProvider>;
    const view = render(tree()); fireEvent.click(head(view.container));
    view.rerender(tree([])); view.rerender(tree());
    expect(head(view.container)).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(head(view.container));
    view.rerender(tree(entries, 'b'));
    expect(head(view.container)).toHaveAttribute('aria-expanded', 'false');
  });

  it('defers never-opened process bodies, then preserves the body while collapsing', () => {
    const view = render(phase());
    expect(view.container.querySelector('.code-reasoning__passage')).toBeNull();
    expect(view.container.querySelector('.tool')).toBeNull();
    fireEvent.click(head(view.container));
    const passage = view.container.querySelector('.code-reasoning__passage');
    expect(passage).toHaveTextContent('原始思考正文');
    fireEvent.click(head(view.container));
    expect(view.container.querySelector('.code-reasoning__passage')).toBe(passage);
    expect(head(view.container)).toHaveAttribute('aria-expanded', 'false');
  });

  it('restores a file diff independently from other files in the same invocation', () => {
    const edit: ToolMessage = { ...tool, id: 'edit', tool: 'apply_patch', input: { patch: '*** Begin Patch\n*** Update File: src/panel.ts\n@@\n-old\n+new\n*** Update File: src/other.ts\n@@\n-before\n+after\n*** End Patch' } };
    const tree = (show: boolean) => <ConversationDisclosureProvider messages={[edit]}>{show && <FileChangeCards message={edit} variant="event" />}</ConversationDisclosureProvider>;
    const view = render(tree(true));
    fireEvent.click(head(view.container, '.fchange__head'));
    view.rerender(tree(false)); view.rerender(tree(true));
    expect([...view.container.querySelectorAll('.fchange__head')].map(el => el.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
    expect(view.container.querySelector('.fchange__diff')).toHaveTextContent('new');
  });
});
