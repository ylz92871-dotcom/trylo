import { useEffect, useRef, type PointerEvent, type ReactElement } from 'react'
import { AppWindow, LoaderCircle, Plus } from 'lucide-react'
import type { SoftwareWorkspaceController } from '../../tooling/use-software-workspace'
import type { SoftwareFrame, SoftwareKey } from '../../tooling/software-workspace-types'

function point(
  event: PointerEvent<HTMLImageElement>,
  frame: SoftwareFrame,
): readonly [number, number] {
  const bounds = event.currentTarget.getBoundingClientRect()
  return [
    Math.min(
      frame.width - 1,
      Math.max(0, Math.round(((event.clientX - bounds.left) * frame.width) / bounds.width)),
    ),
    Math.min(
      frame.height - 1,
      Math.max(0, Math.round(((event.clientY - bounds.top) * frame.height) / bounds.height)),
    ),
  ]
}

/** Only the displayed window's pixels accept input. Model images stay read-only. */
export function SoftwareCanvas({
  controller,
  expanded,
  onLaunch,
}: {
  readonly controller: SoftwareWorkspaceController
  readonly expanded: boolean
  readonly onLaunch: () => void
}): ReactElement {
  const { state, frame, busy, error } = controller
  const image = useRef<HTMLImageElement>(null)
  const drag = useRef<{
    windowId: string
    start: readonly [number, number]
    path: (readonly [number, number])[]
    button: 'left' | 'right'
  }>()
  const interactive =
    (state?.control === 'user' || (state?.control === 'pending' && frame?.dialog)) &&
    frame?.mode === 'window' &&
    !busy &&
    !error
  const hasApps = state?.applications.some((app) => app.running) ?? false
  useEffect(() => {
    const target = image.current
    if (!target || !interactive || !frame) return
    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      const bounds = target.getBoundingClientRect()
      void controller.command({
        operation: 'input',
        input: {
          kind: 'wheel',
          windowId: frame.windowId,
          x: Math.min(
            frame.width - 1,
            Math.max(0, Math.round(((event.clientX - bounds.left) * frame.width) / bounds.width)),
          ),
          y: Math.min(
            frame.height - 1,
            Math.max(0, Math.round(((event.clientY - bounds.top) * frame.height) / bounds.height)),
          ),
          delta: event.deltaY < 0 ? 120 : -120,
        },
      })
    }
    target.addEventListener('wheel', wheel, { passive: false })
    return () => target.removeEventListener('wheel', wheel)
  }, [interactive, frame, controller])
  const release = (event: PointerEvent<HTMLImageElement>): void => {
    const gesture = drag.current
    drag.current = undefined
    if (!gesture || !frame || !interactive || gesture.windowId !== frame.windowId) return
    const end = point(event, frame)
    const moved = Math.abs(end[0] - gesture.start[0]) + Math.abs(end[1] - gesture.start[1]) > 3
    void controller.command({
      operation: 'input',
      input: {
        kind: 'click',
        windowId: frame.windowId,
        x: gesture.start[0],
        y: gesture.start[1],
        button: gesture.button,
        ...(moved ? { path: [...gesture.path, end] } : {}),
      },
    })
  }
  return (
    <div
      className={`software-workspace__canvas${interactive ? ' software-workspace__canvas--interactive' : ''}`}
    >
      {frame ? (
        <img
          ref={image}
          src={`data:${frame.mimeType};base64,${frame.data}`}
          alt={`${frame.title || '软件窗口'}的当前画面`}
          draggable={false}
          tabIndex={interactive ? 0 : -1}
          onContextMenu={(event) => {
            if (interactive) event.preventDefault()
          }}
          onPointerDown={(event) => {
            if (!interactive) return
            event.preventDefault()
            event.currentTarget.focus()
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = {
              windowId: frame.windowId,
              start: point(event, frame),
              path: [],
              button: event.button === 2 ? 'right' : 'left',
            }
          }}
          onPointerMove={(event) => {
            if (drag.current && interactive) drag.current.path.push(point(event, frame))
          }}
          onPointerUp={release}
          onPointerCancel={() => {
            drag.current = undefined
          }}
          onKeyDown={(event) => {
            if (
              !interactive ||
              event.key === 'Tab' ||
              (expanded && event.key === 'Escape') ||
              ![
                'Enter',
                'Escape',
                'Backspace',
                'Delete',
                'ArrowLeft',
                'ArrowUp',
                'ArrowRight',
                'ArrowDown',
                ' ',
              ].includes(event.key)
            )
              return
            event.preventDefault()
            void controller.command({
              operation: 'input',
              input: {
                kind: 'key',
                windowId: frame.windowId,
                key: (event.key === ' ' ? 'Space' : event.key) as SoftwareKey,
              },
            })
          }}
        />
      ) : (
        <div className="software-workspace__empty">
          <div className="software-workspace__empty-icon">
            {hasApps || state?.state === 'starting' ? (
              <LoaderCircle size={30} className="software-workspace__spin" />
            ) : (
              <AppWindow size={32} strokeWidth={1.3} />
            )}
          </div>
          <h3>
            {!controller.available
              ? '从一个对话开始'
              : hasApps
                ? '正在准备软件画面'
                : state?.state === 'stopped'
                  ? '工作区已结束'
                  : '把软件留在任务里'}
          </h3>
          <p>
            {!controller.available
              ? '打开项目对话后，可以在这里启动和观察软件。'
              : hasApps
                ? '首次启动可能需要一点时间。启动对话框也会显示在这里。'
                : '一边看执行过程，一边看软件结果。后台操作不会接管你的桌面。'}
          </p>
          {!hasApps && controller.available && (
            <button type="button" className="software-workspace__primary" onClick={onLaunch}>
              <Plus size={15} />
              启动软件
            </button>
          )}
        </div>
      )}
      {frame?.dialog && (
        <span className="software-workspace__dialog-badge">软件正在等待对话框操作</span>
      )}
    </div>
  )
}
