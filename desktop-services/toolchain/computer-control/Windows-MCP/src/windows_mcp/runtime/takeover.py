"""User-takeover primitives and takeover state machine (spec §11.3 / DoD-7).

The takeover protocol answers one question with hard evidence: WHO is
driving the desktop right now — the agent, or the user?

Three primitives, all injectable for deterministic tests:

``injection_tag()`` / ``tag_matches()``
    Every Trylo-injected input event carries this value in its Win32
    ``dwExtraInfo`` field. A low-level hook (or any future reader of
    ``GetMessageExtraInfo``) can therefore tell Trylo's own synthetic input
    apart from real user input — the spec's「不把自身输入当用户抢占」
    requirement. The tag encodes a fixed TRYLO magic word in the high 16
    bits and a random per-session value in the low 16 bits: matching on the
    high word is stable, the low bits keep sessions distinguishable.

``TakeoverDetector``
    ``GetLastInputInfo``-backed user-input detector. Real user input
    (keyboard, mouse, HID) bumps the OS last-input tick; so does Trylo's own
    SendInput, which is why the guard snapshots a pre-dispatch tick and
    filters its OWN injections with a compensation margin instead of
    treating every tick change as a user event.

``TryloTakeoverGuard``
    The §11.3 state machine, one instance per Desktop actor service:

    .. code-block:: text

        IDLE
        → AGENT_PREPARING        (guard_enter_dispatch before resolve/plan)
        → AGENT_DISPATCHING      (guard_arm_dispatch right before injection)
        → VERIFYING              (guard_enter_verification, read-only)
        → IDLE                   (guard_exit — no takeover, effect verified)

    A non-Trylo user input during a phase transitions:

    - ``AGENT_PREPARING``  → ``CANCELLED``      (nothing was sent)
    - ``AGENT_DISPATCHING`` → ``SAFE_RELEASE``  (caller releases held
      buttons/keys via ``safe_release_input``) → ``YIELDED``
    - ``VERIFYING``        → stays ``VERIFYING`` but ``mutating=False``:
      read-only verification may finish; further mutations are refused
      until ``guard_reset`` opens the NEXT explicit dispatch window.

    The machine is synchronous and pure with respect to its injected
    detector; the Desktop actor calls it inline. It never waits, sleeps, or
    dispatches anything itself.
"""

from __future__ import annotations

import hashlib
import secrets
import threading
from enum import StrEnum
from typing import Callable


class TakeoverState(StrEnum):
    """The §11.3 takeover states."""

    IDLE = "idle"
    AGENT_PREPARING = "agent_preparing"
    AGENT_DISPATCHING = "agent_dispatching"
    VERIFYING = "verifying"
    CANCELLED = "cancelled"
    SAFE_RELEASE = "safe_release"
    YIELDED = "yielded"


def injection_tag() -> int:
    """Build this session's ``dwExtraInfo`` marker.

    High 16 bits: fixed TRYLO magic (sha256 of a fixed label, truncated).
    Low 16 bits: random per-session value. ``tag_matches`` compares only the
    magic word so the check survives session rotation.
    """
    magic = int.from_bytes(hashlib.sha256(b"trylo-injection-tag-v1").digest()[:2], "big")
    session = secrets.randbits(16)
    return ((magic & 0xFFFF) << 16) | session


_MAGIC_WORD = injection_tag() >> 16


def tag_matches(tag_value: int) -> bool:
    """True when ``tag_value`` carries the Trylo magic word (any session)."""
    return (int(tag_value) >> 16) == _MAGIC_WORD


def _win32_last_input_tick() -> int:
    """Read ``GetLastInputInfo`` (user32). Returns the raw tick in ms."""
    import ctypes

    class LASTINPUTINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", ctypes.c_uint),
            ("dwTime", ctypes.c_uint),
        ]

    info = LASTINPUTINFO()
    info.cbSize = ctypes.sizeof(LASTINPUTINFO)
    if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
        return 0
    return int(info.dwTime)


def _win32_tick_now() -> int:
    import ctypes

    return int(ctypes.windll.kernel32.GetTickCount())


class TakeoverDetector:
    """``GetLastInputInfo``-backed user-input detector.

    ``user_input_since(ts)`` is True when the OS last-input tick is strictly
    newer than ``ts``. Both the tick source and the now-source are injectable
    so tests can replay exact takeover sequences without a desktop.

    ``user_input_hook`` (WCC §11.3 精确检测): an optional
    ``UserInputHookWatcher`` whose LL-hook evidence replaces the tick
    heuristic where it is trustworthy. The heuristic stays as the fallback
    (hook install failed / pump dead → fail-open), and callers that never
    inject a hook see exactly the legacy behaviour.
    """

    def __init__(
        self,
        *,
        tick_now: Callable[[], int] = _win32_tick_now,
        last_input_tick: Callable[[], int] = _win32_last_input_tick,
        user_input_hook=None,
    ) -> None:
        self._tick_now = tick_now
        self._last_input_tick = last_input_tick
        self._user_input_hook = user_input_hook

    def tick_now(self) -> int:
        return self._tick_now()

    def user_input_since(self, since_tick: int) -> bool:
        return self._last_input_tick() > since_tick

    # ── precise LL-hook evidence (three-state; None = unavailable) ───────
    def precise_now(self) -> float | None:
        """Monotonic now anchored to the hook's own clock, or None when the
        hook is not delivering. TryloTakeoverGuard anchors each takeover
        window with this instead of the tick when present."""
        hook = self._user_input_hook
        if hook is None:
            return None
        return hook.precise_now()

    def user_input_precise_since(self, since_monotonic: float | None) -> bool | None:
        """True/False from hook evidence, None → caller falls back to the
        tick heuristic (never fail-closed on hook loss)."""
        hook = self._user_input_hook
        if hook is None:
            return None
        return hook.user_input_since_precise(since_monotonic)


class TakeoverTransitionError(RuntimeError):
    """Illegal state-machine transition — an integration bug, never a
    user-facing condition."""


class TakeoverRefused(RuntimeError):
    """A mutation was refused because the user has taken over and the
    conversation has not re-armed a fresh dispatch window."""


class TryloTakeoverGuard:
    """The §11.3 state machine.

    The guard never injects input and never releases keys itself — a
    takeover during ``AGENT_DISPATCHING`` reports ``SAFE_RELEASE`` and the
    CALLER (the Desktop, which owns ``safe_release_input``) runs the release,
    then confirms with ``guard_yield_release_done``. All transitions are
    thread-safe (the actor serializes them, but tool threads may query state
    concurrently).

    Takeover detection windows:

    - ``guard_arm_dispatch`` snapshots the OS last-input tick BEFORE the
      injection. ``guard_takeover_check`` afterwards reports a takeover only
      when the tick moved beyond ``snapshot + OWN_DISPATCH_TICK_MARGIN_MS`` —
      Trylo's own SendInput bumps the tick, so a naive "tick changed ⇒ user
      typed" would flag every mutation. ``GetTickCount`` granularity is
      10–16 ms; the margin covers the bump the dispatch's own events produce.
    - ``AGENT_PREPARING`` / ``VERIFYING`` compare against the phase-start
      tick recorded at ``guard_enter_dispatch``; no Trylo input happens in
      those phases, so every tick bump there is a genuine user event.
    """

    #: GetTickCount granularity is 10–16 ms; allow a margin for the tick
    #: bump the dispatch's own events produce.
    OWN_DISPATCH_TICK_MARGIN_MS = 24

    def __init__(
        self,
        detector: TakeoverDetector | None = None,
        *,
        own_dispatch_margin_ms: int = OWN_DISPATCH_TICK_MARGIN_MS,
    ) -> None:
        self._detector = detector or TakeoverDetector()
        self._margin = max(0, own_dispatch_margin_ms)
        self._lock = threading.Lock()
        self._state = TakeoverState.IDLE
        self._mutating = True
        self._dispatch_tick: int | None = None
        self._phase_started_tick: int | None = None
        # Precise LL-hook anchors (None ⇒ the tick heuristic owns the phase).
        self._dispatch_precise: float | None = None
        self._phase_started_precise: float | None = None

    # ── queries ──────────────────────────────────────────────────────────
    @property
    def state(self) -> TakeoverState:
        with self._lock:
            return self._state

    def may_dispatch(self) -> bool:
        with self._lock:
            return self._mutating and self._state is TakeoverState.IDLE

    # ── transitions ──────────────────────────────────────────────────────
    def guard_enter_dispatch(self) -> TakeoverState:
        """IDLE → AGENT_PREPARING. Refuses when a user takeover already
        ended the previous window (a terminal takeover state is recorded
        until ``guard_reset``)."""
        with self._lock:
            if not self._mutating or self._state in {
                TakeoverState.YIELDED,
                TakeoverState.CANCELLED,
            }:
                raise TakeoverRefused(
                    "user takeover active; the next mutation needs a fresh "
                    "approved dispatch window (host-side re-arm)"
                )
            self._phase_started_tick = self._detector.tick_now()
            self._phase_started_precise = self._detector.precise_now()
            self._dispatch_tick = None
            self._dispatch_precise = None
            self._state = TakeoverState.AGENT_PREPARING
            return self._state

    def guard_arm_dispatch(self) -> TakeoverState:
        """AGENT_PREPARING → AGENT_DISPATCHING and snapshot the input tick.
        Only legal immediately before the injection; the snapshot is what
        filters Trylo's own tick bump out of the post-dispatch check."""
        with self._lock:
            if self._state is not TakeoverState.AGENT_PREPARING:
                raise TakeoverTransitionError(
                    f"arm_dispatch requires agent_preparing, got {self._state.value}"
                )
            self._dispatch_tick = self._detector.tick_now()
            self._dispatch_precise = self._detector.precise_now()
            self._state = TakeoverState.AGENT_DISPATCHING
            return self._state

    def guard_enter_verification(self) -> TakeoverState:
        """AGENT_DISPATCHING → VERIFYING (post-dispatch observation window)."""
        with self._lock:
            if self._state is not TakeoverState.AGENT_DISPATCHING:
                raise TakeoverTransitionError(
                    f"verification requires agent_dispatching, got {self._state.value}"
                )
            self._state = TakeoverState.VERIFYING
            return self._state

    def guard_takeover_check(self) -> TakeoverState | None:
        """Detect a user takeover in the CURRENT phase.

        Returns the (possibly new) state, or None when no takeover fired.
        Called by the Desktop after dispatch and during verification.

        Evidence order (WCC 精确接管检测): a trustworthy LL hook answers
        first — a non-Trylo input event is a user event by hard evidence,
        no margin needed. Only when the hook is unavailable (not installed,
        install failed, pump dead) does the tick heuristic decide, with the
        own-dispatch compensation margin. Never fail-closed.
        """
        with self._lock:
            if self._state is TakeoverState.AGENT_DISPATCHING:
                precise = self._detector.user_input_precise_since(
                    self._dispatch_precise
                )
                if precise is True:
                    # Real user input landed inside the dispatch window.
                    # Control goes back to the user; the CALLER must run
                    # safe_release_input() and confirm with
                    # guard_yield_release_done().
                    self._state = TakeoverState.SAFE_RELEASE
                    return self._state
                if precise is None:
                    tick = self._dispatch_tick
                    if tick is not None and self._detector.user_input_since(
                        tick + self._margin
                    ):
                        self._state = TakeoverState.SAFE_RELEASE
                        return self._state
                return None
            if self._state is TakeoverState.AGENT_PREPARING:
                precise = self._detector.user_input_precise_since(
                    self._phase_started_precise
                )
                if precise is True:
                    self._state = TakeoverState.CANCELLED
                    return self._state
                if precise is None:
                    started = self._phase_started_tick
                    if started is not None and self._detector.user_input_since(started):
                        self._state = TakeoverState.CANCELLED
                        return self._state
                return None
            if self._state is TakeoverState.VERIFYING:
                precise = self._detector.user_input_precise_since(
                    self._phase_started_precise
                )
                if precise is True or (
                    precise is None
                    and self._phase_started_tick is not None
                    and self._detector.user_input_since(self._phase_started_tick)
                ):
                    # Verification is read-only and may finish, but the
                    # mutation right is gone for this dispatch window.
                    self._mutating = False
                return None
            return None

    def guard_exit(self) -> TakeoverState:
        """Active phase → IDLE when NO takeover fired. A window that ended
        in a takeover terminal (SAFE_RELEASE/YIELDED) refuses this — only
        ``guard_reset`` (host-side re-arm) leaves those."""
        with self._lock:
            if self._state not in {
                TakeoverState.VERIFYING,
                TakeoverState.AGENT_DISPATCHING,
                TakeoverState.AGENT_PREPARING,
                TakeoverState.IDLE,
            }:
                raise TakeoverTransitionError(
                    f"exit requires an active phase, got {self._state.value}"
                )
            self._state = TakeoverState.IDLE
            self._mutating = True
            self._dispatch_tick = None
            self._phase_started_tick = None
            self._dispatch_precise = None
            self._phase_started_precise = None
            return self._state

    def guard_yield_release_done(self) -> TakeoverState:
        """SAFE_RELEASE → YIELDED, called by the Desktop after it released
        every held button/key."""
        with self._lock:
            if self._state is not TakeoverState.SAFE_RELEASE:
                raise TakeoverTransitionError(
                    f"yield requires safe_release, got {self._state.value}"
                )
            self._state = TakeoverState.YIELDED
            return self._state

    def guard_cancel_by_user(self) -> TakeoverState:
        """Explicit stop intent, consumed through the existing re-arm policy."""
        with self._lock:
            self._state = TakeoverState.CANCELLED
            self._mutating = False
            return self._state

    def guard_reset(self) -> TakeoverState:
        """YIELDED/CANCELLED/VERIFYING-terminal → IDLE with a fresh mutation
        right. The MODEL cannot call this through a tool: the next dispatch
        window opens only through the host's existing approval flow (the
        classifier is still the gate); this method exists for the host-side
        re-arm after such an approval."""
        with self._lock:
            self._state = TakeoverState.IDLE
            self._mutating = True
            self._dispatch_tick = None
            self._phase_started_tick = None
            self._dispatch_precise = None
            self._phase_started_precise = None
            return self._state
