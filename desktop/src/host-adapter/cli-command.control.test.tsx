import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { runCliCommand, type CliCommandControlPort } from './cli-command'
import type { ProcessService } from './process-service'
import type { FilePath } from './types'
import { CodePermissionRegistry } from '../runtime/code-permission-registry'
import { codeApprovalMessages } from '../components/chat/code-approval-messages'
import { ApprovalCard } from '../components/chat/ApprovalCard'
import { ConversationRunSupervisor } from '../runtime/conversation-run-supervisor'
import { LibraryProcessRecovery } from '../components/app-shell/LibraryProcessRecovery'

afterEach(() => { cleanup(); vi.useRealTimers(); })
function fixture(options: { graceful?: boolean } = {}) {
  let callbacks!: Parameters<ProcessService['spawn']>[0]
  const writes: { processId: string; line: string }[] = []
  const exit = () => callbacks.onExit?.({ id: 'library-owned', pid: 123, signal: null, code: 130, outputComplete: true });
  const process = {
    spawn: vi.fn(async (input: Parameters<ProcessService['spawn']>[0]) => {
      callbacks = input
      return { id: 'library-owned', pid: 123, label: input.label, command: input.command }
    }),
    stop: vi.fn(async (_id: string) => { exit(); }),
    closeInput: vi.fn(async (_id: string) => {}),
    send: vi.fn(async (id: string, line: string) => {
      writes.push({ processId: id, line })
      const frame = JSON.parse(line)
      if (frame.operation === 'submit')
        callbacks.onOutput(
          JSON.stringify({
            type: 'control_request',
            request_id: 'approval-create',
            request: {
              subtype: 'can_use_tool',
              tool_name: 'expert_library.create',
              input: { summary: '创建财务交接专家' },
            },
          }),
        )
      else if (frame.type === 'control_response') {
        callbacks.onOutput('{"state":"authorized"}')
        callbacks.onExit?.({
          id: 'library-owned',
          pid: 123,
          signal: null,
          code: 0,
          outputComplete: true,
        })
      }
      else if (frame.type === 'control_request' && frame.request?.subtype === 'interrupt' && options.graceful !== false) exit();
    }),
  }
  const registry = new CodePermissionRegistry({
    onChange: () => {},
    send: async (id, line) => {
      await process.send(id, line)
      return true
    },
  })
  const scope = { projectKey: 'workspace-a', conversationId: 'library:workspace-a' }
  const control: CliCommandControlPort = {
    receive: (frame, id) => registry.handleControlFrame(frame, { ...scope, processId: id }),
    clearProcess: (id) => registry.clearProcess(id),
  }
  return { process, registry, scope, control, writes, exit }
}
const paths = { cliPath: 'D:/candidate/main.js' as FilePath, cwd: 'D:/workspace-a' as FilePath }
it('uses the existing registry and ApprovalCard to return the actual user decision to the owning library process', async () => {
  const f = fixture()
  const result = runCliCommand({
    ...paths,
    process: f.process,
    args: ['library', 'expert', '--permission-prompt-tool', 'stdio', '-'],
    stdin: '{"operation":"submit"}\n',
    control: f.control,
  })
  await waitFor(() => expect(f.registry.list()).toHaveLength(1))
  expect(f.writes).toHaveLength(1)
  expect(f.process.closeInput).not.toHaveBeenCalled()
  const message = codeApprovalMessages(
    f.registry.list(),
    f.scope.projectKey,
    f.scope.conversationId,
  )[0]!
  if (message.kind !== 'approval') throw new Error('missing real approval projection')
  render(
    <ApprovalCard
      message={message}
      onRespond={(id, allow) => {
        void f.registry.respond(id, allow)
      }}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: '批准并继续' }))
  expect(await result).toEqual({ ok: true, stdout: '{"state":"authorized"}' })
  const response = JSON.parse(f.writes[1]!.line)
  expect(f.writes[1]!.processId).toBe('library-owned')
  expect(response.response.request_id).toBe('approval-create')
  expect(response.response.response.behavior).toBe('allow')
  expect(f.registry.list()).toHaveLength(0)
})
it('clears pending approval on cancellation and never sends a later user decision to a finished process', async () => {
  const f = fixture(),
    cancel = new AbortController()
  const result = runCliCommand({
    ...paths,
    process: f.process,
    args: ['library', 'expert', '-'],
    stdin: '{"operation":"submit"}\n',
    control: f.control,
    signal: cancel.signal,
  })
  await waitFor(() => expect(f.registry.list()).toHaveLength(1))
  cancel.abort()
  expect(await result).toEqual({ ok: false, reason: 'cancelled' })
  expect(f.registry.list()).toHaveLength(0)
  expect(await f.registry.respond('approval-create', true)).toBe(false)
  expect(f.process.stop).not.toHaveBeenCalled()
  expect(f.writes).toHaveLength(2)
  expect(JSON.parse(f.writes[1]!.line).request.subtype).toBe('interrupt');
})
it('retains an unconfirmed stop in the original Supervisor and lets the visible recovery action retry that exact handle', async () => {
  const f = fixture({ graceful: false }), supervisor = new ConversationRunSupervisor(), cancel = new AbortController();
  const control = supervisor.libraryApprovalPort({ ...f.scope, projectRoot: paths.cwd }), recovery = supervisor.libraryRecoveryPort();
  f.process.stop.mockRejectedValueOnce(new Error('actual-stop-failed'));
  const result = runCliCommand({ ...paths, process: f.process, args: ['library', 'expert', '-'], stdin: '{"operation":"submit"}\n', control, signal: cancel.signal });
  await waitFor(() => expect(supervisor.pendingCodePermissions()).toHaveLength(1));
  vi.useFakeTimers(); cancel.abort(); await vi.advanceTimersByTimeAsync(1600);
  expect(await result).toEqual({ ok: false, reason: 'stop_unconfirmed' });
  expect(recovery.statuses()).toEqual([{ processId: 'library-owned', workspaceRoot: paths.cwd, state: 'stop_unconfirmed', error: 'actual-stop-failed' }]);
  expect(control.canStart?.()).toBe(false); expect(supervisor.pendingCodePermissions()).toHaveLength(0);
  render(<LibraryProcessRecovery port={recovery} />);
  expect(screen.getByRole('alert')).toHaveTextContent('尚未确认停止');
  fireEvent.click(screen.getByRole('button', { name: '重试停止' }));
  await vi.advanceTimersByTimeAsync(1600);
  expect(f.process.stop.mock.calls.map(call => call[0])).toEqual(['library-owned', 'library-owned']);
  expect(recovery.statuses()).toHaveLength(0); expect(control.canStart?.()).toBe(true);
});
