import { beforeEach, expect, it, vi } from 'vitest'
import { settingsDefaults } from '../settings/settings-store'
import type { ToolLearningRuntime } from '../tool-learning/cli-status'
import { controlCentralRuntime, requestCentralRuntimeControl } from './central-runtime'
import { configureCentralRuntimeForSettings } from './central-runtime-configuration'

vi.mock('./central-runtime', () => ({
  controlCentralRuntime: vi.fn(),
  requestCentralRuntimeControl: vi.fn(),
}))
const runtime = { cwd: 'D:/workspace', cliPath: 'cli.js', process: {} } as ToolLearningRuntime
beforeEach(() => {
  vi.resetAllMocks()
})

it('does not invent a saved background configuration for a first activation or unrelated settings save', async () => {
  vi.mocked(controlCentralRuntime).mockResolvedValue({ enabled: false })
  await configureCentralRuntimeForSettings(
    runtime,
    { ...settingsDefaults, providerId: '', apiFormat: 'anthropic' },
    { connection: true, userLearning: false },
  )
  expect(requestCentralRuntimeControl).not.toHaveBeenCalled()
})

it('an explicit User settings save only changes its original background switch', async () => {
  vi.mocked(controlCentralRuntime).mockResolvedValue({
    enabled: true,
    configuration: {
      providerId: 'original-provider',
      model: 'original-model',
      endpointHash: 'original-hash',
      userLearning: true,
    },
  })
  vi.mocked(requestCentralRuntimeControl).mockResolvedValue({ enabled: true })
  await configureCentralRuntimeForSettings(
    runtime,
    { ...settingsDefaults, userLearning: { ...settingsDefaults.userLearning, enabled: false } },
    { connection: false, userLearning: true },
  )
  expect(requestCentralRuntimeControl).toHaveBeenCalledWith(
    runtime,
    { workspaceRoot: runtime.cwd, action: 'configure', patch: { userLearning: false } },
    undefined,
    undefined,
  )
})

it('an explicit connection save uses the original mapping and keeps keys only in invocation environment', async () => {
  vi.mocked(controlCentralRuntime).mockResolvedValue({
    enabled: false,
    configuration: {
      providerId: 'old-provider',
      model: 'old-model',
      endpointHash: 'original-hash',
      userLearning: false,
    },
  })
  vi.mocked(requestCentralRuntimeControl).mockResolvedValue({ enabled: false })
  await configureCentralRuntimeForSettings(
    runtime,
    {
      ...settingsDefaults,
      poolModel: '',
      apiFormat: 'openai',
      providerId: '',
      apiKey: 'fixture-secret',
      apiHost: 'https://service.example/v1',
      apiModel: 'explicit-model',
      reasoningEffort: 'low',
    },
    { connection: true, userLearning: false },
  )
  const args = vi.mocked(requestCentralRuntimeControl).mock.calls[0]!
  expect(args[1]).toEqual({
    workspaceRoot: runtime.cwd,
    action: 'configure',
    patch: {
      connection: {
        providerId: 'openai-compatible',
        endpoint: 'https://service.example/v1/chat/completions',
        model: 'explicit-model',
        reasoningEffort: 'low',
      },
    },
  })
  expect(JSON.stringify(args[1])).not.toContain('fixture-secret')
  expect(args[3]).toEqual({ TRYLO_OPENAI_API_KEY: 'fixture-secret' })
})

it('only an explicitly edited thought envelope updates the saved configuration and can return to legacy', async () => {
  const legacy = {
    providerId: 'original-provider',
    model: 'original-model',
    endpointHash: 'original-hash',
    userLearning: true,
  }
  vi.mocked(controlCentralRuntime).mockResolvedValue({ enabled: false, configuration: legacy })
  vi.mocked(requestCentralRuntimeControl).mockResolvedValue({ enabled: false })
  await configureCentralRuntimeForSettings(runtime, settingsDefaults, {
    connection: false,
    userLearning: false,
  })
  expect(requestCentralRuntimeControl).not.toHaveBeenCalled()
  await configureCentralRuntimeForSettings(runtime, settingsDefaults, {
    connection: false,
    userLearning: false,
    thought: true,
  })
  expect(requestCentralRuntimeControl).toHaveBeenLastCalledWith(
    runtime,
    { workspaceRoot: runtime.cwd, action: 'configure', patch: { thoughtMaxTokens: 64000 } },
    undefined,
    undefined,
  )
  vi.mocked(controlCentralRuntime).mockResolvedValue({
    enabled: false,
    configuration: { ...legacy, thoughtMaxTokens: 64000 },
  })
  const oldSettings = { ...settingsDefaults.agentLearning! }
  delete oldSettings.centralThoughtMaxTokens
  await configureCentralRuntimeForSettings(
    runtime,
    { ...settingsDefaults, agentLearning: oldSettings },
    { connection: false, userLearning: false, thought: true },
  )
  expect(requestCentralRuntimeControl).toHaveBeenLastCalledWith(
    runtime,
    { workspaceRoot: runtime.cwd, action: 'configure', patch: { thoughtMaxTokens: null } },
    undefined,
    undefined,
  )
  const before = vi.mocked(requestCentralRuntimeControl).mock.calls.length
  await expect(
    configureCentralRuntimeForSettings(
      runtime,
      { ...settingsDefaults, agentLearning: { ...oldSettings, centralThoughtMaxTokens: 0 } },
      { connection: false, userLearning: false, thought: true },
    ),
  ).rejects.toThrow('整数')
  expect(vi.mocked(requestCentralRuntimeControl).mock.calls.length).toBe(before)
})
