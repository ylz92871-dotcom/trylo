import { useCallback, useEffect, useRef, useState } from 'react'
import type { ServiceManager } from '../services-host/service-manager'
import type { ToolingFacade } from './tooling-facade'
import {
  softwareScopeKey,
  type SoftwareCommand,
  type SoftwareFrame,
  type SoftwareMode,
  type SoftwareScope,
  type SoftwareState,
} from './software-workspace-types'

export interface SoftwareWorkspaceController {
  readonly state?: SoftwareState
  readonly frame?: SoftwareFrame
  readonly error: string
  readonly busy: boolean
  readonly open: boolean
  readonly mode: SoftwareMode
  readonly selectedWindow?: string
  readonly available: boolean
  readonly setOpen: (open: boolean) => void
  readonly setMode: (mode: SoftwareMode) => void
  readonly selectWindow: (id: string) => void
  readonly refresh: () => Promise<void>
  readonly command: (command: LocalCommand) => Promise<void>
}
type LocalCommand = SoftwareCommand extends infer Command
  ? Command extends SoftwareCommand
    ? Omit<Command, keyof SoftwareScope>
    : never
  : never

/** Owns transient view data, never application lifetime. Hiding/unmounting the
 * dock stops polling; only explicit stop or the Service Host closes software. */
export function useSoftwareWorkspace(options: {
  facade?: ToolingFacade | null
  manager?: ServiceManager | null
  projectRoot?: string
  conversationId?: string | null
  suspended?: boolean
}): SoftwareWorkspaceController {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<SoftwareState>()
  const [frame, setFrame] = useState<SoftwareFrame>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setModeValue] = useState<SoftwareMode>('window')
  const [selectedWindow, selectWindowValue] = useState<string>()
  const current = useRef({ ...options, mode, selectedWindow, state })
  current.current = { ...options, mode, selectedWindow, state }
  const identity =
    options.projectRoot && options.conversationId
      ? softwareScopeKey({
          projectRoot: options.projectRoot,
          conversationId: options.conversationId,
        })
      : ''
  const owner = useRef(identity)
  owner.current = identity
  const mounted = useRef(true)
  const viewVersion = useRef(0)
  const connectionVersion = useRef(0)
  const refreshInFlight = useRef<{ owner: string; promise: Promise<void> }>()
  const sessions = useRef<{ current?: string; retired: Set<string> }>({ retired: new Set() })
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    sessions.current = { retired: new Set() }
    connectionVersion.current++
    viewVersion.current++
    setState(undefined)
    setFrame(undefined)
    setError('')
    setBusy(false)
    selectWindowValue(undefined)
    setModeValue('window')
  }, [identity])

  const adopt = useCallback((value: SoftwareState): void => {
    if (value.scope !== owner.current) return
    const known = sessions.current
    if (known.retired.has(value.sessionId)) return
    if (known.current !== value.sessionId) {
      if (known.current) known.retired.add(known.current)
      known.current = value.sessionId
    }
    setState((prior) => {
      if (prior?.sessionId === value.sessionId && prior.revision > value.revision) return prior
      return { ...value, installed: value.installed ?? prior?.installed }
    })
    if (value.state === 'stopped' || value.state === 'error') setFrame(undefined)
  }, [])
  useEffect(() => {
    const manager = options.manager
    if (!manager) return
    const unsubscribe = manager.client.onEvent('tooling.softwareWorkspaceState', (value) => {
      if (value.scope !== owner.current) return
      adopt(value)
      if (value.applications.some((app) => app.running) && value.state === 'running') {
        // A new application can reveal the workspace once. Periodic state
        // updates must respect the user's later decision to hide the dock.
        const key = `${value.sessionId}:${value.applications.map((app) => app.id).join(',')}`
        if (revealed.current !== key) {
          revealed.current = key
          setOpen(true)
        }
      }
    })
    const down = manager.onDown(() => {
      connectionVersion.current++
      viewVersion.current++
      refreshInFlight.current = undefined
      if (sessions.current.current) sessions.current.retired.add(sessions.current.current)
      sessions.current.current = undefined
      setState(undefined)
      setBusy(false)
      setFrame(undefined)
      setError('工具服务已断开。后台软件会随服务退出；重新连接后请检查已保存的文件，再启动工作区。')
    })
    return () => {
      unsubscribe()
      down()
    }
  }, [options.manager, adopt])
  const revealed = useRef('')

  const request = useCallback(
    async (command: LocalCommand) => {
      const { facade, projectRoot, conversationId } = current.current
      if (!facade || !projectRoot || !conversationId)
        throw new Error('请先打开一个项目对话，再启动软件工作区。')
      const expected = owner.current
      const expectedView = viewVersion.current
      const expectedConnection = connectionVersion.current
      const result = await facade.softwareWorkspace({ ...command, projectRoot, conversationId })
      if (
        !mounted.current ||
        owner.current !== expected ||
        expectedConnection !== connectionVersion.current
      )
        return
      if ('state' in result) adopt(result)
      if ('data' in result) {
        if (expectedView !== viewVersion.current) return
        if (current.current.state && result.sessionId !== current.current.state.sessionId) return
        setFrame(result)
      }
      return result
    },
    [adopt],
  )
  const refresh = useCallback((): Promise<void> => {
    const expected = owner.current
    const expectedConnection = connectionVersion.current
    if (refreshInFlight.current?.owner === expected) return refreshInFlight.current.promise
    const promise = (async () => {
      try {
        const observed = await request({ operation: 'status' })
        if (
          !observed ||
          !('state' in observed) ||
          observed.state !== 'running' ||
          !observed.windows.length
        )
          return
        const values = current.current
        const chosen = observed.windows.find((window) => window.id === values.selectedWindow)
        if (!chosen && values.selectedWindow) selectWindowValue(undefined)
        await request({
          operation: 'snapshot',
          input: { mode: values.mode, ...(chosen ? { windowId: chosen.id } : {}) },
        })
        if (
          mounted.current &&
          owner.current === expected &&
          connectionVersion.current === expectedConnection
        )
          setError('')
      } catch (value) {
        if (
          mounted.current &&
          owner.current === expected &&
          connectionVersion.current === expectedConnection
        )
          setError(value instanceof Error ? value.message : String(value))
      }
    })().finally(() => {
      if (refreshInFlight.current?.promise === promise) refreshInFlight.current = undefined
    })
    refreshInFlight.current = { owner: expected, promise }
    return promise
  }, [request])
  useEffect(() => {
    if (!open || !identity || options.suspended) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      if (!active) return
      await refresh()
      if (active)
        timer = setTimeout(() => {
          void poll()
        }, 700)
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [open, identity, options.suspended, refresh])
  const command = useCallback(
    async (action: LocalCommand): Promise<void> => {
      const expected = owner.current
      const expectedConnection = connectionVersion.current
      setBusy(true)
      setError('')
      try {
        await request(action)
        if (
          owner.current === expected &&
          expectedConnection === connectionVersion.current &&
          action.operation !== 'close'
        )
          await refresh()
      } catch (value) {
        if (
          mounted.current &&
          owner.current === expected &&
          expectedConnection === connectionVersion.current
        )
          setError(value instanceof Error ? value.message : String(value))
      } finally {
        if (
          mounted.current &&
          owner.current === expected &&
          expectedConnection === connectionVersion.current
        )
          setBusy(false)
      }
    },
    [request, refresh],
  )
  const setMode = useCallback((value: SoftwareMode): void => {
    viewVersion.current++
    setFrame(undefined)
    setModeValue(value)
  }, [])
  const selectWindow = useCallback((id: string): void => {
    viewVersion.current++
    setFrame(undefined)
    selectWindowValue(id || undefined)
    setModeValue('window')
  }, [])
  return {
    state,
    frame,
    error,
    busy,
    open,
    mode,
    selectedWindow,
    setOpen,
    setMode,
    selectWindow,
    refresh,
    command,
    available: !!options.facade && !!identity,
  }
}
