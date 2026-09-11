// Trylo Desktop — ToolProfileChip. Answers "which tools does THIS
// conversation see?" in the Work composer action row.
//
// The chip shows the active Tool Profile's short label (办公 / CAD / …).
// Clicking opens a popover with the expected MCP server list + a shortcut
// into Settings (where the profile toggles live). Informational only —
// it never changes anything itself.
//
// The server list is EXPECTED, not live: a missing host application
// degrades to an unavailable capability at resolve time, so the footer
// says so explicitly instead of over-claiming.

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ALWAYS_MOUNTED_SERVER, describeToolProfile } from '../../tooling/profile-display'

export interface ToolProfileChipProps {
  /** Requested profile id (e.g. "work.cad.v1"). Null/unknown falls back
   *  to the surface default display — the chip never renders blank. */
  readonly profileId: string | null | undefined
  /** Opens Settings (the profile toggles live there). Optional — without
   *  it the popover is read-only. */
  readonly onOpenSettings?: () => void
}

export function ToolProfileChip(props: ToolProfileChipProps): ReactElement {
  const display = describeToolProfile(props.profileId)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null
      if (!t) return
      if (triggerRef.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="tool-profile-chip">
      <button
        ref={triggerRef}
        type="button"
        className="tool-profile-chip__trigger"
        title={`工具面：${display.profileId}（点击查看可用工具组）`}
        aria-label={`工具面：${display.profileId}，点击查看可用工具组`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tool-profile-chip__dot" aria-hidden="true" />
        {display.label}
        <span className="tool-profile-chip__count" aria-hidden="true">
          {display.servers.length}组
        </span>
      </button>
      {open ? (
        <div
          ref={panelRef}
          className="tool-profile-chip__panel"
          role="dialog"
          aria-label="当前工具面"
        >
          <p className="tool-profile-chip__profile">{display.profileId}</p>
          <ul className="tool-profile-chip__servers">
            {display.servers.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <p className="tool-profile-chip__foot">
            另有 {ALWAYS_MOUNTED_SERVER} 常驻。缺失的宿主应用会在发送时如实降级。
          </p>
          {props.onOpenSettings ? (
            <button
              type="button"
              className="tool-profile-chip__settings"
              onClick={() => {
                setOpen(false)
                props.onOpenSettings?.()
              }}
            >
              去设置切换
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
