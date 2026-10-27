import { expect, it, vi } from 'vitest';
import { sendWorkChat } from './work-chat-adapter';
import { settingsDefaults } from '../settings/settings-store';
import type { ConversationRunSupervisor } from '../runtime/conversation-run-supervisor';

it('forwards Work team mode and keeps ordinary Work sends unmarked', async () => {
  const runCode = vi.fn<Parameters<ConversationRunSupervisor['runCode']>, ReturnType<ConversationRunSupervisor['runCode']>>(async () => {});
  const supervisor = { runCode };
  const options = { projectKey: 'p', conversationId: 'c', text: 'g', settings: { ...settingsDefaults, cwd: 'D:/project' },
    permissionLevel: 'workspace_write' as const, priorMessages: [], onEvents: () => {} };
  await sendWorkChat(supervisor, { ...options, teamMode: true });
  expect(runCode).toHaveBeenLastCalledWith('p', 'c', expect.objectContaining({ surface: 'work', teamMode: true }));
  await sendWorkChat(supervisor, options);
  expect(runCode.mock.calls.at(-1)?.[2]).not.toHaveProperty('teamMode');
});
