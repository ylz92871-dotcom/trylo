// Trylo Desktop — `settingsForCodeRun` combination contract (P08 audit P0).
//
// The audit's P0 was a real bug: the CLI path was resolved from the
// resource resolver UNCONDITIONALLY, so a default `legacy-stream-json`
// conversation got pointed at the new CLI and was then handed the legacy
// argv (`-p --input-format …`), which the new CLI rejects with
// `unknown command: -p`.
//
// The lesson is that the path decision is a *combination* of two
// independent facts — which protocol the run speaks, and what the
// resolver found — and neither one alone is enough. These tests exist so
// that mistake cannot come back: they cover the four quadrants the audit
// asked for, and they assert the legacy quadrant even when a new CLI IS
// present on the machine (the exact case that broke).

import { afterEach, describe, expect, it } from 'vitest'
import { settingsForCodeRun } from './conversation-run-supervisor'
import { resetCliRuntimeResolution, setCliRuntimeResolution } from './cli-runtime-resolution'
import type { FilePath } from '../host-adapter/types'

const CWD = 'D:/CC/trylo/workspace' as FilePath

it.each([
  { collectNewLearning: false, retention: 'normal' as const },
  { collectNewLearning: true, retention: 'session_only' as const },
])('central runtime policy pauses an existing owner for privacy directive %j', (directive) => {
  const settings = settingsForCodeRun({}, CWD, directive)
  expect(settings.centralRuntimePolicy).toBe('pause')
  expect(settings.centralLearningAllowance).toBeUndefined()
  expect(settings.learning).toBeUndefined()
})

it('freezes the selected agent domains and independent skill allocation for a normal task', () => {
  const selected = {
    agentLearning: { enabled: true, skillTokens: 64000, skillCalls: 6, skillOutputTokens: 8000 },
    userLearning: { enabled: false },
  }
  const run = settingsForCodeRun(selected, CWD)
  expect(run.learning).toBe('agent')
  expect(run.skillLearningAllowance).toEqual({ maxTokens: 64000, maxCalls: 6 })
  expect(run.checkLearning).toBeUndefined()
  const privateRun = settingsForCodeRun(selected, CWD, {
    collectNewLearning: false,
    retention: 'normal',
  })
  expect(privateRun.learning).toBeUndefined()
  expect(privateRun.skillLearningAllowance).toBeUndefined()
})

it('platform pool selection never forwards private API credentials or headers', () => {
  const run = settingsForCodeRun(
    {
      apiKey: 'private-own-key',
      apiHost: 'https://paid.invalid',
      apiModel: 'paid',
      poolModel: 'Qwen3.8-Flash-Next',
      apiFormat: 'anthropic',
      apiKeyHeader: 'x-private',
      apiKeyPrefix: 'Secret ',
      extraHeadersText: '{"private":"value"}',
      providerId: 'paid',
    },
    CWD,
  )
  expect(run.platformModel).toBe('Qwen3.8-Flash-Next')
  expect(run.providerId).toBe('openai-compatible')
  expect(run.apiFormat).toBe('openai')
  for (const field of [
    'apiKey',
    'apiHost',
    'apiKeyHeader',
    'apiKeyPrefix',
    'extraHeadersText',
  ] as const)
    expect(run[field]).toBeUndefined()
})

it('normal Code and Work runs freeze central authorization and respect private collection', () => {
  const selected = {
    agentLearning: {
      enabled: true,
      skillTokens: 64000,
      skillCalls: 6,
      skillOutputTokens: 8000,
      centralEnabled: true,
      centralTokens: 128000,
      centralCalls: 16,
    },
    userLearning: { enabled: false },
  }
  const run = settingsForCodeRun(selected, CWD)
  expect(run.centralLearningAllowance).toEqual({ maxTokens: 128000, maxCalls: 16 })
  expect(run.skillLearningAllowance).toBeUndefined()
  expect(run.learning).toBe('agent')
  expect(run.checkLearning).toBeUndefined()
  expect(
    settingsForCodeRun(selected, CWD, { collectNewLearning: false, retention: 'normal' })
      .centralLearningAllowance,
  ).toBeUndefined()
})

/** What the resolver returns on a machine that HAS the new CLI bundled. */
const BUNDLED = {
  cliScript: 'C:/Program Files/Trylo/resources/cli/dist/cmd/trylo/main.js',
  cliSource: 'bundled' as const,
  nodeProgram: 'C:/Program Files/Trylo/resources/runtime/node/win-x64/node.exe',
  nodeSource: 'bundled' as const,
}

afterEach(() => {
  resetCliRuntimeResolution()
})

describe('settingsForCodeRun — protocol × path resolution', () => {
  it('v1 + bundled: uses the packaged script and the pinned Node', () => {
    setCliRuntimeResolution(BUNDLED)
    const snapshot = settingsForCodeRun({}, CWD)
    expect(snapshot.cliPath).toBe(BUNDLED.cliScript)
    expect(snapshot.cliNodeProgram).toBe(BUNDLED.nodeProgram)
  })

  it('uses only the native entry', () => {
    setCliRuntimeResolution(BUNDLED)
    const snapshot = settingsForCodeRun({}, CWD)
    expect(snapshot.cliPath).toBe(BUNDLED.cliScript)
    expect(snapshot.cliNodeProgram).toBe(BUNDLED.nodeProgram)
  })

  // WP-CL / B: the learning switch is a snapshot fact like the protocol.
  // Leaving it out is what made "Enable User Learning" a UI-only promise:
  // the run never told the CLI, so nothing was ever saved.
  it('forwards an enabled user-learning switch and stays silent when it is off', () => {
    setCliRuntimeResolution(BUNDLED)
    expect(settingsForCodeRun({ userLearning: { enabled: true } }, CWD).learning).toBe('user')
    expect(settingsForCodeRun({ userLearning: { enabled: false } }, CWD).learning).toBeUndefined()
    expect(settingsForCodeRun({}, CWD).learning).toBeUndefined()
  })

  it('never upgrades the Desktop toggle to --learning=all', () => {
    // The Desktop owns one toggle. If it ever maps to `all`, method and tool
    // learning start running on the strength of a checkbox that never mentioned them.
    setCliRuntimeResolution(BUNDLED)
    for (const enabled of [true, false]) {
      expect(settingsForCodeRun({ userLearning: { enabled } }, CWD).learning).not.toBe('all')
    }
  })

  it('a private or session-only turn cannot enable the CLI user ledger', () => {
    setCliRuntimeResolution(BUNDLED)
    const settings = { userLearning: { enabled: true } }
    expect(
      settingsForCodeRun(settings, CWD, { collectNewLearning: false, retention: 'normal' })
        .learning,
    ).toBeUndefined()
    expect(
      settingsForCodeRun(settings, CWD, { collectNewLearning: true, retention: 'session_only' })
        .learning,
    ).toBeUndefined()
  })
})
