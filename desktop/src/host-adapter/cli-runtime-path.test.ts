// Trylo Desktop — CLI path resolution tests (P08 §WP6).

import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const { describeCliResolution, cliSpawnCommand } = await import('./cli-runtime-path')
type CliRuntimeResolution = import('./cli-runtime-path').CliRuntimeResolution

describe('cliSpawnCommand Windows resource paths', () => {
  it('converts a verbatim drive script path to a Node-compatible argument', () => {
    expect(
      cliSpawnCommand('\\\\?\\C:\\Trylo resources\\cli\\main.js', 'C:\\Trylo\\node.exe'),
    ).toEqual({
      command: 'C:\\Trylo\\node.exe',
      prefix: ['C:\\Trylo resources\\cli\\main.js'],
    })
  })
  it('preserves UNC host and share when converting a verbatim script path', () => {
    expect(cliSpawnCommand('\\\\?\\UNC\\server\\share\\main.js').prefix).toEqual([
      '\\\\server\\share\\main.js',
    ])
  })
  it('leaves executable commands and ordinary script paths intact', () => {
    expect(cliSpawnCommand('\\\\?\\C:\\Trylo\\trylo.exe')).toEqual({
      command: '\\\\?\\C:\\Trylo\\trylo.exe',
      prefix: [],
    })
    expect(cliSpawnCommand('/opt/trylo/main.mjs').prefix).toEqual(['/opt/trylo/main.mjs'])
  })
})

const RESOLVED: CliRuntimeResolution = {
  cliScript: 'C:/Program Files/Trylo/resources/cli/dist/cmd/trylo/main.js',
  cliSource: 'bundled',
  nodeProgram: 'C:/Program Files/Trylo/resources/runtime/node/win-x64/node.exe',
  nodeSource: 'bundled',
}

describe('describeCliResolution', () => {
  it('names the source without leaking the absolute path', () => {
    const text = describeCliResolution(RESOLVED)
    expect(text).toContain('打包资源')
    expect(text).not.toContain('Program Files')
  })

  it('says what to do when the CLI is missing', () => {
    const text = describeCliResolution({ ...RESOLVED, cliScript: null, cliSource: null })
    expect(text).toContain('未找到')
  })

  it('distinguishes the dev checkout from a packaged build', () => {
    expect(describeCliResolution({ ...RESOLVED, cliSource: 'dev-checkout' })).toContain(
      '开发 checkout',
    )
  })
})
