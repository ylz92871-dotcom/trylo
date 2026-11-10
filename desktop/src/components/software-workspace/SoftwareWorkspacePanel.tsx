import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import {
  AppWindow,
  Box,
  ChevronDown,
  Hand,
  Maximize2,
  Minimize2,
  MonitorOff,
  Plus,
  RefreshCw,
  Square,
  X,
} from 'lucide-react'
import type { SoftwareWorkspaceController } from '../../tooling/use-software-workspace'
import { SoftwareCanvas } from './SoftwareCanvas'
import { SoftwareInputBar } from './SoftwareInputBar'
import { SoftwareLauncher } from './SoftwareLauncher'

/** Canvas-first shell chrome. Application lifetime belongs to the service,
 * independently of this dock's visibility or selected conversation. */
export function SoftwareWorkspacePanel({
  controller,
  width,
  onClose,
}: {
  readonly controller: SoftwareWorkspaceController
  readonly width: number
  readonly onClose: () => void
}): ReactElement {
  const { state, frame, mode, error, busy } = controller
  const [expanded, setExpanded] = useState(false)
  const [launcher, setLauncher] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [clock, setClock] = useState(Date.now())
  const user = state?.control === 'user'
  const dialogControl = state?.control === 'pending' && frame?.dialog
  const hasApps = state?.applications.some((app) => app.running) ?? false
  const solidworks =
    state?.applications.some((app) => app.kind === 'solidworks' && app.running) ?? false
  const age = frame ? Math.max(0, Math.floor((clock - frame.timestamp) / 1000)) : 0
  const label =
    state?.state === 'error'
      ? '连接中断'
      : state?.state === 'stopped'
        ? '已结束'
        : hasApps
          ? state?.control === 'pending'
            ? '等待当前操作完成'
            : user
              ? '由你操作'
              : '模型可操作'
          : '等待启动软件'
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (stopping) setStopping(false)
      else if (launcher) setLauncher(false)
      else if (expanded) setExpanded(false)
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [expanded, launcher, stopping])
  const launch = async (path: string): Promise<void> => {
    setLauncher(false)
    await controller.command({ operation: 'open', input: { path } })
  }

  return (
    <aside
      className={`software-workspace${expanded ? ' software-workspace--expanded' : ''}`}
      style={{ '--software-width': `${width}px` } as CSSProperties}
      aria-label="软件工作区"
    >
      <header className="software-workspace__header">
        <div className="software-workspace__heading">
          <AppWindow size={17} />
          <div>
            <strong>软件工作区</strong>
            <span>专注当前任务 · 后台运行</span>
          </div>
        </div>
        <div className="software-workspace__actions">
          <button
            type="button"
            title="刷新画面"
            aria-label="刷新软件画面"
            disabled={busy}
            onClick={() => {
              void controller.refresh()
            }}
          >
            <RefreshCw size={15} className={busy ? 'software-workspace__spin' : ''} />
          </button>
          <button
            type="button"
            title={expanded ? '还原侧栏' : '展开工作区'}
            aria-label={expanded ? '还原软件侧栏' : '展开软件工作区'}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            type="button"
            title="隐藏工作区，软件继续运行"
            aria-label="隐藏软件工作区"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
      </header>
      <div className="software-workspace__toolbar">
        <button
          type="button"
          className="software-workspace__launch"
          aria-expanded={launcher}
          onClick={() => setLauncher((value) => !value)}
          disabled={busy || !controller.available}
        >
          <Plus size={14} />
          启动软件
          <ChevronDown size={12} />
        </button>
        <select
          aria-label="软件窗口"
          value={controller.selectedWindow ?? ''}
          onChange={(event) => controller.selectWindow(event.target.value)}
        >
          <option value="">
            自动选择窗口{state?.windows.some((window) => window.dialog) ? ' · 有对话框' : ''}
          </option>
          {state?.windows.map((window) => (
            <option value={window.id} key={window.id}>
              {window.dialog ? '对话框 · ' : ''}
              {window.title || '未命名窗口'}
            </option>
          ))}
        </select>
        {hasApps && (
          <button
            type="button"
            className="software-workspace__stop"
            title="结束后台软件"
            aria-label="结束软件工作区"
            onClick={() => setStopping(true)}
          >
            <Square size={13} />
          </button>
        )}
      </div>
      {launcher && (
        <SoftwareLauncher
          installed={state?.installed}
          onLaunch={launch}
          onClose={() => setLauncher(false)}
        />
      )}
      {solidworks && (
        <div className="software-workspace__views">
          <div role="group" aria-label="显示内容">
            <button
              type="button"
              aria-pressed={mode === 'window'}
              onClick={() => controller.setMode('window')}
            >
              软件窗口
            </button>
            <button
              type="button"
              aria-pressed={mode === 'model'}
              onClick={() => controller.setMode('model')}
            >
              <Box size={12} />
              模型视图
            </button>
          </div>
          {mode === 'model' && (
            <select
              aria-label="模型方向"
              defaultValue=""
              disabled={!user || busy}
              onChange={(event) => {
                const preset = event.target.value as 'isometric' | 'front' | 'top' | 'right'
                event.target.value = ''
                void controller.command({ operation: 'view', input: { preset } })
              }}
            >
              <option value="" disabled>
                切换视角
              </option>
              <option value="isometric">等轴测</option>
              <option value="front">前视</option>
              <option value="top">俯视</option>
              <option value="right">右视</option>
            </select>
          )}
        </div>
      )}
      {user && frame?.mode === 'window' && !frame.dialog && (
        <div className="software-workspace__window-size">
          <span>窗口尺寸</span>
          <select
            aria-label="调整软件窗口尺寸"
            defaultValue=""
            disabled={busy}
            onChange={(event) => {
              const [width, height] = event.target.value.split('x').map(Number)
              if (width === undefined || height === undefined) return
              event.target.value = ''
              void controller.command({
                operation: 'resize',
                input: { windowId: frame.windowId, width, height },
              })
            }}
          >
            <option value="" disabled>
              调整画面大小
            </option>
            <option value="1280x800">1280 × 800</option>
            <option value="1600x1000">1600 × 1000</option>
            <option value="1920x1080">1920 × 1080</option>
          </select>
        </div>
      )}
      {(error || state?.detail) && (
        <div className="software-workspace__error" role="alert">
          <MonitorOff size={16} />
          <div>
            {error || state?.detail}
            <button
              type="button"
              onClick={() => {
                void controller.refresh()
              }}
            >
              刷新状态
            </button>
          </div>
        </div>
      )}
      <SoftwareCanvas
        controller={controller}
        expanded={expanded}
        onLaunch={() => setLauncher(true)}
      />
      {solidworks && mode === 'window' && !frame?.dialog && (
        <div className="software-workspace__render-note">
          3D 模型请切换到“模型视图”查看；软件窗口用于菜单与对话框操作。
        </div>
      )}
      {solidworks && mode === 'model' && !frame?.dialog && <div className="software-workspace__render-note">模型视图用于观察和切换方向；点击菜单、输入文字请回到“软件窗口”。</div>}
      {(user || dialogControl) && frame?.mode === 'window' && (
        <SoftwareInputBar
          busy={busy}
          onText={(text) =>
            controller.command({
              operation: 'input',
              input: { kind: 'text', windowId: frame.windowId, text },
            })
          }
          onKey={(key) =>
            controller.command({
              operation: 'input',
              input: { kind: 'key', windowId: frame.windowId, key },
            })
          }
        />
      )}
      <footer className="software-workspace__footer">
        <div role="status">
          <span
            className={`software-workspace__dot${hasApps ? ' software-workspace__dot--on' : ''}`}
          />
          {label}
          <small>
            {frame
              ? `${age < 1 ? '刚刚更新' : `${age} 秒前更新`} · ${frame.width} × ${frame.height}`
              : '画面随软件启动显示'}
          </small>
        </div>
        {hasApps && (
          <button
            type="button"
            className={
              user
                ? 'software-workspace__takeover software-workspace__takeover--held'
                : 'software-workspace__takeover'
            }
            disabled={busy || state?.control === 'pending'}
            onClick={() => {
              void controller.command({ operation: 'control', input: { heldByUser: !user } })
            }}
          >
            <Hand size={14} />
            {user ? '交还模型' : state?.control === 'pending' ? '等待接管' : '接管操作'}
          </button>
        )}
      </footer>
      {stopping && (
        <div
          className="software-workspace__confirm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="software-stop-title"
          onKeyDown={(event) => {
            if (event.key !== 'Tab') return
            const buttons = [...event.currentTarget.querySelectorAll('button')]
            const next =
              buttons[
                (buttons.indexOf(document.activeElement as HTMLButtonElement) +
                  (event.shiftKey ? -1 : 1) +
                  buttons.length) %
                  buttons.length
              ]
            event.preventDefault()
            next?.focus()
          }}
        >
          <MonitorOff size={25} />
          <h3 id="software-stop-title">结束这个软件工作区？</h3>
          <p>本对话启动的软件将关闭，未保存的内容会丢失。请先让模型保存文件。</p>
          <div>
            <button type="button" onClick={() => setStopping(false)} autoFocus>
              继续工作
            </button>
            <button
              type="button"
              className="software-workspace__danger"
              onClick={() => {
                setStopping(false)
                void controller.command({ operation: 'close' })
              }}
            >
              结束工作区
            </button>
          </div>
        </div>
      )}
    </aside>
  )
}
