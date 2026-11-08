import { describe, expect, it } from 'vitest'
import { settingsForCodeRun } from './conversation-run-supervisor'
import { buildTryloV1Args } from '../host-adapter/trylo-v1-runner'
import type { FilePath } from '../host-adapter/types'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildUserPrompt } from '../host-adapter/control-protocol'

const cwd = 'D:/isolated-collaboration' as FilePath
const cliPath = 'D:/isolated-cli/main.js' as FilePath
const base = {
  cliPath,
  userLearning: { enabled: true },
  collaborationLearning: { enabled: true, tokenBudget: 32000 },
}

describe('collaboration learning dispatch and privacy', () => {
  it('forwards its independent quota on team runs without broadening the user-learning switch', () => {
    const settings = settingsForCodeRun(base, cwd)
    const args = buildTryloV1Args({
      cliPath,
      cwd,
      teamMode: true,
      learning: settings.learning,
      collaborationLearning: settings.collaborationLearning,
    }).args
    expect(args).toContain('--learning=user')
    expect(args).toContain('--collaboration-learning=32000')
    expect(args).not.toContain('--learning=all')
  })

  it('can learn team cooperation with user learning disabled, without enabling another subsystem', () => {
    const settings = settingsForCodeRun({ ...base, userLearning: { enabled: false } }, cwd)
    expect(settings.learning).toBeUndefined()
    expect(
      buildTryloV1Args({
        cliPath,
        cwd,
        teamMode: true,
        collaborationLearning: settings.collaborationLearning,
      }).args,
    ).toContain('--collaboration-learning=32000')
  })

  it.each([
    { collectNewLearning: false, retention: 'normal' as const },
    { collectNewLearning: true, retention: 'session_only' as const },
  ])(
    'closes collection for this run without overwriting the stored preference: %j',
    (directive) => {
      const settings = settingsForCodeRun(base, cwd, directive)
      expect(settings.collaborationLearning).toEqual({ enabled: false, tokenBudget: 32000 })
      expect(settings.learning).toBeUndefined()
      expect(base.collaborationLearning.enabled).toBe(true)
      expect(
        buildTryloV1Args({
          cliPath,
          cwd,
          teamMode: true,
          collaborationLearning: settings.collaborationLearning,
        }).args,
      ).toContain('--collaboration-learning=off')
    },
  )

  it('preserves opt-out, omits non-team argv, and leaves legacy dispatch unchanged', () => {
    const settings = settingsForCodeRun(
      { ...base, collaborationLearning: { enabled: false, tokenBudget: 8000 } },
      cwd,
    )
    expect(settings.collaborationLearning).toEqual({ enabled: false, tokenBudget: 8000 })
    expect(
      buildTryloV1Args({
        cliPath,
        cwd,
        teamMode: false,
        collaborationLearning: settings.collaborationLearning,
      }).args.some((arg) => arg.startsWith('--collaboration-learning')),
    ).toBe(false)
    expect(settingsForCodeRun({ ...base }, cwd).collaborationLearning).toEqual(
      base.collaborationLearning,
    )
  })

  it('completes an ordinary task without learning through the checkout and bundled CLI entries', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'trylo-ordinary-no-learning-'))
    try {
      const environment = {
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.PATH,
        TRYLO_HOME: path.join(directory, 'profile'),
        HOME: directory,
        USERPROFILE: directory,
        APPDATA: directory,
        LOCALAPPDATA: directory,
        TEMP: directory,
        TMP: directory,
      }
      for (const entry of [
        '../../../new trylo cli/dist/cmd/trylo/main.js',
        '../../src-tauri/resources/cli/dist/cmd/trylo/main.js',
      ]) {
        const built = buildTryloV1Args({
          cliPath: fileURLToPath(new URL(entry, import.meta.url)) as FilePath,
          nodeProgram: process.execPath,
          cwd: directory as FilePath,
          providerId: 'fixture',
          model: 'fixture-model',
          teamMode: false,
          collaborationLearning: { enabled: false, tokenBudget: 16000 },
        })
        const stdout = await new Promise<string>((resolve, reject) => {
          const child = spawn(built.command, built.args, {
            cwd: directory,
            env: environment,
            windowsHide: true,
          })
          let output = '',
            errors = ''
          const timer = setTimeout(() => {
            child.kill()
            reject(new Error('ordinary task timed out'))
          }, 20000)
          child.stdout.setEncoding('utf8').on('data', (chunk) => {
            output += chunk
          })
          child.stderr.setEncoding('utf8').on('data', (chunk) => {
            errors += chunk
          })
          child.on('error', (error) => {
            clearTimeout(timer)
            reject(error)
          })
          child.on('close', (code) => {
            clearTimeout(timer)
            code === 0 ? resolve(output) : reject(new Error(`${code}: ${errors}\n${output}`))
          })
          // Desktop retains this control channel until the turn exits.
          child.stdin.write(buildUserPrompt('Return one ordinary task response.'))
        })
        const rows = stdout
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line))
        expect(rows.filter((row) => row.type === 'run_result').map((row) => row.status)).toEqual([
          'completed',
        ])
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30000)
})
