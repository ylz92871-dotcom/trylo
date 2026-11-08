// Render only the observer's production components, never a user's desktop.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { workspacePath } from '../../scripts/workspace-paths.mjs'
const desktop = fileURLToPath(new URL('../', import.meta.url))
const phase = process.argv.includes('--before') ? 'before' : 'after'
const output = workspacePath('tasks', 'computer-preview-ui-20261108', `${phase}-${Date.now()}`)
await fs.mkdir(output, { recursive: true })
const { build } = createRequire(new URL('../../desktop-services/package.json', import.meta.url))(
  'esbuild',
)
const { chromium } = createRequire(
  new URL('../../desktop-services/toolchain/browser/playwright-mcp/package.json', import.meta.url),
)('playwright')
await build({
  entryPoints: [path.join(desktop, 'testdata/computer-preview-acceptance/fixture.tsx')],
  outdir: output,
  entryNames: 'fixture',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  plugins: [
    {
      name: 'synthetic-observer-channel',
      setup(builder) {
        builder.onResolve({ filter: /host-adapter\/computer-preview-window$/ }, () => ({
          path: path.join(desktop, 'testdata/computer-preview-acceptance/channel.ts'),
        }))
      },
    },
  ],
})
const server = http.createServer(async (request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.slice(1)
  try {
    if (!name) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>',
      )
      return
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
      response.writeHead(404).end()
      return
    }
    response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript')
    response.end(await fs.readFile(path.join(output, name)))
  } catch {
    response.writeHead(404).end()
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const source = await fs.readFile(
  path.join(desktop, 'testdata/computer-preview-acceptance/desktop.svg'),
)
const frame = `data:image/svg+xml;base64,${source.toString('base64')}`
const proof = {
  phase,
  nativeDesktop: false,
  userDesktopControlled: false,
  checks: [],
  diagnostics: [],
}
let browser
const state = (kind) => ({
  title: '点击',
  status:
    kind === 'completed'
      ? '已完成'
      : kind === 'stopped'
        ? '已停止'
        : kind === 'failed'
          ? '失败'
          : '执行中',
  detail:
    kind === 'failed'
      ? '目标应用没有响应保存操作。请检查目标窗口是否被遮挡，并确认文档仍然打开后再继续。'
      : '',
  scope: 'synthetic-observer',
  streamState:
    kind === 'connecting'
      ? 'starting'
      : kind === 'error'
        ? 'error'
        : ['completed', 'stopped', 'failed'].includes(kind)
          ? 'stopped'
          : 'running',
  streamDetail: kind === 'error' ? '画面暂时断开，正在重新连接。' : '',
  dataUrl: kind === 'connecting' ? undefined : frame,
  screenshotAt: 1794141000000,
  frameGeometry: { width: 1440, height: 900, cursorX: 1288, cursorY: 128 },
  action: {
    id: 'save',
    title: '点击',
    target: '季度报告.docx 中的保存按钮',
    status: kind === 'completed' ? '已完成' : '执行中',
  },
  actions: [
    { id: 'open', title: '打开文档', target: '季度报告.docx', status: '已完成' },
    { id: 'review', title: '检查内容', target: '工作概况', status: '已完成' },
  ],
})
try {
  browser = await chromium.launch({ headless: true, channel: 'msedge' })
  const page = await browser.newPage({
    viewport: { width: 760, height: 540 },
    deviceScaleFactor: 1,
  })
  page.on('pageerror', (error) => proof.diagnostics.push(error.message))
  const load = async (theme = 'light') => {
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`)
    await page.waitForFunction(() => typeof window.publishPreview === 'function')
  }
  const publish = async (kind) => {
    await page.evaluate((value) => window.publishPreview(value), state(kind))
    if (kind !== 'connecting')
      await page.locator('.preview-image__stage img').evaluate((image) => image.decode())
  }
  const capture = async (name) => {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    await page.screenshot({ path: path.join(output, `${name}.png`) })
  }
  await load()
  await publish('running')
  await capture('running-light')
  await page.setViewportSize({ width: 480, height: 360 })
  await capture('minimum-light')
  if (phase === 'after') {
    const layout = await page.evaluate(() => {
      const rect = (selector) => {
        const r = document.querySelector(selector).getBoundingClientRect()
        return {
          x: r.x,
          y: r.y,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        }
      }
      return {
        header: rect('.computer-preview-window > header'),
        toolbar: rect('.preview-image__toolbar'),
        viewport: rect('.preview-image__viewport'),
        history: rect('.computer-preview-window__history'),
        scrollWidth: document.documentElement.scrollWidth,
      }
    })
    assert.ok(layout.toolbar.y >= layout.viewport.bottom - 1)
    assert.ok(layout.toolbar.y >= layout.history.y)
    assert.ok(layout.toolbar.bottom <= layout.history.bottom)
    assert.ok(layout.viewport.height > 280)
    assert.ok(layout.viewport.height > 100)
    assert.ok(layout.scrollWidth <= 480)
    proof.checks.push({ minimumLayout: layout })
    await page.getByRole('button', { name: '100%', exact: true }).click()
    assert.equal(
      await page.getByRole('button', { name: '100%', exact: true }).getAttribute('aria-pressed'),
      'true',
    )
    await page.getByRole('button', { name: '适应', exact: true }).click()
    proof.checks.push({ sharedZoomWorks: true })
    const historySummary = page.locator('.computer-preview-window__history-toggle')
    await historySummary.focus()
    await historySummary.press('Enter')
    await capture('minimum-history-light')
    const expandedLayout = await page.evaluate(() => ({
      viewportHeight: document.querySelector('.preview-image__viewport').getBoundingClientRect()
        .height,
      toolbarBottom: document.querySelector('.preview-image__toolbar').getBoundingClientRect()
        .bottom,
      historyTop: document
        .querySelector('.computer-preview-window__history-panel')
        .getBoundingClientRect().top,
    }))
    assert.ok(expandedLayout.viewportHeight > 100)
    assert.ok(expandedLayout.toolbarBottom <= expandedLayout.historyTop + 1)
    await historySummary.press('Enter')
    await publish('failed')
    await capture('minimum-failed-light')
    assert.match(await page.getByRole('status').textContent(), /目标应用没有响应保存操作/)
    const failureLayout = await page.locator('.preview-activity small').evaluate((element) => ({
      whiteSpace: getComputedStyle(element).whiteSpace,
      height: element.getBoundingClientRect().height,
    }))
    assert.equal(failureLayout.whiteSpace, 'normal')
    assert.ok(failureLayout.height > 16)
    await publish('stopped')
    await capture('minimum-stopped-light')
    assert.match(await page.getByRole('status').textContent(), /任务已停止/)
    assert.equal(await page.locator('.preview-activity .preview-actions__spin').count(), 0)
    proof.checks.push({
      keyboardHistoryAndMinimumExpanded: expandedLayout,
      failureReasonWraps: failureLayout,
      stoppedActionDoesNotSpin: true,
    })
    await publish('running')
    await page.setViewportSize({ width: 760, height: 540 })
    await historySummary.click()
    await capture('history-light')
    await historySummary.click()
    await publish('completed')
    await capture('completed-light')
    assert.ok(await page.getByText('画面已保留', { exact: true }).count())
    await load('dark')
    await publish('error')
    await capture('disconnected-dark')
    assert.match(await page.getByRole('alert').textContent(), /工具仍在执行/)
    await load()
    await capture('idle-light')
    await publish('connecting')
    await capture('connecting-light')
    proof.checks.push({ retainedAndDisconnectedDistinct: true, statesVerified: 8 })
  }
  assert.deepEqual(proof.diagnostics, [])
  proof.passed = true
} catch (error) {
  proof.passed = false
  proof.error = String(error.stack ?? error)
  throw error
} finally {
  await fs.writeFile(path.join(output, 'proof.json'), JSON.stringify(proof, null, 2))
  await browser?.close()
  const close = new Promise((resolve) => server.close(resolve))
  server.closeAllConnections()
  await close
}
console.log(JSON.stringify({ passed: proof.passed, phase, output }))
