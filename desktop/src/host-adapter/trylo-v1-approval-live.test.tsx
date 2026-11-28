import { expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { NodeProcessFixture } from './cli-node-process.fixture'
import type { ProcessService } from './process-service'
import type { FilePath } from './types'
import { CodePermissionRegistry } from '../runtime/code-permission-registry'
import {
  codeApprovalMessages,
  mergeCodeApprovals,
  useCodeApprovals,
} from '../components/chat/code-approval-messages'
import { ApprovalCard } from '../components/chat/ApprovalCard'

const h = vi.hoisted(() => ({ service: null as ProcessService | null }))
vi.mock('./index', () => ({
  hostAdapter: {
    get process() {
      return h.service
    },
  },
}))
vi.mock('../runtime/cli-runtime-guard', () => ({
  verifyCliRuntime: vi.fn(async () => ({ ok: true })),
}))
const { CodeRunController } = await import('../runtime/code-run-controller')
const { ConversationRunSupervisor } = await import('../runtime/conversation-run-supervisor')

it.each([false, true])(
  'delivers approval to a real CLI and finishes, including retry after transport failure=%s',
  async (failFirstDelivery) => {
    const scratch = resolve('../_workspace/cache/tests/chat-approval')
    mkdirSync(scratch, { recursive: true })
    const root = mkdtempSync(join(scratch, 'live-'))
    const home = join(root, 'home'),
      workspace = join(root, 'workspace') as FilePath
    mkdirSync(home)
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'package.json'), '{}')
    execFileSync('git', ['init', '--quiet', workspace], { windowsHide: true })
    const service = new NodeProcessFixture({
      ...process.env,
      TRYLO_HOME: home,
      TRYLO_API_KEY: '',
      TRYLO_OPENAI_API_KEY: '',
      TEMP: root,
      TMP: root,
    })
    h.service = service
    if (failFirstDelivery) {
      const send = service.send.bind(service)
      let failed = false
      vi.spyOn(service, 'send').mockImplementation(async (id, line) => {
        if (!failed && (JSON.parse(line) as { type: string }).type === 'control_response') {
          failed = true
          throw new Error('fixture: first approval write rejected')
        }
        await send(id, line)
      })
    }
    // Use the production registry sender and the same projection as Code/Work.
    const permissions = new CodePermissionRegistry({ onChange() {} })
    const controller = new CodeRunController({
      projectKey: 'p',
      conversationId: 'approve',
      permissions,
      onChange() {},
    })
    try {
      await controller.run({
        prompt: 'write the fixture',
        permissionLevel: 'ask',
        codeMode: 'agent',
        priorMessages: [],
        settings: {
          cwd: workspace,
          cliPath: resolve(
            process.env.TRYLO_DESKTOP_CLI_ENTRY ?? '../new trylo cli/dist/cmd/trylo/main.js',
          ) as FilePath,
          cliNodeProgram: process.execPath,
          providerId: 'fixture-write',
        },
        onEvents() {},
      })
      await vi.waitFor(() => expect(permissions.list()).toHaveLength(1), { timeout: 20000 })
      expect(existsSync(join(workspace, 'fixture-output.txt'))).toBe(false)
      const message = codeApprovalMessages(permissions.list(), 'p', 'approve')[0]!
      if (message.kind !== 'approval') throw new Error('missing projected approval')
      render(
        <ApprovalCard
          message={message}
          onRespond={(id, allow) => permissions.respond(id, allow)}
        />,
      )
      await act(async () => fireEvent.click(screen.getByRole('button', { name: '批准并继续' })))
      if (failFirstDelivery) {
        expect(screen.getByRole('alert').textContent).toContain('审批未送达')
        expect(permissions.list()).toHaveLength(1)
        expect(controller.getViewState().running).toBe(true)
        expect(existsSync(join(workspace, 'fixture-output.txt'))).toBe(false)
        await act(async () => fireEvent.click(screen.getByRole('button', { name: '批准并继续' })))
      }
      expect(permissions.list()).toEqual([])
      expect(screen.queryByRole('button', { name: '批准并继续' })).toBeNull()
      await vi.waitFor(() => expect(controller.getViewState().running).toBe(false), {
        timeout: 12000,
      })
      await Promise.all(service.exits.values())
      const terminals = service.wire.flatMap((line) => {
        const frame = JSON.parse(line) as { type: string; status: string }
        return frame.type === 'run_result' ? [frame] : []
      })
      expect(terminals).toMatchObject([{ status: 'completed' }])
      expect(readFileSync(join(workspace, 'fixture-output.txt'), 'utf8')).not.toBe('')
      expect(service.children.size).toBe(0)
      expect(readdirSync(join(home, 'sessions')).filter((name) => name.endsWith('.lock'))).toEqual(
        [],
      )
      writeFileSync(
        join(root, 'receipt.json'),
        JSON.stringify(
          {
            failFirstDelivery,
            terminalStatus: terminals[0]?.status,
            pendingApprovals: permissions.list().length,
            running: controller.getViewState().running,
            fileWritten: true,
            childrenRemaining: service.children.size,
            sessionLockReleased: true,
          },
          null,
          2,
        ),
      )
    } finally {
      cleanup()
      await controller.stop()
      await service.dispose()
    }
  },
  45000,
)

it('stops a real pending request, expires its old card and continues with a fresh approval', async () => {
  const scratch = resolve('../_workspace/cache/tests/stopped-approval')
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(join(scratch, 'live-'))
  const home = join(root, 'home'),
    workspace = join(root, 'workspace') as FilePath
  mkdirSync(home)
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'package.json'), '{}')
  execFileSync('git', ['init', '--quiet', workspace], { windowsHide: true })
  const service = new NodeProcessFixture({
    ...process.env,
    TRYLO_HOME: home,
    TRYLO_API_KEY: '',
    TRYLO_OPENAI_API_KEY: '',
    TEMP: root,
    TMP: root,
  })
  h.service = service
  const send = vi.spyOn(service, 'send')
  const supervisor = new ConversationRunSupervisor()
  const request = {
    prompt: 'write the fixture',
    permissionLevel: 'ask' as const,
    codeMode: 'agent' as const,
    priorMessages: [],
    settings: {
      cwd: workspace,
      cliPath: resolve(
        process.env.TRYLO_DESKTOP_CLI_ENTRY ?? '../new trylo cli/dist/cmd/trylo/main.js',
      ) as FilePath,
      cliNodeProgram: process.execPath,
      providerId: 'fixture-write',
    },
    onEvents() {},
  }
  try {
    await supervisor.runCode('p', 'continue', request)
    await vi.waitFor(() => expect(supervisor.pendingCodePermissions()).toHaveLength(1), {
      timeout: 20000,
    })
    const oldRequest = supervisor.pendingCodePermissions()[0]!
    const oldCard = codeApprovalMessages([oldRequest], 'p', 'continue')[0]!
    await supervisor.stopConversation('p', 'continue')
    expect(supervisor.pendingCodePermissions()).toEqual([])
    expect(existsSync(join(workspace, 'fixture-output.txt'))).toBe(false)
    expect(await supervisor.respondCodePermission(oldRequest.requestId, true)).toBe(false)
    expect(supervisor.getViewState('p', 'continue').running).toBe(false)

    await supervisor.runCode('p', 'continue', request)
    await vi.waitFor(() => expect(supervisor.pendingCodePermissions()).toHaveLength(1), {
      timeout: 20000,
    })
    const newRequest = supervisor.pendingCodePermissions()[0]!
    expect(newRequest.processId).not.toBe(oldRequest.processId)
    expect(newRequest.requestId).not.toBe(oldRequest.requestId)
    const View = () => {
      const live = useCodeApprovals(supervisor, 'p', 'continue')
      return (
        <>
          {mergeCodeApprovals([oldCard], live).map((message) =>
            message.kind === 'approval' ? (
              <ApprovalCard
                key={message.id}
                message={message}
                onRespond={(id, allow) => supervisor.respondCodePermission(id, allow)}
              />
            ) : null,
          )}
        </>
      )
    }
    render(<View />)
    expect(screen.getByText('已失效')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '批准并继续' })).toHaveLength(1)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '批准并继续' })))
    await vi.waitFor(() => expect(supervisor.getViewState('p', 'continue').running).toBe(false), {
      timeout: 20000,
    })
    await Promise.all(service.exits.values())
    expect(existsSync(join(workspace, 'fixture-output.txt'))).toBe(true)
    const answers = send.mock.calls
      .map(([, line]) => JSON.parse(line) as { type: string; response?: { request_id: string } })
      .filter((frame) => frame.type === 'control_response')
    expect(answers.map((frame) => frame.response?.request_id)).toEqual([newRequest.requestId])
    expect(supervisor.pendingCodePermissions()).toEqual([])
    writeFileSync(
      join(root, 'receipt.json'),
      JSON.stringify(
        {
          oldApprovalExpired: true,
          oldAnswerSent: false,
          newApprovalAccepted: true,
          newProcess: true,
          pendingApprovals: 0,
          fileWritten: true,
          childrenRemaining: service.children.size,
        },
        null,
        2,
      ),
    )
  } finally {
    writeFileSync(
      join(root, 'process-events.json'),
      JSON.stringify(
        {
          wire: service.wire,
          stderr: service.stderr,
          view: supervisor.getViewState('p', 'continue'),
          pending: supervisor.pendingCodePermissions().map((item) => item.requestId),
        },
        null,
        2,
      ),
    )
    cleanup()
    await supervisor.stopAll()
    await service.dispose()
  }
}, 60000)
