// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { loadSettings, saveSettings, settingsDefaults } from './settings-store'

beforeEach(() => localStorage.clear())

it('discards retired runtime selection and entry while preserving the connection and authority', () => {
  localStorage.setItem(
    'trylo:settings:v1',
    JSON.stringify({
      ...settingsDefaults,
      cliRuntimeProtocol: 'legacy-stream-json',
      cliRuntimeSelection: 'user',
      cliPath: 'D:/old/cli.js',
      apiHost: 'https://model.invalid',
      apiModel: 'selected-model',
      permissionLevel: 'unrestricted',
    }),
  )
  const settings = loadSettings()
  expect(settings).not.toHaveProperty('cliRuntimeProtocol')
  expect(settings).not.toHaveProperty('cliRuntimeSelection')
  expect(settings).not.toHaveProperty('cliPath')
  expect(settings.apiHost).toBe('https://model.invalid')
  expect(settings.apiModel).toBe('selected-model')
  expect(settings.permissionLevel).toBe('unrestricted')
})

it('does not persist retired fields supplied by an older in-memory caller', () => {
  const settings = {
    ...settingsDefaults,
    cliRuntimeProtocol: 'legacy-stream-json',
    cliRuntimeSelection: 'user',
    cliPath: 'D:/old/cli.js',
  }
  saveSettings(settings)
  const stored = JSON.parse(localStorage.getItem('trylo:settings:v1')!)
  for (const field of ['cliPath', 'cliRuntimeProtocol', 'cliRuntimeSelection'])
    expect(stored).not.toHaveProperty(field)
})
