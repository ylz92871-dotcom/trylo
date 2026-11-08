import { beforeEach, expect, it, vi } from 'vitest'
import { resetCliRuntimeGuardForTests, verifyCliRuntime } from './cli-runtime-guard'
import type { CliRuntimeProbeResult } from '../host-adapter/cli-runtime-probe-types'
import { probeResultOfBanners } from '../host-adapter/cli-runtime-probe'
beforeEach(resetCliRuntimeGuardForTests)
const entryScript = 'D:/new/cli/main.js'
const good: CliRuntimeProbeResult = { ok: true, kind: 'trylo-v1', version: '1', evidence: 'help' }
it('rejects an absent entry without probing', async () => {
  const probe = vi.fn()
  expect((await verifyCliRuntime({ entryScript: '', probe })).ok).toBe(false)
  expect(probe).not.toHaveBeenCalled()
})
it('memoizes the exact interpreter and entry', async () => {
  const probe = vi.fn(async () => good)
  for (let i = 0; i < 2; i++)
    expect(await verifyCliRuntime({ entryScript, nodeProgram: 'a', probe })).toEqual({ ok: true })
  expect(probe).toHaveBeenCalledOnce()
  await verifyCliRuntime({ entryScript, nodeProgram: 'b', probe })
  expect(probe).toHaveBeenCalledTimes(2)
})
it.each(['incompatible', 'not_found'] as const)('blocks proven %s', async (code) => {
  expect(
    (
      await verifyCliRuntime({
        entryScript,
        probe: async () => ({ ok: false, code, detail: code }),
      })
    ).ok,
  ).toBe(false)
})
it.each(['timeout', 'spawn_failed', 'unrecognized'] as const)(
  'preserves uncertainty for %s',
  async (code) => {
    expect(
      await verifyCliRuntime({
        entryScript,
        probe: async () => ({ ok: false, code, detail: code }),
      }),
    ).toEqual({ ok: true })
  },
)
it('blocks a known build lacking requested flags', async () => {
  const probe = async () => ({ ...good, supportedFlags: ['--model'] })
  expect(
    (await verifyCliRuntime({ entryScript, requiredFlags: ['--context-window'], probe })).ok,
  ).toBe(false)
  expect(await verifyCliRuntime({ entryScript, requiredFlags: ['--model'], probe })).toEqual({
    ok: true,
  })
})
it('recognizes the retired binary as incompatible', () => {
  expect(
    probeResultOfBanners({ versionBanner: '2.1.88-trylo (Claude Code)', exitCode: 0 }),
  ).toMatchObject({ ok: false, code: 'incompatible' })
  expect(
    probeResultOfBanners({
      versionBanner: '',
      helpBanner: 'trylo - learning agent CLI',
      exitCode: 0,
    }),
  ).toMatchObject({ ok: true, kind: 'trylo-v1' })
  expect(probeResultOfBanners({ versionBanner: '1.2.3', exitCode: 0 })).toMatchObject({
    ok: false,
    code: 'unrecognized',
  })
})
