// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('keeps the browser catalogue and profile composition aligned with the service manifests', () => {
  expect(() =>
    execFileSync(process.execPath, ['scripts/export-tool-catalog.mjs', '--check'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      windowsHide: true,
    }),
  ).not.toThrow()
})
