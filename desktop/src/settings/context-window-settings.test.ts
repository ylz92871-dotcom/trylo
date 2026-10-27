import { beforeEach, describe, expect, it } from 'vitest'
import { loadSettings, saveSettings, settingsDefaults, sameConnection } from './settings-store'
import { settingsForCodeRun } from '../runtime/conversation-run-supervisor'
import {
  contextPreference,
  withContextPreference,
  resolveContextPreference,
  contextWindowOptions,
  parseModelContextPreferences,
} from './context-window'
import { buildTryloV1Args } from '../host-adapter/trylo-v1-runner'

beforeEach(() => window.localStorage.clear())

describe('model-scoped context preferences', () => {
  it('migrates and round-trips model windows independently of credentials', () => {
    const modelContextPreferences = { 'model-key': { window: 400_000, capacity: 1_000_000 } }
    window.localStorage.setItem(
      'trylo:settings:v1',
      JSON.stringify({ apiKey: 'kept-test-credential', modelContextPreferences }),
    )
    const loaded = loadSettings()
    expect(loaded.modelContextPreferences).toEqual(modelContextPreferences)
    expect(loaded.apiKey).toBe('kept-test-credential')
    saveSettings(loaded)
    expect(loadSettings().modelContextPreferences).toEqual(modelContextPreferences)
  })
  it('does not change authentication identity when only the working window changes', () => {
    const current = settingsDefaults
    const changed = { ...current, modelContextPreferences: { key: { window: 128_000 } } }
    expect(sameConnection(current, changed)).toBe(true)
  })
  it('defaults the actual new-CLI run snapshot to 200K', () => {
    const run = settingsForCodeRun(
      { ...settingsDefaults, cliRuntimeProtocol: 'trylo-v1' },
      'D:/fixture' as never,
    )
    expect(run.contextTokenLimit).toBe(200_000)
  })
  it.each([400_000, 600_000, 800_000, 1_000_000])(
    'keeps a %i-token preference through save, reload, switching connections and CLI arguments',
    (window) => {
      const first = { ...settingsDefaults, apiHost: 'https://one.invalid/v1', apiModel: 'model-a' }
      const configured = {
        ...first,
        modelContextPreferences: withContextPreference(first, {
          window,
          capacity: 1_000_000,
        }),
      }
      saveSettings(configured)
      const loaded = loadSettings()
      expect(contextPreference(loaded)).toEqual({ window, capacity: 1_000_000 })
      expect(contextPreference({ ...loaded, apiModel: 'model-b' })).toEqual({})
      expect(contextPreference({ ...loaded, apiHost: 'https://two.invalid/v1' })).toEqual({})
      const run = settingsForCodeRun(
        { ...loaded, cliRuntimeProtocol: 'trylo-v1' },
        'D:/fixture' as never,
      )
      expect(run.contextTokenLimit).toBe(window)
      expect(run.modelContextWindow).toBe(1_000_000)
      const { args } = buildTryloV1Args(run)
      expect(
        args.slice(args.indexOf('--context-window'), args.indexOf('--context-window') + 2),
      ).toEqual(['--context-window', String(window)])
      expect(
        args.slice(
          args.indexOf('--model-context-window'),
          args.indexOf('--model-context-window') + 2,
        ),
      ).toEqual(['--model-context-window', '1000000'])
      expect(
        settingsForCodeRun(
          { ...loaded, cliRuntimeProtocol: 'legacy-stream-json' },
          'D:/fixture' as never,
        ).contextTokenLimit,
      ).toBeUndefined()
    },
  )
  it('never lets a user declaration raise the service capacity', () => {
    expect(resolveContextPreference({ window: 400_000, capacity: 1_000_000 }, 128_000)).toEqual({
      requested: 400_000,
      capacity: 128_000,
      effective: 128_000,
    })
    expect(contextWindowOptions({}, 128_000)).toEqual([64_000, 128_000])
    expect(contextWindowOptions({})).toEqual([
      64_000, 128_000, 200_000, 256_000, 400_000, 600_000, 800_000, 1_000_000,
    ])
    expect(contextWindowOptions({}, 600_000)).toEqual([
      64_000, 128_000, 200_000, 256_000, 400_000, 600_000,
    ])
  })
  it('discards invalid persisted sizes independently without dropping valid sibling fields', () => {
    expect(
      parseModelContextPreferences({
        a: { window: -1, capacity: 128_000 },
        b: { window: 400_000, capacity: 1.5 },
        c: { window: 9007199254740992 },
        d: null,
      }),
    ).toEqual({ a: { capacity: 128_000 }, b: { window: 400_000 } })
  })
})
