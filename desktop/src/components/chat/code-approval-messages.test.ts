import { expect, it } from 'vitest';
import { codeApprovalMessages, mergeCodeApprovals } from './code-approval-messages';
import type { CodePermissionRequest } from '../../runtime/code-permission-registry';
import { createElement } from 'react';
import { act, render, screen } from '@testing-library/react';
import { useCodeApprovals } from './code-approval-messages';
import { ApprovalCard } from './ApprovalCard';

const request = (projectKey: string, requestId: string): CodePermissionRequest => ({
  requestId, processId: `root-${projectKey}`, projectKey, conversationId: 'same-conversation',
  toolName: 'write_file', input: { path: 'proof.txt' }, at: 1,
});

it('keeps identical conversation ids in different projects from sharing approval cards', () => {
  const cards = codeApprovalMessages([request('a', 'approval-a'), request('b', 'approval-b')], 'b', 'same-conversation');
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ approvalId: 'approval-b', pendingRequest: { processId: 'root-b', projectKey: 'b' } });
});

it('projects registry changes for Work without requiring a Code controller or a Code-view transition', () => {
  let pending: CodePermissionRequest[] = []; let version = 0;
  const listeners = new Set<() => void>();
  const source = { pendingCodePermissions: () => pending, getVersion: () => version,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const update = (requests: CodePermissionRequest[]) => { pending = requests; version += 1; for (const notify of listeners) notify(); };
  function WorkApprovalView() {
    const cards = useCodeApprovals(source, 'work-project', 'same-conversation');
    return createElement('div', { 'data-testid': 'work-approvals' }, cards.map(card => card.id).join(','));
  }
  const view = render(createElement(WorkApprovalView));
  try {
    expect(screen.getByTestId('work-approvals').textContent).toBe('');
    act(() => update([request('work-project', 'work-approval')]));
    expect(screen.getByTestId('work-approvals').textContent).toContain('work-approval');
    act(() => update([]));
    expect(screen.getByTestId('work-approvals').textContent).toBe('');
  } finally { view.unmount(); }
});

it('expires a persisted pending card without live ownership, while a new approval remains actionable', () => {
  const old = codeApprovalMessages([request('p', 'old')], 'p', 'same-conversation')[0]!;
  const live = codeApprovalMessages([request('p', 'new')], 'p', 'same-conversation');
  const messages = mergeCodeApprovals([old], live);
  expect(messages).toHaveLength(2);
  expect(messages[0]).toMatchObject({ approvalId: 'old', status: 'expired' });
  expect(messages[0]).not.toHaveProperty('pendingRequest');
  expect(messages[1]).toMatchObject({ approvalId: 'new', status: 'pending' });
  expect(old).toMatchObject({ status: 'pending' });
  const view = render(createElement('div', {}, messages.map(message => message.kind === 'approval'
    ? createElement(ApprovalCard, { key: message.id, message, onRespond() {} }) : null)));
  try {
    expect(view.container.querySelector('[data-status="expired"] button')).toBeNull();
    expect(screen.getAllByRole('button', { name: '批准并继续' })).toHaveLength(1);
  } finally { view.unmount(); }
});

it('replaces a stored pending snapshot with its live owner once, and expires it after stop', () => {
  const old = codeApprovalMessages([request('p', 'same')], 'p', 'same-conversation')[0]!;
  const live = codeApprovalMessages([{ ...request('p', 'same'), processId: 'current-process' }], 'p', 'same-conversation');
  const active = mergeCodeApprovals([old], live);
  expect(active).toHaveLength(1);
  expect(active[0]).toMatchObject({ status: 'pending', pendingRequest: { processId: 'current-process' } });
  expect(mergeCodeApprovals(active, [])[0]).toMatchObject({ status: 'expired' });
});
