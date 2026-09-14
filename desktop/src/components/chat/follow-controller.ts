// Trylo Desktop — follow-mode state machine for the conversation timeline.
//
// "Follow" means: the user wants to watch the tail, so every streaming delta
// re-pins the list to the bottom (MessageList's items effect). The previous
// implementation disarmed ONLY on wheel-up / PageUp / ArrowUp — a scrollbar
// drag, touch scroll or Home key left it armed, and every streaming delta
// then yanked the view back down. The user scrolling up against that pull
// was the violent "上滑抖动" during workflow runs.
//
// Disarming now keys off the SCROLLER's own scroll position: any upward
// movement of scrollTop, from any input method, stops the following.
// Downward movement (the user chasing the tail, Virtuoso's own compensation
// when rows mount above, and our pin scrolls) never disarms.
//
// The 1px tolerance absorbs the sub-pixel scrollTop wobble Windows reports
// at fractional zoom levels.

export interface FollowController {
  isFollowing(): boolean;
  /** Re-arm following. Explicit signals only: sending a message (the new
   *  turn is the user's) and clicking the follow-tail pill. */
  rearm(): void;
  /** Feed every scroller scroll position. Returns true when THIS call
   *  disarmed the follow (the view moved up). */
  onScroll(scrollTop: number): boolean;
}

export function createFollowController(): FollowController {
  let following = true;
  let lastTop = 0;
  return {
    isFollowing: () => following,
    rearm: () => {
      following = true;
    },
    onScroll: (top) => {
      const prev = lastTop;
      lastTop = top;
      if (following && top < prev - 1) {
        following = false;
        return true;
      }
      return false;
    },
  };
}
