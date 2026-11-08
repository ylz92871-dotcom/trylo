import { createHash, webcrypto } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { expertRequestAuthorizationAction } from '../../../new trylo cli/src/internal/subagent/experts/authorization'
import type {
  ExpertConfiguration,
  ExpertRequest,
} from '../../../new trylo cli/src/internal/subagent/experts/contracts'
import type { ControlFrame } from '../host-adapter/control-protocol'
import type { CliCommandControlPort } from '../host-adapter/cli-command'
import { createExpertLibraryClient } from '../experts/client'
import { expertUserActionControl } from './expert-user-action-control'
import { productionChain } from './expert-user-action-control.fixture.mjs'

const transport = vi.hoisted(() => ({
  send: async (_id: string, _line: string): Promise<void> => {},
}))
vi.mock('../host-adapter/index', () => ({ hostAdapter: { process: transport } }))
afterEach(() => {
  vi.unstubAllGlobals()
})
const root = 'D:/workspace'
const configuration: ExpertConfiguration = {
  displayName: 'API 专家',
  specialty: 'API review',
  baseRole: 'worker',
  situations: ['API changes'],
  responsibilities: ['Inspect consumers'],
  constraints: ['Preserve signatures'],
  collaboration: ['Report to reviewer'],
  role: { name: 'worker', description: 'API specialist' },
  toolRefs: [],
  sources: [
    {
      kind: 'user',
      title: 'API policy',
      uri: 'user:api-policy',
      excerpt: 'Inspect public APIs and their consumers.',
    },
  ],
  methods: [
    {
      title: 'Consumer check',
      instructions: 'Inspect exports and affected consumers.',
      sourceUris: ['user:api-policy'],
    },
  ],
}
const pending: ExpertRequest = {
  requestId: 'request-1',
  expertId: 'expert-1',
  experienceKey: 'expert:expert-1',
  origin: 'settings',
  instruction: 'Create API expert',
  baseVersion: 0,
  state: 'awaiting_retention',
  revision: 2,
  createdAt: 1,
  configuration,
  userEdits: {},
  creationAuthorization: 'permission:create',
}
function frame(
  request: ExpertRequest,
  stage: 'create' | 'edit' | 'retain',
): Extract<ControlFrame, { kind: 'permission' }> {
  const action = expertRequestAuthorizationAction(request, stage)
  return {
    kind: 'permission',
    requestId: 'approval-1',
    toolName: `expert_library.${stage}`,
    input: { ...action },
  }
}
const digest = async (bytes: Uint8Array): Promise<string> =>
  createHash('sha256').update(bytes).digest('hex')
const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

it('uses the actually displayed snapshot even if a background refresh has observed a newer request', async () => {
  const invokeUserAction = vi.fn(async () => pending)
  const client = createExpertLibraryClient({
    invoke: async () => [{ ...pending, revision: 3 }],
    invokeUserAction,
  })
  const signal = new AbortController().signal
  await client.requests(signal)
  await client.retain(pending.requestId, { kind: 'save' }, signal, pending)
  expect(invokeUserAction).toHaveBeenCalledWith(
    { operation: 'retain', requestId: pending.requestId, result: { kind: 'save' } },
    signal,
    { kind: 'request', request: pending },
  )
})

it('matches the displayed candidate once and keeps changed revisions, forged hashes and other processes on normal approval', async () => {
  for (const change of ['none', 'revision', 'hash', 'process'] as const) {
    const receive = vi.fn(),
      respond = vi.fn(async () => true)
    const control: CliCommandControlPort = {
      receive,
      clearProcess() {},
      respondToUserAction: respond,
    }
    const candidate = {
      ...pending,
      configuration: { ...configuration, specialty: 'User-edited API specialty' },
    }
    const action = expertUserActionControl({
      command: {
        operation: 'edit',
        requestId: pending.requestId,
        edits: { specialty: candidate.configuration.specialty },
      },
      evidence: { kind: 'request', request: pending },
      workspaceRoot: root,
      control,
      signal: new AbortController().signal,
      digest,
    })
    action.control.acquired?.(
      { id: 'owned', pid: 1, command: 'trylo', label: 'test' },
      async () => {},
    )
    const review = frame(
      change === 'revision' ? { ...candidate, revision: candidate.revision + 1 } : candidate,
      'edit',
    )
    if (change === 'hash') review.input.fingerprint = '0'.repeat(64)
    action.control.receive(review, change === 'process' ? 'unowned' : 'owned')
    await tick()
    expect(respond).toHaveBeenCalledTimes(change === 'none' ? 1 : 0)
    expect(receive).toHaveBeenCalledTimes(change === 'none' ? 0 : 1)
    if (change === 'none') {
      action.control.receive(review, 'owned')
      expect(respond).toHaveBeenCalledTimes(1)
      expect(receive).toHaveBeenCalledTimes(1)
    }
  }
})

it('binds newly created requests to local command identity and workspace, with no command privilege flag', async () => {
  const receive = vi.fn(),
    respond = vi.fn(async () => true)
  const original = {
    operation: 'submit' as const,
    origin: 'settings' as const,
    instruction: 'Create API expert',
  }
  const action = expertUserActionControl({
    command: original,
    workspaceRoot: root,
    signal: new AbortController().signal,
    control: { receive, clearProcess() {}, respondToUserAction: respond },
    createId: () => 'local-request',
    digest,
  })
  expect(action.command).toEqual({ ...original, requestId: 'local-request' })
  action.control.acquired?.(
    { id: 'owned', pid: 1, command: 'trylo', label: 'test' },
    async () => {},
  )
  action.control.receive(
    frame(
      {
        ...pending,
        requestId: 'foreign-request',
        state: 'awaiting_creation',
        revision: 0,
        configuration: undefined,
        creationAuthorization: undefined,
        useScope: { workspaceId: root, taskId: 'task-1' },
      },
      'create',
    ),
    'owned',
  )
  await tick()
  expect(respond).not.toHaveBeenCalled()
  expect(receive).toHaveBeenCalledTimes(1)
})

const buildRoot = process.env.TRYLO_EXPERT_CLI_BUILD
function requireBuildRoot(): string {
  if (
    buildRoot === undefined ||
    !existsSync(path.join(buildRoot, 'internal/surface/cli/commands-library.js'))
  )
    throw Object.assign(
      new Error(
        'Compiled CLI artifact is required: set TRYLO_EXPERT_CLI_BUILD to the strictly compiled candidate.',
      ),
      { code: 'compiled_cli_build_unavailable' },
    )
  return buildRoot
}
it('carries real Desktop create, edit and save through a fresh compiled CLI handler and existing stdio Permission service without a second user click', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const f = await productionChain(requireBuildRoot(), configuration, transport, root),
    signal = new AbortController().signal
  let request = await f.clients.experts.submit('Create API expert', undefined, signal)
  expect(request.state).toBe('authorized')
  request = await f.clients.experts.build(request.requestId, signal)
  request = await f.clients.experts.edit(
    request.requestId,
    { constraints: ['User-authored constraint'] },
    signal,
  )
  request = await f.clients.experts.retain(request.requestId, { kind: 'save' }, signal)
  expect(request.state).toBe('saved')
  expect(f.snapshot().experts[0]?.versions[0]?.configuration.constraints).toEqual([
    'User-authored constraint',
  ])
  expect(f.supervisor.pendingCodePermissions()).toHaveLength(0)
  const replies = f.lines
    .map((line) => JSON.parse(line))
    .filter((line) => line.type === 'control_response')
  expect(replies).toHaveLength(3)
  expect(replies.every((line) => line.response.response.behavior === 'allow')).toBe(true)
  expect(f.lines.some((line) => /userActionId|executeUserAction|trusted.*true/.test(line))).toBe(
    false,
  )
})

it('ordinary CLI/model payloads still require the original human decision even with identical expert fields', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const f = await productionChain(requireBuildRoot(), configuration, transport, root)
  const result = f.ordinary({
    operation: 'submit',
    origin: 'settings',
    instruction: 'Create API expert',
    requestId: 'model-invented-request',
  })
  await vi.waitFor(() => expect(f.supervisor.pendingCodePermissions()).toHaveLength(1))
  expect(f.snapshot().requests[0]?.state).toBe('awaiting_creation')
  const request = f.supervisor.pendingCodePermissions()[0]!
  expect(await f.supervisor.respondCodePermission(request.requestId, false)).toBe(true)
  const receipt = await result
  expect(receipt.ok).toBe(true)
  expect(JSON.parse(receipt.stdout ?? '{}').state).toBe('rejected')
})
