// Production shell/components and hooks, isolated synthetic host and records.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import http from 'node:http'
import { workspacePath } from '../../scripts/workspace-paths.mjs'
import { probePlaywrightChromium } from '../../desktop-services/src/tooling/tool-browser-condition.mjs'

const desktop = fileURLToPath(new URL('../', import.meta.url))
process.chdir(desktop)
const run = workspacePath('tasks', 'code-work-ui-unification-20261109', 'headless', `run-${Date.now()}`)
const root = path.join(run, 'project')
await fs.mkdir(path.join(root, '.trylo/out'), { recursive: true })
await fs.writeFile(path.join(root, '.trylo/out/review.md'), '# 连续构建预览\n\n这是磁盘上的真实 Markdown 文件。\n\n| 阶段 | 结果 |\n| --- | --- |\n| Code / Work | 共享预览 |\n')
const pdfText = 'BT /F1 12 Tf 72 760 Td (Historical preview) Tj ET'
const pdfObjects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${pdfText.length} >>\nstream\n${pdfText}\nendstream`]
let pdf = '%PDF-1.4\n', offsets = [0]
for (let index = 0; index < pdfObjects.length; index++) {
  offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${pdfObjects[index]}\nendobj\n`
}
const xref = Buffer.byteLength(pdf)
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
await fs.writeFile(path.join(root, '.trylo/out/archive.pdf'), pdf)
for (let index = 0; index < 36; index++) {
  const name = `章节-${String(index + 1).padStart(2, '0')}-项目说明和验收记录.md`
  const file = path.join(root, '.trylo/out/项目交付资料/用于检查侧栏宽度与滚动的完整目录/持续构建与预览', name)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `# ${name}\n\n真实磁盘内容。\n`)
}
const sources = [
  'src/components/app-shell/AppShell.tsx', 'src/components/app-shell/RightRail.tsx',
  'src/components/app-shell/FilePeek.tsx', 'src/components/chat/ChatPanel.tsx',
  'src/components/chat/InputBar.tsx', 'src/components/chat/AgentConversationSurface.tsx',
  'src/components/chat/MessageList.tsx', 'src/components/chat/Message.tsx',
  'src/components/chat/ProviderSetupNotice.tsx', 'src/components/chat/ResultDock.tsx',
  'src/components/chat/CodeReviewPanel.tsx', 'src/components/chat/WorkReviewPanel.tsx',
  'src/components/chat/code-review-summary.ts',
  'src/components/chat/CodeResultContent.tsx', 'src/components/chat/ApprovalMessageRow.tsx',
  'src/components/chat/result-preview-files.ts',
  'src/components/chat/WorkResultContent.tsx', 'src/components/chat/ArtifactCard.tsx',
  'src/components/code-surface/GitDiffView.tsx', 'src/result-dock/use-result-review.ts',
  'src/result-dock/result-review-state.ts',
  'src/result-dock/use-diff-preview.ts', 'src/host-adapter/preview/read-file.ts',
  'src/results/diff-request-tracker.ts', 'src/result-dock/result-dock-prefs.ts',
  'src/result-dock/use-result-dock-prefs.ts', 'src/monaco-init.ts',
  'src/styles/components/result-dock.css', 'src/styles/components/right-rail.css',
  'src/styles/components/code-review.css', 'src/styles/components/work-review.css',
  'src/styles/components/provider-setup-notice.css',
  'src/styles/components/artifact-card.css', 'testdata/code-work-ui-acceptance/fixture.tsx',
  'testdata/code-work-ui-acceptance/records.ts', 'scripts/verify-code-work-ui.mjs',
]
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async name => [name,
  createHash('sha256').update(await fs.readFile(path.join(desktop, name))).digest('hex'),
])))
const proof = { passed: false, productionShellComponents: true, completeApp: false, realMonaco: true,
  fakeHost: true, syntheticRecords: true, fakeComposerAcceptance: true, nativeDesktop: false,
  realProvider: false, userDataRead: false, userDesktopControlled: false,
  sourcesBefore: await hashes(), sourcesAfter: {}, sourcesStable: false, checks: [], diagnostics: [] }
const checkpoint = async stage => {
  proof.stage = stage
  await fs.writeFile(path.join(run, 'proof.json'), JSON.stringify(proof, null, 2))
  console.log(JSON.stringify({ stage, run }))
}
const { build } = createRequire(new URL('../../desktop-services/package.json', import.meta.url))('esbuild')
const { chromium } = createRequire(new URL('../../desktop-services/toolchain/browser/playwright-mcp/package.json', import.meta.url))('playwright')
const workers = new Map()
await build({ entryPoints: [path.join(desktop, 'testdata/code-work-ui-acceptance/fixture.tsx')],
  outdir: run, entryNames: 'fixture', bundle: true, splitting: true, format: 'esm', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ MODE: 'production', BASE_URL: '/', DEV: false, PROD: true }) },
  loader: { '.woff2': 'file', '.woff': 'file', '.svg': 'file', '.png': 'file', '.ttf': 'file' },
  plugins: [{ name: 'real-monaco-workers-and-unused-preview-branches', setup(builder) {
    builder.onResolve({ filter: /\?worker$/ }, args => {
      const full = createRequire(path.join(args.resolveDir, 'package.json')).resolve(args.path.replace(/\?worker$/, ''))
      const name = path.basename(full).replace(/\.js$/, '')
      workers.set(name, full)
      return { path: name, namespace: 'monaco-worker' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'monaco-worker' }, args => ({
      contents: `export default class extends Worker { constructor() { super('/workers/${args.path}.js', { type: 'module' }) } }`, loader: 'js',
    }))
    // Office/CAD/other lazy previews are outside this Markdown/diff acceptance.
    // Monaco itself and its genuine worker implementations remain in the build.
    builder.onResolve({ filter: /.*/ }, args => args.kind === 'dynamic-import' && args.path !== 'monaco-editor'
      && !args.importer.replaceAll('\\', '/').includes('/node_modules/')
      ? { path: args.path, external: true } : undefined)
  } }],
})
await build({ entryPoints: Object.fromEntries(workers), outdir: path.join(run, 'workers'), bundle: true,
  format: 'esm', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })
const server = http.createServer((request, response) => {
  void syntheticHost(request, response, async () => {
    try {
      const url = new URL(request.url, 'http://localhost')
      if (url.pathname === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>')
        return
      }
      const target = path.resolve(run, `.${decodeURIComponent(url.pathname)}`)
      const relative = path.relative(run, target)
      assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative))
      response.setHeader('Content-Type', target.endsWith('.css') ? 'text/css' : target.endsWith('.woff2') ? 'font/woff2' : target.endsWith('.ttf') ? 'font/ttf' : 'text/javascript')
      response.end(await fs.readFile(target))
    } catch (error) { response.writeHead(404); response.end(String(error)) }
  })
})
async function syntheticHost(request, response, next) {
  const url = new URL(request.url, 'http://localhost')
  if (!url.pathname.startsWith('/__code_work/')) return next()
  try {
    const target = await fs.realpath(url.searchParams.get('path') ?? '')
    const relative = path.relative(await fs.realpath(root), target)
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), 'test host escaped its isolated project')
    if (url.pathname === '/__code_work/read') {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8')
      response.end(await fs.readFile(target)); return
    }
    assert.equal(url.pathname, '/__code_work/list')
    const entries = await fs.readdir(target, { withFileTypes: true })
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(entries.map(item => ({ name: item.name, path: path.join(target, item.name).replaceAll('\\', '/'), isDirectory: item.isDirectory() }))))
  } catch (error) { response.writeHead(400); response.end(String(error)) }
}
let context, page
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  await checkpoint('static-server-ready')
  const probe = probePlaywrightChromium()
  assert.ok(probe.ok, probe.detail)
  context = await chromium.launchPersistentContext(path.join(run, '.cache/browser-profile'), {
    headless: true, executablePath: path.join(probe.root, probe.build, 'chrome-win64/chrome.exe'),
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1, reducedMotion: 'reduce',
  })
  await checkpoint('owned-chromium-ready')
  page = context.pages()[0] ?? await context.newPage()
  page.on('pageerror', error => proof.diagnostics.push(error.message))
  page.on('response', response => { if (response.status() >= 400) proof.diagnostics.push(`HTTP ${response.status()}: ${response.url()}`) })
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue()
    proof.diagnostics.push(`Unexpected external request: ${route.request().url()}`)
    return route.abort()
  })
  await page.goto(`${origin}/?root=${encodeURIComponent(root.replaceAll('\\', '/'))}`, { waitUntil: 'commit' })
  await checkpoint('document-committed')
  await page.waitForFunction(() => window.codeWorkControls && document.querySelector('.chat-panel, .agent-conversation-surface, .input-bar'), undefined, { timeout: 60000 })
  await checkpoint('production-shell-mounted')
  const control = (method, value) => page.evaluate(({ method, value }) => window.codeWorkControls[method](value), { method, value })
  const capture = name => page.screenshot({ path: path.join(run, `${name}.png`) })
  const rail = page.locator('.right-rail')
  const waitView = view => page.waitForFunction(view => document.querySelector('.right-rail')?.getAttribute('data-view') === view, view)
  const closePreview = async kind => {
    await page.getByRole('button', { name: kind === 'diff' ? 'Close diff' : 'Close file preview', exact: true }).click()
    await waitView('review')
  }
  const assertPicker = async () => {
    const values = await page.getByRole('combobox', { name: '成果文件', exact: true })
      .locator('option').evaluateAll(options => options.map(option => option.value))
    assert.ok(values.some(value => value.endsWith('/.trylo/out/review.md')))
    assert.ok(values.some(value => value.endsWith('/.trylo/out/archive.pdf')))
  }
  for (const mode of ['code', 'work']) {
    await control('setMode', mode)
    await page.waitForFunction(mode => document.querySelector('.app-shell')?.getAttribute('data-mode') === mode, mode)
    const title = mode === 'code' ? '变更审查' : '交付物'
    const trigger = page.getByRole('button', { name: title, exact: true })
    await trigger.waitFor()
    assert.equal(await page.locator('.result-dock__content').count(), 0)
    await trigger.click(); await waitView('review')
    assert.equal(await rail.getByRole('tab', { name: mode === 'code' ? '变更' : '交付物', exact: true }).getAttribute('aria-selected'), 'true')
    const scroll = await page.locator('.right-rail__review').evaluate(element => {
      element.scrollTop = element.scrollHeight
      return { height: element.clientHeight, scroll: element.scrollHeight, top: element.scrollTop }
    })
    assert.ok(scroll.scroll > scroll.height && scroll.top > 0)
    await page.locator('.right-rail__review').evaluate(element => { element.scrollTop = 0 })
    await capture(`${mode}-light-results`)
    const openFile = rail.getByRole('button', { name: '打开文件 .trylo/out/review.md', exact: true })
    await openFile.click()
    await waitView('preview')
    await page.getByRole('region', { name: 'Markdown preview', exact: true }).getByRole('heading', { name: '连续构建预览' }).waitFor()
    await assertPicker()
    await capture(`${mode}-markdown`)
    await rail.getByRole('tab', { name: mode === 'code' ? '变更' : '交付物', exact: true }).click()
    await openFile.click(); await waitView('preview')
    await closePreview('file')
    await rail.getByRole('button', { name: `${mode === 'code' ? '查看差异' : '查看 Git 变更'} .trylo/out/review.md`, exact: true }).click()
    await waitView('preview')
    await page.locator('.git-diff-view__monaco .monaco-editor:visible').first().waitFor({ timeout: 60000 })
    await page.waitForFunction(() => !document.querySelector('[aria-label="加载对比编辑器"]'))
    assert.equal(await page.getByRole('alert').filter({ hasText: '对比编辑器未能加载' }).count(), 0)
    await capture(`${mode}-diff`)
    await closePreview('diff')
    if (mode === 'work') {
      const prior = await page.evaluate(() => window.codeWorkProof.fileCalls.length)
      await rail.getByRole('button', { name: '打开链接 https://example.test/result.html', exact: true }).click()
      assert.equal(await page.evaluate(() => window.codeWorkProof.fileCalls.length), prior)
      assert.ok((await page.evaluate(() => window.codeWorkProof.hostCalls)).includes('open:https://example.test/result.html'))
    }
    for (const theme of ['light', 'dark']) {
      await control('setAppearance', theme)
      await page.setViewportSize({ width: 480, height: 760 })
      await capture(`${mode}-${theme}-narrow`)
      const bounds = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
        right: document.querySelector('.right-rail').getBoundingClientRect().right }))
      assert.ok(bounds.scroll <= bounds.width + 1 && bounds.right <= bounds.width + 1, JSON.stringify(bounds))
    }
    await page.setViewportSize({ width: 1440, height: 900 }); await control('setAppearance', 'light')
    await page.getByRole('button', { name: '收起面板', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.right-rail'))
    await control('setRunning', true)
    await page.getByRole('button', { name: 'Stop', exact: true }).waitFor()
    const textbox = page.getByRole('textbox', { name: 'Message', exact: true })
    await textbox.fill('继续调整场景')
    assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: /^发送/ }).count(), 1)
    await page.getByRole('button', { name: 'Attach files', exact: true }).click()
    await page.getByText('reference.png', { exact: true }).waitFor()
    await page.getByRole('button', { name: /^发送/ }).click()
    await page.getByRole('button', { name: 'Stop', exact: true }).waitFor()
    assert.equal(await page.getByText('reference.png', { exact: true }).count(), 0)
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await page.getByRole('button', { name: 'Permission level: 完全自动', exact: true }).click()
    await page.getByRole('option', { name: /只读/ }).click()
    await page.getByRole('button', { name: 'Permission level: 只读', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Permission level: 只读', exact: true }).click()
    await page.getByRole('option', { name: /完全自动/ }).click()
    await capture(`${mode}-composer`)
    proof.checks.push({ mode, sharedRail: true, actualMarkdown: true, realMonacoDiff: true,
      reopensSamePath: true, returnsToReview: true, scroll, narrowLightDark: true,
      composerSendStopAttachmentAndPermission: true })
  }
  await control('setMode', 'work')
  await page.getByRole('button', { name: '交付物', exact: true }).click(); await waitView('review')
  await page.evaluate(() => { window.codeWorkProof.delayDiffs = true })
  await rail.getByRole('button', { name: '查看 Git 变更 .trylo/out/review.md', exact: true }).click()
  await page.waitForFunction(() => window.codeWorkProof.pendingDiffs === 1)
  await control('setSessionId', 'chat-b')
  await page.waitForFunction(() => window.codeWorkProof.sessionId === 'chat-b' && window.codeWorkProof.activeDiff === null)
  await control('releaseDiffs')
  assert.equal(await page.locator('.git-diff-view').count(), 0)
  assert.equal(await page.getByRole('button', { name: '交付物', exact: true }).getAttribute('aria-expanded'), 'false')
  await control('setSessionId', 'chat-a')
  assert.equal(await page.getByRole('button', { name: '交付物', exact: true }).getAttribute('aria-expanded'), 'false')
  // Closing a preview had selected the preview tab, so the old session must stay collapsed.
  await page.getByRole('button', { name: '交付物', exact: true }).click(); await waitView('review')
  await rail.getByRole('button', { name: '查看 Git 变更 .trylo/out/review.md', exact: true }).click()
  await page.waitForFunction(() => window.codeWorkProof.pendingDiffs === 1)
  await control('setMode', 'code'); await control('releaseDiffs')
  await page.waitForFunction(() => window.codeWorkProof.mode === 'code' && window.codeWorkProof.activeDiff === null)
  assert.equal(await page.locator('.git-diff-view').count(), 0)
  await control('setEmpty', true)
  assert.equal(await page.locator('.result-dock').count(), 0)
  if (await rail.isVisible()) await page.getByRole('button', { name: '收起面板', exact: true }).click()
  await page.getByRole('button', { name: '结果侧栏', exact: true }).click()
  await rail.getByRole('tab', { name: '变更', exact: true }).click()
  await page.getByText('上轮记录', { exact: true }).waitFor()
  assert.equal(await rail.getByText('本轮记录', { exact: true }).count(), 0)
  assert.ok(await rail.getByRole('button', { name: '打开文件 .trylo/out/review.md', exact: true }).count())
  await rail.getByRole('button', { name: '打开文件 .trylo/out/review.md', exact: true }).click()
  await waitView('preview'); await assertPicker(); await closePreview('file')
  await capture('code-history-without-inline-result')
  await control('setMode', 'work')
  assert.equal(await page.locator('.result-dock').count(), 0)
  await rail.getByRole('tab', { name: '交付物', exact: true }).click()
  await rail.getByText('此对话的历史产物', { exact: true }).waitFor()
  assert.equal(await rail.getByText('本轮交付', { exact: true }).count(), 0)
  assert.ok(await rail.getByRole('button', { name: '打开文件 .trylo/out/review.md', exact: true }).count())
  await rail.getByRole('button', { name: '打开文件 .trylo/out/review.md', exact: true }).click()
  await waitView('preview'); await assertPicker(); await closePreview('file')
  await capture('empty-turn-no-old-result')
  proof.checks.push({ scopeNavigation: true, lateDiffIgnored: true, independentExpansion: true,
    emptyTurnNoOldResult: true, historyMarkdownPdfInPicker: true })
  proof.hostReceipts = await page.evaluate(() => window.codeWorkProof)
  assert.equal(proof.hostReceipts.composerCalls.filter(call => call.action === 'send').length, 2)
  assert.deepEqual(proof.diagnostics, [])
  proof.sourcesAfter = await hashes()
  proof.sourcesStable = JSON.stringify(proof.sourcesBefore) === JSON.stringify(proof.sourcesAfter)
  assert.ok(proof.sourcesStable, 'Relevant production source changed during this run; retain and rerun after source freeze')
  proof.passed = true
} catch (error) {
  proof.error = String(error.stack ?? error)
  if (page) await fs.writeFile(path.join(run, 'failure.html'), await page.content()).catch(() => {})
  if (page) await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await fs.writeFile(path.join(run, 'proof.json'), JSON.stringify(proof, null, 2))
  await context?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
console.log(JSON.stringify({ passed: proof.passed, run }))
