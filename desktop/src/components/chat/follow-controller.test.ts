// Round-3 scroll-jitter audit: the follow state must disarm on ANY upward
// scroll movement — not just wheel/PageUp. The old boolean let scrollbar
// drags and touch keep it armed, and every streaming delta then yanked the
// view back to the bottom against the user's finger.
import { describe, expect, it } from 'vitest';
import { createFollowController } from './follow-controller';

describe('follow controller', () => {
  it('starts armed and stays armed while the view moves down', () => {
    const follow = createFollowController();
    expect(follow.isFollowing()).toBe(true);
    // Mount: Virtuoso jumps from 0 to the bottom.
    expect(follow.onScroll(800)).toBe(false);
    // Pin scroll chases growing content.
    expect(follow.onScroll(860)).toBe(false);
    // Virtuoso's own compensation when rows mount above also moves down.
    expect(follow.onScroll(1400)).toBe(false);
    expect(follow.isFollowing()).toBe(true);
  });

  it('disarms on upward movement from any input and reports it once', () => {
    const follow = createFollowController();
    follow.onScroll(900);
    // Wheel, scrollbar drag, touch — the signal is the position, not the device.
    expect(follow.onScroll(750)).toBe(true);
    expect(follow.isFollowing()).toBe(false);
    // Continued upward scrolling stays disarmed and stops reporting.
    expect(follow.onScroll(600)).toBe(false);
    expect(follow.onScroll(100)).toBe(false);
  });

  it('never disarms on sub-pixel wobble at fractional zoom', () => {
    const follow = createFollowController();
    follow.onScroll(500.4);
    expect(follow.onScroll(500.1)).toBe(false);
    expect(follow.onScroll(499.7)).toBe(false);
    expect(follow.isFollowing()).toBe(true);
    // A real upward step past the 1px tolerance still disarms.
    expect(follow.onScroll(497)).toBe(true);
  });

  it('rearm re-arms and survives a stale lastTop (pin scroll is downward)', () => {
    const follow = createFollowController();
    follow.onScroll(900);
    follow.onScroll(200); // disarmed at 200
    follow.rearm();
    expect(follow.isFollowing()).toBe(true);
    // The pin's scrollToIndex moves the view DOWN from wherever the user
    // was — it must not instantly disarm again.
    expect(follow.onScroll(1200)).toBe(false);
    expect(follow.isFollowing()).toBe(true);
  });

  it('rearm followed by continued upward movement disarms again', () => {
    const follow = createFollowController();
    follow.onScroll(900);
    follow.onScroll(200);
    follow.rearm();
    // User keeps scrolling up right after a re-arm (e.g. sent from the
    // composer while reading history) — the movement wins.
    expect(follow.onScroll(150)).toBe(true);
    expect(follow.isFollowing()).toBe(false);
  });
});
