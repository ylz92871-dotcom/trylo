import { useCallback } from 'react'
import { resultDockPrefsStore, type ResultDockKey } from './result-dock-prefs'
import { useResultDockOpen } from './use-result-dock-prefs'

/** Both surfaces use the same scoped selection and existing rail visibility. */
export function useResultReview(
  scope: ResultDockKey,
  railOpen: boolean,
  onRailOpenChange: (open: boolean) => void,
): {
  readonly open: boolean
  readonly select: (open: boolean) => void
  readonly toggle: (open: boolean) => void
} {
  const selected = useResultDockOpen(scope, false)
  const select = useCallback((open: boolean): void => {
    resultDockPrefsStore.setOpen(scope, open)
  }, [scope])
  const toggle = useCallback((open: boolean): void => {
    select(open)
    onRailOpenChange(open)
  }, [select, onRailOpenChange])
  return { open: selected && railOpen, select, toggle }
}
