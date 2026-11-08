import {
  runCliCommand,
  type CliCommandInput,
  type CliCommandResult,
  type CliCommandControlPort,
} from '../host-adapter/cli-command'
import { createToolLibraryClient } from '../tool-library/client'
import { createExpertLibraryClient } from '../experts'
import type { CollaborationLearningRuntime } from './cli'
import { expertUserActionControl } from './expert-user-action-control'
import type { ExpertCommand, ExpertUserActionEvidence } from '../experts/client'

type Runner = (input: CliCommandInput) => Promise<CliCommandResult>
const STOP_UNCONFIRMED = '上次库操作尚未确认停止，请先在进程提示中重试停止。'
const BINDING_WAIT_MS = 5000

function readOperation(owner: 'tool' | 'expert', input: unknown): boolean {
  if (input === null || typeof input !== 'object') return false
  const command = owner === 'tool' && 'command' in input ? input.command : input
  if (command === null || typeof command !== 'object' || !('operation' in command)) return false
  return (
    command.operation === 'query' ||
    (owner === 'expert' && command.operation === 'requests') ||
    (owner === 'tool' && command.operation === 'get-request')
  )
}

/** Normal binding may settle; retained stops require exact native-exit proof.
 * Admission and start share one synchronous callback, so waiters cannot all pass on one binding receipt. */
async function startRead(
  control: CliCommandControlPort | undefined,
  signal: AbortSignal,
  start: () => Promise<CliCommandResult>,
): Promise<CliCommandResult> {
  if (signal.aborted) return Promise.reject(new Error('cancelled'))
  const before = control?.startState?.()
  if (before === 'stopping' || before === 'stop_unconfirmed') {
    await control?.reconcile?.()
    if (signal.aborted) throw new Error('cancelled')
  }
  if (control?.startState === undefined) {
    return control?.canStart?.() === false ? Promise.reject(new Error(STOP_UNCONFIRMED)) : start()
  }
  return new Promise((resolve, reject) => {
    let settled = false,
      unsubscribe: (() => void) | undefined
    const cleanup = () => {
      clearTimeout(timer)
      unsubscribe?.()
      signal.removeEventListener('abort', abort)
    }
    const fail = (error: unknown) => {
      if (!settled) {
        settled = true
        cleanup()
        reject(error)
      }
    }
    const abort = () => fail(new Error('cancelled'))
    const inspect = () => {
      if (settled) return
      if (signal.aborted) {
        abort()
        return
      }
      try {
        const state = control.startState!()
        if (state === 'stopping' || state === 'stop_unconfirmed') {
          fail(new Error(STOP_UNCONFIRMED))
          return
        }
        if (state === 'binding') {
          if (control.subscribe === undefined) fail(new Error('库进程仍在连接，请稍后重试。'))
          return
        }
        if (control.canStart?.() === false) {
          fail(new Error(STOP_UNCONFIRMED))
          return
        }
        settled = true
        cleanup()
        resolve(start())
      } catch (error) {
        if (settled) reject(error)
        else fail(error)
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => fail(new Error('库进程仍在连接，请稍后重试。')), BINDING_WAIT_MS)
    try {
      unsubscribe = control.subscribe?.(inspect)
      if (settled) unsubscribe?.()
      else inspect()
    } catch (error) {
      fail(error)
    }
  })
}
/** Ordinary library routes retain the real PermissionPort; no UI payload is treated as approval. */
export function createDesktopLibraryClients(
  runtime: CollaborationLearningRuntime,
  run: Runner = runCliCommand,
  control?: CliCommandControlPort,
) {
  const invoke = async (
    owner: 'tool' | 'expert',
    input: unknown,
    signal: AbortSignal,
    commandControl = control,
  ): Promise<unknown> => {
    const start = () =>
      run({
        ...runtime,
        args: [
          'library',
          owner,
          '--workspace',
          runtime.cwd,
          ...(commandControl ? ['--permission-prompt-tool', 'stdio'] : []),
          '-',
        ],
        stdin: `${JSON.stringify(input)}\n`,
        signal,
        timeoutMs: 300000,
        ...(commandControl ? { control: commandControl } : {}),
      })
    const read = readOperation(owner, input)
    if (!read && control?.canStart?.() === false) throw new Error(STOP_UNCONFIRMED)
    const result = await (read ? startRead(control, signal, start) : start())
    if (!result.ok) {
      let failure: unknown
      try {
        failure = JSON.parse(result.stdout ?? '')
      } catch {
        throw new Error(result.reason)
      }
      if (failure && typeof failure === 'object' && 'ok' in failure && failure.ok === false) {
        if (
          owner === 'tool' &&
          'code' in failure &&
          typeof failure.code === 'string' &&
          'message' in failure &&
          typeof failure.message === 'string'
        )
          return failure
        if ('reason' in failure && typeof failure.reason === 'string')
          throw new Error(`库操作未完成（${failure.reason}），请刷新原库状态后重试。`)
      }
      throw new Error(result.reason)
    }
    return JSON.parse(result.stdout) as unknown
  }
  return {
    tools: createToolLibraryClient((context, command, signal) => {
      if (context.scope !== runtime.cwd) throw new Error('workspace_scope_mismatch')
      return invoke('tool', { context, command }, signal)
    }),
    experts: createExpertLibraryClient({
      invoke: (command, signal) => invoke('expert', command, signal),
      async invokeUserAction(
        command: ExpertCommand,
        signal: AbortSignal,
        evidence?: ExpertUserActionEvidence,
      ) {
        if (control?.respondToUserAction === undefined) return invoke('expert', command, signal)
        const action = expertUserActionControl({
          command,
          ...(evidence === undefined ? {} : { evidence }),
          workspaceRoot: runtime.cwd,
          control,
          signal,
        })
        return invoke('expert', action.command, signal, action.control)
      },
    }),
  }
}
