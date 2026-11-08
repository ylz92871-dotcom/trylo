import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { GitFileDiffData } from '../components/code-surface/GitDiffView'
import { DiffRequestTracker, type DiffRequestIdentity } from '../results/diff-request-tracker'

export interface DiffPreviewOptions {
  readonly projectId: string
  readonly projectRoot: string
  readonly conversationId: string | null | undefined
  readonly surface: 'code' | 'work'
  readonly readDiff: (root: string, path: string, oldPath?: string) => Promise<GitFileDiffData>
  /** Retire the plain file preview and show the existing rail before reading. */
  readonly onOpen: () => void
}

export interface DiffPreviewState {
  readonly identity: DiffRequestIdentity
  readonly diff?: GitFileDiffData
  readonly error?: string
}

/** Local reading state only; the host and run supervisor retain their ownership. */
export function useDiffPreview(options: DiffPreviewOptions): {
  readonly state: DiffPreviewState | null
  readonly open: (path: string, oldPath?: string) => void
  readonly close: () => void
} {
  const { projectId, projectRoot, conversationId, surface, readDiff, onOpen } = options
  const trackerRef = useRef<DiffRequestTracker | null>(null)
  if (!trackerRef.current) trackerRef.current = new DiffRequestTracker()
  const tracker = trackerRef.current
  const [state, setState] = useState<DiffPreviewState | null>(null)

  const close = useCallback((): void => {
    tracker.invalidate()
    setState(null)
  }, [tracker])

  const open = useCallback(
    (path: string, oldPath?: string): void => {
      onOpen()
      const identity = tracker.begin(projectRoot, conversationId ?? '', path, oldPath)
      setState({ identity })
      void readDiff(projectRoot, path, oldPath)
        .then((diff) => {
          if (!tracker.isCurrent(identity)) return
          setState({
            identity,
            diff: {
              original: diff.original,
              modified: diff.modified,
              binary: diff.binary,
              truncated: diff.truncated,
            },
          })
        })
        .catch(() => {
          if (!tracker.isCurrent(identity)) return
          setState({ identity, error: 'Could not load the Git diff for this change.' })
        })
    },
    [projectRoot, conversationId, readDiff, onOpen, tracker],
  )

  useLayoutEffect(() => {
    // Code and Work may reuse a conversation id; either navigation retires the view.
    close()
    return () => tracker.invalidate()
  }, [projectId, projectRoot, conversationId, surface, close, tracker])

  return { state, open, close }
}
