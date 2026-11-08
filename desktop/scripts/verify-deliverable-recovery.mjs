// Render production deliverable components with synthetic producer-shaped data.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { workspacePath } from '../../scripts/workspace-paths.mjs'

const desktop = fileURLToPath(new URL('../', import.meta.url))
const output = workspacePath('tasks', 'deliverable-ui-recovery-20261108', `render-${Date.now()}`)
await fs.mkdir(output, { recursive: true })
const { build } = createRequire(new URL('../../desktop-services/package.json', import.meta.url))('esbuild')
const { chromium } = createRequire(new URL('../../desktop-services/toolchain/browser/playwright-mcp/package.json', import.meta.url))('playwright')
await build({ entryPoints: [path.join(desktop, 'testdata/deliverable-recovery-acceptance/fixture.tsx')],
  outdir: output, entryNames: 'fixture', bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic' })

const proof = { passed: false, isolatedProductionComponents: true, productionApp: false,
  nativeDesktop: false, installedPackage: false, realProvider: false,
  userDataRead: false, userDesktopControlled: false, checks: [], diagnostics: [], sourceHashes: {} }
for (const name of [
  'src/results/conversation-result-normalizer.ts', 'src/results/work-result-recovery.ts',
  'src/results/output-files/eligibility.ts', 'src/results/artifact-store.ts',
  'src/results/conversation-result-repository.ts', 'src/components/chat/ResultDock.tsx',
  'src/components/chat/ArtifactPreviewStrip.tsx', 'src/components/chat/WorkResultContent.tsx',
  'src/components/chat/result-preview-files.ts', 'src/styles/components/result-dock.css',
  'src/styles/components/artifact-card.css', 'testdata/deliverable-recovery-acceptance/fixture.tsx',
]) proof.sourceHashes[name] = createHash('sha256').update(await fs.readFile(path.join(desktop, name))).digest('hex')

const server = http.createServer(async (request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.slice(1)
  try {
    if (!name) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>')
      return
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) { response.writeHead(404).end(); return }
    response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript')
    response.end(await fs.readFile(path.join(output, name)))
  } catch { response.writeHead(404).end() }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
let context
try {
  context = await chromium.launchPersistentContext(path.join(output, '.cache', 'edge-profile'), {
    headless: true, channel: 'msedge', viewport: { width: 900, height: 760 },
    deviceScaleFactor: 1, reducedMotion: 'reduce',
  })
  const page = context.pages()[0] ?? await context.newPage()
  page.on('pageerror', error => proof.diagnostics.push(error.message))
  const origin = `http://127.0.0.1:${server.address().port}`
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue()
    proof.diagnostics.push(`Unexpected external request: ${route.request().url()}`)
    return route.abort()
  })
  const load = async (kind) => {
    await page.goto(`${origin}/?case=${kind}`)
    await page.waitForFunction(() => window.deliverableProof && document.querySelector('[data-case]'))
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    return page.evaluate(() => window.deliverableProof)
  }
  const capture = async name => page.screenshot({ path: path.join(output, `${name}.png`) })
  const recovered = await load('polluted')
  assert.equal(recovered.inputRuntimeCount, 500)
  assert.equal(recovered.artifactCount, 1)
  assert.equal(recovered.artifactCountTotal, 1)
  assert.equal(recovered.latestCount, 1)
  assert.equal(recovered.latestVisibleCount, 1)
  assert.equal(recovered.createdCount, 0)
  assert.equal(recovered.updatedCount, 0)
  assert.equal(recovered.discoveredCount, 1)
  assert.deepEqual(recovered.previewPaths, ['.trylo/out/report.pdf'])
  assert.equal(await page.locator('.work-result__item').count(), 1)
  assert.equal(await page.getByText('本轮交付', { exact: true }).count(), 1)
  assert.equal(await page.getByText('发现 1', { exact: true }).count(), 1)
  assert.equal(await page.locator('.work-result__badge[data-kind="discovered"]').count(), 1)
  assert.equal(await page.locator('.work-result__badge[data-kind="new"]').count(), 0)
  assert.equal(await page.getByText('此对话的历史产物', { exact: true }).count(), 0)
  assert.doesNotMatch(await page.locator('main').innerText(), /viewport-profile|\bLOCK\b|\bLOG\b|\bDIPS\b|CURRENT|MANIFEST|db-journal/)
  await capture('recovered-one-report')
  await page.getByRole('button', { name: /report\.pdf/ }).click()
  await page.locator('.artifact-card__open').click()
  const opened = await page.evaluate(() => window.deliverableProof)
  assert.deepEqual(opened.openPaths, ['.trylo/out/report.pdf', 'D:/Synthetic/TryloDeliverables/.trylo/out/report.pdf'])
  assert.deepEqual(opened.hostCalls, [])
  const head = page.getByRole('button', { name: '交付物', exact: true })
  await head.focus(); await head.press('Escape')
  assert.equal(await head.getAttribute('aria-expanded'), 'false')
  assert.equal(await page.locator('.artifact-preview-strip__file').isVisible(), true)
  await head.press('Enter')
  assert.equal(await head.getAttribute('aria-expanded'), 'true')
  proof.checks.push({ case: '500-runtime-plus-report', ...recovered, actualPreviewCallbacks: opened.openPaths, keyboardAndCollapsedPreview: true })

  await page.setViewportSize({ width: 480, height: 700 })
  await capture('recovered-narrow')
  const narrow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth,
    width: innerWidth, cardRight: document.querySelector('.artifact-card').getBoundingClientRect().right }))
  assert.ok(narrow.scrollWidth <= narrow.width)
  assert.ok(narrow.cardRight <= narrow.width)
  proof.checks.push({ narrow })

  await page.setViewportSize({ width: 900, height: 760 })
  const many = await load('many')
  assert.equal(many.artifactCountTotal, 500)
  assert.equal(many.artifactCount, 200)
  assert.equal(many.latestCount, 200)
  assert.equal(many.latestVisibleCount, 200)
  assert.equal(many.createdCount, 200)
  assert.equal(many.discoveredCount, 0)
  assert.equal(many.truncated, true)
  assert.equal(await page.locator('.work-result__item').count(), 200)
  assert.equal(await page.getByText('本轮交付', { exact: true }).count(), 1)
  assert.equal(await page.getByText('此对话的历史产物', { exact: true }).count(), 0)
  await capture('many-valid-files')
  proof.checks.push({ case: '500-valid-files-through-store-and-repository', ...many })

  for (const kind of ['empty', 'new-turn']) {
    const result = await load(kind)
    assert.equal(result.artifactCount, 1)
    assert.equal(result.latestCount, 0)
    assert.equal(await page.locator('.result-dock').count(), 0)
    assert.equal(await page.getByText('此对话的历史产物', { exact: true }).count(), 0)
    await capture(kind)
    proof.checks.push({ case: kind, ...result, staleHistoryMounted: false })
  }
  assert.deepEqual(proof.diagnostics, [])
  proof.passed = true
} catch (error) {
  proof.error = String(error.stack ?? error)
  throw error
} finally {
  await fs.writeFile(path.join(output, 'proof.json'), JSON.stringify(proof, null, 2))
  await context?.close()
  const closed = new Promise(resolve => server.close(resolve))
  server.closeAllConnections()
  await closed
}
console.log(JSON.stringify({ passed: proof.passed, output }))
