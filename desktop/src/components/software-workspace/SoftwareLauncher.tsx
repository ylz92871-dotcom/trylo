import { useState, type ReactElement } from 'react'
import { AppWindow, ArrowUpRight, Box, X } from 'lucide-react'
import type { SoftwareApplication } from '../../tooling/software-workspace-types'

export function SoftwareLauncher({
  installed,
  onLaunch,
  onClose,
}: {
  readonly installed?: readonly SoftwareApplication[]
  readonly onLaunch: (path: string) => Promise<void>
  readonly onClose: () => void
}): ReactElement {
  const [filter, setFilter] = useState('')
  const [path, setPath] = useState('')
  return (
    <section className="software-workspace__launcher" aria-label="选择软件">
      <div className="software-workspace__launcher-title">
        <strong>在工作区打开</strong>
        <button type="button" aria-label="关闭软件选择" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <input
        aria-label="搜索已安装软件"
        placeholder="搜索已安装的软件"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        autoFocus
      />
      <div className="software-workspace__app-list">
        {installed
          ?.filter((app) => app.name.toLowerCase().includes(filter.toLowerCase()))
          .map((app) => (
            <button
              type="button"
              key={app.path}
              onClick={() => {
                void onLaunch(app.path)
              }}
            >
              <span className="software-workspace__app-icon">
                {app.kind === 'solidworks' ? <Box size={18} /> : <AppWindow size={18} />}
              </span>
              <span>
                <strong>{app.name}</strong>
                <small title={app.path}>{app.path}</small>
              </span>
              <ArrowUpRight size={14} />
            </button>
          ))}
        {installed?.length === 0 && <p>没有发现已注册的软件，可在下方填写可执行文件路径。</p>}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (path.trim()) void onLaunch(path.trim().replace(/^"|"$/g, ''))
        }}
      >
        <label htmlFor="software-executable">其他软件</label>
        <div>
          <input
            id="software-executable"
            placeholder="C:\…\application.exe"
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
          <button type="submit" disabled={!path.trim()}>
            打开
          </button>
        </div>
      </form>
      <p className="software-workspace__hint">
        软件会在后台工作区启动。已在桌面运行的实例保持原样。
      </p>
    </section>
  )
}
