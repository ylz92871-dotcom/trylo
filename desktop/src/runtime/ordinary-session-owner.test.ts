import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LiveProcessInfo, ProcessService } from '../host-adapter/process-service'
import type { ProcessId } from '../host-adapter/types'
import { CodeRunController } from './code-run-controller'
import { ConversationRunSupervisor } from './conversation-run-supervisor'

const native = vi.hoisted(
  () =>
    ({
      spawn: vi.fn(),
      send: vi.fn(),
      closeInput: vi.fn(),
      stop: vi.fn(),
      list: vi.fn<[], Promise<readonly LiveProcessInfo[]>>(),
    }) satisfies ProcessService,
)
vi.mock('../host-adapter/index', () => ({ hostAdapter: { process: native } }))

const root: LiveProcessInfo = {
  id: 'detached-new-cli' as ProcessId,
  pid: 777,
  label: 'trylo-cli-v1',
  command: 'node',
  metadata: { projectKey: 'workspace', conversationId: 'chat', runId: 'original' },
}
const request = {
  prompt: 'continue this chat',
  surface: 'work' as const,
  settings: { cliPath: 'D:/cli/main.js', cwd: 'D:/workspace' },
  priorMessages: [],
  permissionLevel: 'workspace_write' as const,
  codeMode: 'agent' as const,
  onEvents() {},
}

beforeEach(() => {
  native.list.mockResolvedValue([])
  native.stop.mockResolvedValue(undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

it.each(['explicit-new-cli', 'default-new-cli'] as const)(
  'retains a detached ordinary owner before dispatch through %s',
  async (mode) => {
    let live = true
    const sibling = {
      ...root,
      id: 'another-chat' as ProcessId,
      metadata: { ...root.metadata, conversationId: 'other' },
    }
    native.list.mockImplementation(async () => (live ? [root, sibling] : [sibling]))
    native.stop.mockImplementation(async (id) => {
      expect(id).toBe(root.id)
      live = false
    })
    const run = vi.spyOn(CodeRunController.prototype, 'run').mockResolvedValue(undefined)
    const supervisor = new ConversationRunSupervisor()
    const settings =
      mode === 'explicit-new-cli'
        ? request.settings
        : { cliPath: 'D:/cli/main.js', cwd: 'D:/workspace' }

    await expect(supervisor.runCode('workspace', 'chat', { ...request, settings })).rejects.toThrow(
      '旧执行',
    )
    expect(run).not.toHaveBeenCalled()
    expect(supervisor.getViewState('workspace', 'chat')).toMatchObject({
      running: true,
      sendable: false,
      activeProcessId: root.id,
    })
    await supervisor.stopConversation('workspace', 'chat')
    expect(native.stop).toHaveBeenCalledTimes(1)
    await supervisor.runCode('workspace', 'chat', { ...request, settings })
    expect(run).toHaveBeenCalledTimes(1)
  },
)

it('does not start a competing ordinary resume when native ownership cannot be read', async () => {
  native.list.mockRejectedValue(new Error('native ownership unavailable'))
  const run = vi.spyOn(CodeRunController.prototype, 'run').mockResolvedValue(undefined)
  const supervisor = new ConversationRunSupervisor()
  await expect(supervisor.runCode('workspace', 'chat', request)).rejects.toThrow(
    'native ownership unavailable',
  )
  expect(run).not.toHaveBeenCalled()
})

it('preserves a root already owned by the same controller for its normal handoff', async () => {
  native.list.mockResolvedValue([root])
  const supervisor = new ConversationRunSupervisor()
  const controller = supervisor.controller('workspace', 'chat')
  const view = controller.getViewState()
  vi.spyOn(controller, 'getViewState').mockReturnValue({ ...view, activeProcessId: root.id })
  const run = vi.spyOn(controller, 'run').mockResolvedValue(undefined)
  await supervisor.runCode('workspace', 'chat', request)
  expect(run).toHaveBeenCalledTimes(1)
  expect(native.stop).not.toHaveBeenCalled()
})
