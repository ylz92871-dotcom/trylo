// Round-3 scroll-jitter audit: the follow state must disarm on ANY upward
// scroll movement — not just wheel/PageUp. The old boolean let scrollbar
// drags and touch keep it armed, and every streaming delta then yanked the
// view back to the bottom against the user's finger.
//
// Round-3 P1-6: "any upward movement" was too blunt. Rows ABOVE the tail
// shrink all through a live run (a finished reasoning phase auto-collapses
// 420ms after going inactive; completed tool rows drop out of the visible
// entries), and the browser compensates by moving scrollTop up by exactly
// the height that vanished. That looks identical to the user scrolling up —
// so follow died on its own and nothing re-pinned until the pill was clicked.
// The controller now receives the geometry it needs to tell the two apart.
import { describe, expect, it } from 'vitest';
import { createFollowController, type FollowMetrics } from './follow-controller';

/** Fixed-geometry view: only scrollTop moves unless a case says otherwise. */
function at(scrollTop: number, scrollHeight = 4000, clientHeight = 600): FollowMetrics {
  return { scrollTop, scrollHeight, clientHeight };
}

describe('follow controller', () => {
  it('starts armed and stays armed while the view moves down', () => {
    const follow = createFollowController();
    expect(follow.isFollowing()).toBe(true);
    // Mount: Virtuoso jumps from 0 to the bottom.
    expect(follow.observe(at(800))).toBe(false);
    // Pin scroll chases growing content.
    expect(follow.observe(at(860))).toBe(false);
    // Virtuoso's own compensation when rows mount above also moves down.
    expect(follow.observe(at(1400))).toBe(false);
    expect(follow.isFollowing()).toBe(true);
  });

  it('disarms on upward movement from any input and reports it once', () => {
    const follow = createFollowController();
    follow.observe(at(900));
    // Wheel, scrollbar drag, touch — the signal is the position, not the device.
    expect(follow.observe(at(750))).toBe(true);
    expect(follow.isFollowing()).toBe(false);
    // Continued upward scrolling stays disarmed and stops reporting.
    expect(follow.observe(at(600))).toBe(false);
    expect(follow.observe(at(100))).toBe(false);
  });

  it('never disarms on sub-pixel wobble at fractional zoom', () => {
    const follow = createFollowController();
    follow.observe(at(500.4));
    expect(follow.observe(at(500.1))).toBe(false);
    expect(follow.observe(at(499.7))).toBe(false);
    expect(follow.isFollowing()).toBe(true);
    // A real upward step past the 1px tolerance still disarms.
    expect(follow.observe(at(497))).toBe(true);
  });

  it('rearm re-arms and survives a stale lastTop (pin scroll is downward)', () => {
    const follow = createFollowController();
    follow.observe(at(900));
    follow.observe(at(200)); // disarmed at 200
    follow.rearm();
    expect(follow.isFollowing()).toBe(true);
    // The pin's scrollToIndex moves the view DOWN from wherever the user
    // was — it must not instantly disarm again.
    expect(follow.observe(at(1200))).toBe(false);
    expect(follow.isFollowing()).toBe(true);
  });

  it('rearm followed by continued upward movement disarms again', () => {
    const follow = createFollowController();
    follow.observe(at(900));
    follow.observe(at(200));
    follow.rearm();
    // User keeps scrolling up right after a re-arm (e.g. sent from the
    // composer while reading history) — the movement wins.
    expect(follow.observe(at(150))).toBe(true);
    expect(follow.isFollowing()).toBe(false);
  });

  // ── Round-3 P1-6 ─────────────────────────────────────────────────────
  // A long Code run, tail pinned, no user input at all.

  it('stays armed while content grows inside the viewport (streaming text)', () => {
    const follow = createFollowController();
    follow.observe(at(3400, 4000));
    // The streaming block grows below: scrollHeight rises, the browser does
    // NOT move scrollTop, and our pin then pushes it further down.
    expect(follow.observe(at(3400, 4180))).toBe(false);
    expect(follow.observe(at(3580, 4180))).toBe(false);
    expect(follow.observe(at(3580, 4360))).toBe(false);
    expect(follow.isFollowing()).toBe(true);
  });

  it('does NOT disarm when a row above collapsing explains the upward move', () => {
    const follow = createFollowController();
    // Tail pinned: 3400 + 600 = 4000.
    follow.observe(at(3400, 4000));
    // A reasoning phase finishes and auto-collapses 420ms later, dropping its
    // completed tool rows: 800px of content above the viewport disappears and
    // scroll anchoring moves scrollTop up by exactly those 800px. This is the
    // browser doing its job — the user never touched anything.
    expect(follow.observe(at(2600, 3200))).toBe(false);
    expect(follow.isFollowing()).toBe(true);
    // ...and the run keeps streaming afterwards, so the view must still be
    // re-pinned by the items effect.
    expect(follow.observe(at(2600, 3400))).toBe(false);
    expect(follow.isFollowing()).toBe(true);
  });

  it('disarms when the upward move is bigger than the height that vanished', () => {
    const follow = createFollowController();
    follow.observe(at(3400, 4000));
    // 800px collapsed above, but the view moved up 1200px: 400px of that is
    // the user leaving the tail.
    expect(follow.observe(at(2200, 3200))).toBe(true);
    expect(follow.isFollowing()).toBe(false);
  });

  it('disarms on a user scroll up that happens while content is still growing', () => {
    const follow = createFollowController();
    follow.observe(at(3400, 4000));
    // Wheel-up 200px mid-stream. Content growth below never moves scrollTop,
    // so this upward step is entirely the user's.
    expect(follow.observe(at(3200, 4180))).toBe(true);
    expect(follow.isFollowing()).toBe(false);
  });

  it('resumes when the reader scrolls back to the tail, but not before', () => {
    const follow = createFollowController();
    follow.sync(at(3400));
    follow.observe(at(2200));
    follow.observe(at(3100));
    expect(follow.isFollowing()).toBe(false);
    follow.observe(at(3390));
    expect(follow.isFollowing()).toBe(true);
  });

  it('does not resume just because a collapsing row brings the tail closer', () => {
    const follow = createFollowController();
    follow.sync(at(3400));
    follow.observe(at(2400));
    follow.observe(at(2400, 3000));
    expect(follow.isFollowing()).toBe(false);
  });

  it('honors upward intent before a queued streaming pin can execute', () => {
    const follow = createFollowController();
    follow.sync(at(3400));
    follow.pause();
    expect(follow.isFollowing()).toBe(false);
    follow.observe(at(3300, 4200));
    expect(follow.isFollowing()).toBe(false);
  });

  it('preserves follow when a larger viewport clamps the scroll position upward', () => {
    const follow = createFollowController();
    follow.sync(at(3400, 4000, 600));
    follow.observe(at(3200, 4000, 800));
    expect(follow.isFollowing()).toBe(true);
  });

  it('ignores virtualizer compensation even when the total height stays unchanged', () => {
    const follow = createFollowController();
    follow.sync(at(2739, 3471, 732));
    follow.observe(at(2719, 3471, 732), false);
    expect(follow.isFollowing()).toBe(true);
  });
});
