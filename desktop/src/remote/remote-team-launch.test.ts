import { beforeEach, expect, it, vi } from 'vitest'
import { launchRemoteTeam } from './remote-team-launch'
import { settingsDefaults } from '../settings/settings-store'
import { builtinTemplatesForSurface } from '../user-learning/team-access/profiles/templates'
import type { ConversationRunSupervisor } from '../runtime/conversation-run-supervisor'
const mocks = vi.hoisted(() => ({ start: vi.fn(), work: vi.fn() }))
vi.mock('../user-learning/team-access/profiles/host-launch', () => ({ startTeamTurn: mocks.start }))
vi.mock('../work-chat/work-chat-adapter', () => ({ sendWorkChat: mocks.work }))
vi.mock('../runtime/conversation-run-supervisor', () => ({
  settingsForCodeRun: (settings: unknown) => settings,
}))

beforeEach(() => {
  vi.clearAllMocks()
})
for (const surface of ['code', 'work'] as const) {
  it(`launches a ${surface} team through the existing native owner with a frozen profile`, async () => {
    const profile = builtinTemplatesForSurface(surface, 1)[0]!
    const preparation = {
      signal: new AbortController().signal,
      isCurrent: () => true,
      finish: vi.fn(),
    }
    const runCode = vi.fn(async () => {})
    const supervisor = {
      beginSend: vi.fn(() => preparation),
      inspectTeamOwner: vi.fn(),
      runCode,
    } as unknown as ConversationRunSupervisor
    mocks.start.mockResolvedValue({
      ok: true,
      goal: 'Goal',
      systemPrompt: 'Frozen team prompt',
      product: surface,
      teamMode: true,
      teamRunId: 'run-1',
      run: {},
    })
    const onPrepared = vi.fn()
    await launchRemoteTeam({
      supervisor,
      projectKey: 'origin',
      root: '/workspace',
      workspaceId: 'workspace',
      conversationId: 'conversation',
      surface,
      profileId: profile.id,
      goal: 'Goal',
      turnId: 'turn',
      settings: settingsDefaults,
      permissionLevel: 'ask',
      priorMessages: [],
      preparePrompt: vi.fn(),
      writeFile: vi.fn(),
      workProfile: { computerUse: false },
      lifecycleObserver: { onRunStarted: vi.fn(), onEvents: vi.fn(), onRunTerminal: vi.fn() },
      onPrepared,
      onEvents: vi.fn(),
      onFailed: vi.fn(),
    })
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ id: profile.id }),
        conversationId: 'conversation',
        product: surface,
        signal: preparation.signal,
      }),
    )
    expect(onPrepared).toHaveBeenCalledOnce()
    const dispatch = surface === 'code' ? runCode : mocks.work
    const options = dispatch.mock.calls[0]?.[surface === 'code' ? 2 : 1]
    expect(options).toMatchObject({
      teamMode: true,
      teamRunId: 'run-1',
      turnId: 'turn',
      permissionLevel: 'ask',
      sendPreparation: preparation,
    })
    expect(preparation.finish).toHaveBeenCalledOnce()
    expect(surface === 'code' ? mocks.work : runCode).not.toHaveBeenCalled()
  })
}
