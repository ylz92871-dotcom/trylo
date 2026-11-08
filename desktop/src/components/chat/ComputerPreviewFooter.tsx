import { useId, useState, type ReactElement } from 'react'
import { ChevronDown } from 'lucide-react'
import { PreviewActions } from './PreviewActions'
import type { PreviewAction } from '../../tooling/tool-preview-state'

export function ComputerPreviewFooter({
  toolbar,
  actions,
}: {
  readonly toolbar: ReactElement
  readonly actions: readonly PreviewAction[]
}): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const panelId = useId()

  return (
    <footer className="computer-preview-window__history">
      <div className="computer-preview-window__controls">
        <button
          type="button"
          className="computer-preview-window__history-toggle"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((value) => !value)}
        >
          <span>最近操作 · {actions.length}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
        {toolbar}
      </div>
      {expanded && (
        <div id={panelId} className="computer-preview-window__history-panel">
          {actions.length ? <PreviewActions actions={actions} /> : <p>还没有更早的操作</p>}
        </div>
      )}
    </footer>
  )
}
