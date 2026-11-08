import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { ServiceManager } from '../services-host/service-manager'

/** Execute the production App effect; service transport stays hermetic. */
function startupEffect(options: { browser?: boolean; startupError?: Error } = {}) {
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
        if (
          text.includes('serviceHostPathsRef.current') &&
          text.includes('serviceManager.ensureRunning')
        )
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
  const connections = new Set(['existing-browser-gate', 'existing-model-gate'])
  let listener: ((event: { payload: unknown }) => void) | undefined
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'servicehost_spawn') {
      if (options.startupError) throw options.startupError
      return { pid: 42, generation: 7, script: '<running>' }
    }
    if (command === 'servicehost_stop') connections.clear()
    if (command === 'servicehost_status') return { running: true, pid: 42 }
    if (command === 'servicehost_send') {
      const request = JSON.parse(String(args?.frame)) as { id: string }
      listener?.({
        payload: JSON.stringify({
          version: 1,
          type: 'response',
          id: request.id,
          ok: true,
          result: { ok: true, coreToolsRevision: 1, packages: [] },
        }),
      })
    }
    return {}
  })
  const manager = new ServiceManager({
    invoke,
    listen: async (_event, receive) => {
      listener = receive
      return () => {
        listener = undefined
      }
    },
  })
  const paths = vi.fn(async () => ({
    sidecarsDir: '/fixture/resources',
    appDataDir: '/fixture/data',
  }))
  const warn = vi.fn()
  const setup = new Function(
    'isTauriFn',
    'serviceHostPathsRef',
    'serviceManager',
    'toolCatalog',
    'console',
    output + '; return setup;',
  )(
    () => !options.browser,
    { current: paths },
    manager,
    { coreToolsRevision: 2 },
    { warn },
  ) as () => (() => void) | undefined
  const detach = setup()
  return {
    manager,
    invoke,
    paths,
    warn,
    connections,
    detach,
    settle: () => new Promise<void>((done) => setImmediate(done)),
    dispose: async () => {
      detach?.()
      await manager.client.stop()
    },
  }
}

it('App startup preserves a reused native host and existing Code/Work tool connections', async () => {
  const app = startupEffect()
  try {
    await app.settle()
    expect(app.manager.currentHealth).toBe('ready')
    expect(app.connections).toEqual(new Set(['existing-browser-gate', 'existing-model-gate']))
    expect(
      app.invoke.mock.calls.filter(([command]) => command === 'servicehost_stop'),
    ).toHaveLength(0)
    expect(
      app.invoke.mock.calls.filter(([command]) => command === 'servicehost_spawn'),
    ).toHaveLength(1)
  } finally {
    await app.dispose()
  }
})

it('App startup reports a rejected native startup without claiming readiness', async () => {
  const failure = new Error('fixture startup rejected')
  const app = startupEffect({ startupError: failure })
  try {
    await app.settle()
    expect(app.manager.currentHealth).toBe('stopped')
    expect(app.warn).toHaveBeenCalledWith(
      '[trylo] Service Host startup failed; learning will degrade',
      failure,
    )
    expect(
      app.invoke.mock.calls.filter(([command]) => command === 'servicehost_stop'),
    ).toHaveLength(0)
  } finally {
    await app.dispose()
  }
})

it('App startup stays a no-op in the browser', async () => {
  const app = startupEffect({ browser: true })
  try {
    await app.settle()
    expect(app.detach).toBeUndefined()
    expect(app.manager.currentHealth).toBe('stopped')
    expect(app.paths).not.toHaveBeenCalled()
    expect(app.invoke).not.toHaveBeenCalled()
  } finally {
    await app.dispose()
  }
})
