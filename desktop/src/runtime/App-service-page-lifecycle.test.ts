import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { ServiceManager } from '../services-host/service-manager'
import { bindConversationPageLifecycle } from './conversation-page-lifecycle'

/** Execute App's actual effect, without copying its cleanup policy into a fixture. */
function appServiceEffect(host: 'native' | 'browser') {
  const source = ts.createSourceFile(
    'App.tsx',
    readFileSync(resolve('src/App.tsx'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const effects: ts.ArrowFunction[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') {
      const effect = node.arguments[0]
      if (effect && ts.isArrowFunction(effect)) {
        const text = effect.getText(source)
        if (text.includes('companion.dispose()') && text.includes('remoteController.dispose()'))
          effects.push(effect)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(effects).toHaveLength(1)
  const output = ts.transpileModule('const setup = ' + effects[0]!.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const page = new EventTarget()
  const invoke = vi.fn(async () => undefined)
  const manager = new ServiceManager({ invoke, listen: async () => () => {} })
  const companion = { dispose: vi.fn(() => manager.stop()) }
  const remoteController = { dispose: vi.fn(() => manager.stop()) }
  const setup = new Function(
    'window',
    'isTauriFn',
    'companion',
    'remoteController',
    'bindConversationPageLifecycle',
    'console',
    output + '; return setup;',
  )(page, () => host === 'native', companion, remoteController, bindConversationPageLifecycle, {
    warn: vi.fn(),
  }) as () => () => void
  const detach = setup()
  const settle = () =>
    Promise.all([
      companion.dispose.mock.results[0]?.value,
      remoteController.dispose.mock.results[0]?.value,
    ])
  return { page, invoke, companion, remoteController, detach, settle }
}

it('native pagehide leaves Service Host and both Code/Work tool gates under native ownership', async () => {
  const app = appServiceEffect('native')
  app.page.dispatchEvent(new Event('pagehide'))
  await app.settle()
  expect(app.companion.dispose).not.toHaveBeenCalled()
  expect(app.remoteController.dispose).not.toHaveBeenCalled()
  expect(app.invoke).not.toHaveBeenCalled()
  app.detach()
})

it('browser pagehide still disposes both domains and stops their shared Service Host', async () => {
  const app = appServiceEffect('browser')
  app.page.dispatchEvent(new Event('pagehide'))
  await app.settle()
  expect(app.companion.dispose).toHaveBeenCalledOnce()
  expect(app.remoteController.dispose).toHaveBeenCalledOnce()
  expect(app.invoke).toHaveBeenCalledWith('servicehost_stop')
  app.detach()
})

it('removing the App browser page listener prevents a later event from disposing live domains', async () => {
  const app = appServiceEffect('browser')
  app.detach()
  app.page.dispatchEvent(new Event('pagehide'))
  await app.settle()
  expect(app.companion.dispose).not.toHaveBeenCalled()
  expect(app.remoteController.dispose).not.toHaveBeenCalled()
  expect(app.invoke).not.toHaveBeenCalled()
})
