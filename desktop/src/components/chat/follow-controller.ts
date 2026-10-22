/** Geometry complements input intent: browser anchoring can move a reader too. */
export interface FollowMetrics {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

export interface FollowController {
  isFollowing(): boolean
  rearm(): void
  pause(): void
  sync(metrics: FollowMetrics): void
  /** Returns true only when this observation pauses following. */
  observe(metrics: FollowMetrics, userInitiated?: boolean): boolean
}

const WOBBLE_TOLERANCE = 1
export const FOLLOW_TAIL_THRESHOLD = 24

export function createFollowController(): FollowController {
  let following = true
  let last: FollowMetrics | null = null
  return {
    isFollowing: () => following,
    rearm: () => {
      following = true
    },
    pause: () => {
      following = false
    },
    // Our own pin establishes a baseline, never a change in reader intent.
    sync: (metrics) => {
      last = metrics
    },
    observe: (metrics, userInitiated = true) => {
      const prev = last
      last = metrics
      if (!prev) return false
      if (!userInitiated) return false
      if (!following) {
        const distance = metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop
        // A collapsing row bringing the bottom into view does not resume.
        if (
          metrics.scrollTop > prev.scrollTop + WOBBLE_TOLERANCE &&
          distance <= FOLLOW_TAIL_THRESHOLD
        )
          following = true
        return false
      }
      const movedUp = prev.scrollTop - metrics.scrollTop
      const lostHeight = Math.max(0, prev.scrollHeight - metrics.scrollHeight)
      const gainedViewport = Math.max(0, metrics.clientHeight - prev.clientHeight)
      // Scroll anchoring compensates for collapsed rows above the viewport.
      if (movedUp - lostHeight - gainedViewport <= WOBBLE_TOLERANCE) return false
      following = false
      return true
    },
  }
}

/** History readers can return during a live run or after it finishes. */
export function shouldShowFollowPill(input: {
  readonly running: boolean
  readonly atBottom: boolean
  readonly following: boolean
  readonly messageCount: number
}): boolean {
  return input.messageCount > 0 && !input.atBottom && !input.following
}

/** Completion preserves a reader who deliberately left the tail. */
export function shouldForceTailPin(
  prevRunning: boolean,
  running: boolean,
  following: boolean,
): boolean {
  return prevRunning && !running && following
}
