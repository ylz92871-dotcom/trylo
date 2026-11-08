/** Node-only contract fixture. Loads the strictly compiled CLI artifact; never bundled by production. */
import path from 'node:path'
import { expect } from 'vitest'
import { runCliCommand } from '../host-adapter/cli-command'
import { ConversationRunSupervisor } from '../runtime/conversation-run-supervisor'
import { createDesktopLibraryClients } from './library-clients'
/** Runs the actual library CLI handler and stdio session behind the process seam.
 * Store/provider are hermetic ports; Desktop transport, authority and lifecycle code are production code. */
export async function productionChain(buildRoot, configuration, transport, root) {
  const load = (file) =>
    import(/* @vite-ignore */ path.resolve(buildRoot, file).replaceAll('\\', '/'))
  const { ExpertLibrary, executeExpertCommand } = await load('internal/subagent/experts/index.js')
  const { createPermissionExpertAuthorization } = await load(
    'internal/adapters/expert-library/permission.js',
  )
  const { handleLibraryCommand } = await load('internal/surface/cli/commands-library.js')
  const { createInteractivePermission } = await load('internal/surface/cli/permission.js')
  let snapshot = {
      schemaVersion: 1,
      sequence: 0,
      experts: [],
      requests: [],
    },
    nextId = 0
  const processes = new Map()
  const lines = [],
    outputs = []
  const process = {
    async spawn(options) {
      const id = `process-${++nextId}`
      processes.set(id, { options, lines: [], started: false })
      return { id, pid: nextId, command: options.command, label: options.label }
    },
    async send(id, line) {
      lines.push(line)
      const child = processes.get(id)
      if (child.reader) {
        const receive = child.reader
        child.reader = undefined
        receive(line.trim())
      } else child.lines.push(line.trim())
      if (child.started) return
      child.started = true
      const readLine = async () =>
        child.lines.shift() ??
        new Promise((resolve) => {
          child.reader = resolve
        })
      const ctx = {
        cwd: root,
        homeDir: root,
        nodeVersion: '22',
        env: {},
        stdinIsTty: false,
        isDirectory: () => true,
        readFile: () => undefined,
        readDir: () => [],
        writeFile: () => false,
        readLine,
        readStdin: async () => '',
        readSecret: async () => undefined,
        now: () => 1,
        newId: (prefix) => `${prefix}-${++nextId}`,
        stderr: () => {},
        stdout: (text) => {
          outputs.push(text)
          child.options.onOutput(text.trim())
        },
        libraryHosts: async (input) => {
          const permission = createInteractivePermission({
            prompt: () => {},
            readLine,
            ...input.approval,
          })
          const library = new ExpertLibrary({
            store: {
              read: () => structuredClone(snapshot),
              update(expected, value) {
                expect(expected).toBe(snapshot.sequence)
                snapshot = structuredClone(value)
              },
            },
            authorization: createPermissionExpertAuthorization({ permission }),
            builder: {
              async build() {
                return configuration
              },
            },
          })
          return {
            expert: {
              execute: (command, context) =>
                executeExpertCommand(library, command, {
                  ...context,
                  useScope: { workspaceId: root, taskId: id },
                }),
            },
          }
        },
      }
      void handleLibraryCommand(ctx, {
        library: 'expert',
        workspace: root,
        permissionPromptTool: 'stdio',
      }).then((code) => {
        child.reader?.(undefined)
        child.reader = undefined
        child.options.onExit?.({ id, pid: 1, code, signal: null, outputComplete: true })
      })
    },
    async closeInput(_id) {},
    async stop(id) {
      const child = processes.get(id)
      child.reader?.(undefined)
      child.options.onExit?.({ id, pid: 1, code: 130, signal: null, outputComplete: true })
    },
  }
  transport.send = process.send
  const supervisor = new ConversationRunSupervisor()
  const control = supervisor.libraryApprovalPort({
    projectKey: root,
    conversationId: 'library',
    projectRoot: root,
  })
  const runtime = { process, cwd: root, cliPath: 'D:/trylo/main.js' }
  const clients = createDesktopLibraryClients(runtime, runCliCommand, control)
  const ordinary = (command) =>
    runCliCommand({
      ...runtime,
      args: ['library', 'expert', '--workspace', root, '--permission-prompt-tool', 'stdio', '-'],
      stdin: `${JSON.stringify(command)}\n`,
      control,
    })
  return { clients, supervisor, lines, outputs, ordinary, snapshot: () => snapshot }
}
