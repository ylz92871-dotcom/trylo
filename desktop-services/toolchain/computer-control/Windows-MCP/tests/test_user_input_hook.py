"""Low-level user-input hook: EXACT takeover detection (spec §11.3).

The tick heuristic needs an own-dispatch compensation margin; these tests
pin the LL-hook upgrade that removes it, without touching real Win32 hooks
(user32 is an injected fake; the callback is driven directly):

- a non-Trylo event (key / mouse button / wheel) records as user input at
  the watcher's own monotonic clock; a Trylo-tagged ``dwExtraInfo`` event
  (「不把自身输入当用户抢占」) and third-party noise are discarded;
- the callback never raises and always passes the event down the chain;
- the three-state verdict contract: True/False from hook evidence, None
  (→ tick fallback) when the hook is uninstalled, dead, or stale;
- TryloTakeoverGuard prefers precise evidence and falls back to the tick
  heuristic only when the hook cannot answer;
- lifecycle: idempotent start, safe double stop, install failure degrades
  to an idle thread.
"""

import ctypes
import threading
import time

from windows_mcp.runtime.takeover import (
    TakeoverDetector,
    TakeoverState,
    TryloTakeoverGuard,
    injection_tag,
)
from windows_mcp.runtime.user_input_hook import (
    WH_KEYBOARD_LL,
    WH_MOUSE_LL,
    WM_KEYDOWN,
    WM_LBUTTONDOWN,
    WM_MOUSEMOVE,
    WM_MOUSEWHEEL,
    WM_RBUTTONDOWN,
    UserInputHookWatcher,
    _KBDLLHOOKSTRUCT,
    _MSLLHOOKSTRUCT,
)


class _FakeUser32:
    """The user32 surface the watcher touches.

    ``fire`` is not user32 — the tests drive ``watcher.on_event`` directly
    through the recorded handler, exactly like the winevent tests.
    """

    def __init__(self, *, hook_ok: bool = True) -> None:
        self.handlers: list = []
        self.hooked_ids: list[int] = []
        self.hook_handles: list[int] = []
        self.unhooked: list[int] = []
        self._next_hook = 0x2000
        self.hook_ok = hook_ok

    def SetWindowsHookExW(self, hook_id, handler, hmod, thread_id):
        self.handlers.append(handler)
        self.hooked_ids.append(int(hook_id))
        if not self.hook_ok:
            return 0
        self._next_hook += 1
        self.hook_handles.append(self._next_hook)
        return self._next_hook

    def UnhookWindowsHookEx(self, hook) -> int:
        self.unhooked.append(int(hook))
        return 1

    def PeekMessageW(self, msg, hwnd, msg_min, msg_max, remove) -> int:
        return 0

    def TranslateMessage(self, msg) -> int:
        return 0

    def DispatchMessageW(self, msg) -> int:
        return 0


class _FakeClock:
    """Controllable monotonic seconds."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_physical_escape_is_distinct_from_trylo_injected_escape(monkeypatch):
    clock = _FakeClock()
    watcher = UserInputHookWatcher(user32=_FakeUser32(), clock=clock)
    monkeypatch.setattr(watcher, "_trustworthy", lambda: True)
    anchor = watcher.precise_now()
    from windows_mcp.runtime.takeover import injection_tag
    own = _KBDLLHOOKSTRUCT(vkCode=0x1B, scanCode=1, flags=0, time=0, dwExtraInfo=injection_tag())
    clock.now += 1
    watcher.on_event(0, WM_KEYDOWN, ctypes.addressof(own))
    assert not watcher.escape_since(anchor)
    human = _KBDLLHOOKSTRUCT(vkCode=0x1B, scanCode=1, flags=0, time=0, dwExtraInfo=0)
    watcher.on_event(0, WM_KEYDOWN, ctypes.addressof(human))
    assert watcher.escape_since(anchor)


def _started_watcher(user32: _FakeUser32, clock: _FakeClock) -> UserInputHookWatcher:
    watcher = UserInputHookWatcher(user32=user32, clock=clock)
    watcher.start()
    return watcher


def _frozen_watcher(clock: _FakeClock) -> UserInputHookWatcher:
    """A watcher wired without the hook pump: recorded state is driven
    synchronously by the test (deterministic), while a trivial live thread
    stands in for the hook thread so the liveness gate sees a healthy one.
    Thread-lifecycle behaviour is exercised by the real-thread tests."""
    watcher = UserInputHookWatcher(user32=_FakeUser32(), clock=clock)
    watcher._started.set()
    watcher._thread = threading.Thread(
        target=threading.Event().wait, name="takeover-user-input-hook-fake", daemon=True
    )
    watcher._thread.start()
    watcher._heartbeat = clock()
    return watcher


def _key(extra_info: int = 0) -> int:
    return ctypes.addressof(
        _KBDLLHOOKSTRUCT(vkCode=0x41, scanCode=30, flags=0, time=1, dwExtraInfo=extra_info)
    )


def _mouse(extra_info: int = 0) -> int:
    return ctypes.addressof(
        _MSLLHOOKSTRUCT(mouseData=0, flags=0, time=1, dwExtraInfo=extra_info)
    )


def test_untagged_input_records_and_trylo_tag_is_discarded() -> None:
    clock = _FakeClock()
    user32 = _FakeUser32()
    watcher = _started_watcher(user32, clock)

    watcher.on_event(0, WM_KEYDOWN, _key())
    assert watcher.last_user_input_monotonic() == 1000.0
    assert watcher.last_user_input_kind() == "key"

    # Trylo's own injection (real session tag) must never read as user input.
    clock.now = 1001.0
    watcher.on_event(0, WM_KEYDOWN, _key(injection_tag()))
    assert watcher.last_user_input_monotonic() == 1000.0

    # A mouse button and a wheel tick both record, with their kind.
    clock.now = 1002.0
    watcher.on_event(0, WM_LBUTTONDOWN, _mouse())
    assert (watcher.last_user_input_kind(), watcher.last_user_input_monotonic()) == (
        "mouse_button",
        1002.0,
    )
    clock.now = 1003.0
    watcher.on_event(0, WM_MOUSEWHEEL, _mouse())
    assert watcher.last_user_input_kind() == "wheel"
    watcher.stop()
    watcher.join()


def test_mouse_move_alone_is_not_user_intent() -> None:
    """WM_MOUSEMOVE is unhooked from the kind table: cursor jitter from the
    dispatch's own coordinate moves must not fabricate a takeover."""
    clock = _FakeClock()
    user32 = _FakeUser32()
    watcher = _started_watcher(user32, clock)

    watcher.on_event(0, WM_MOUSEMOVE, _mouse())
    assert watcher.last_user_input_monotonic() is None
    watcher.stop()
    watcher.join()


def test_noise_and_failures_never_raise_never_block_the_chain() -> None:
    clock = _FakeClock()
    user32 = _FakeUser32()
    watcher = _started_watcher(user32, clock)

    # nCode < 0 and NULL lParam are pass-through noise.
    assert watcher.on_event(-1, WM_KEYDOWN, None) == 0
    assert watcher.on_event(0, WM_KEYDOWN, None) == 0
    # A garbage lParam must not raise inside the callback.
    assert watcher.on_event(0, WM_KEYDOWN, 0xDEADBEEF) == 0
    assert watcher.last_user_input_monotonic() is None
    watcher.stop()
    watcher.join()


def test_hook_installation_covers_keyboard_and_mouse() -> None:
    user32 = _FakeUser32()
    watcher = _started_watcher(user32, _FakeClock())
    assert user32.hooked_ids == [WH_KEYBOARD_LL, WH_MOUSE_LL]
    watcher.stop()
    watcher.join()
    assert sorted(user32.unhooked) == sorted(user32.hook_handles)


def test_install_failure_degrades_to_idle_thread() -> None:
    user32 = _FakeUser32(hook_ok=False)
    watcher = _started_watcher(user32, _FakeClock())
    watcher.stop()
    watcher.join(timeout=2.0)
    assert not watcher._thread.is_alive()
    assert user32.unhooked == []
    # No precise evidence: the guard stays on the tick heuristic.
    assert watcher.precise_now() is None
    assert watcher.user_input_since_precise(0.0) is None


def test_precise_verdict_three_state_contract() -> None:
    clock = _FakeClock()
    watcher = _frozen_watcher(clock)

    anchor = watcher.precise_now()
    assert anchor == 1000.0
    # Healthy pump, no event → False (trusted negative).
    assert watcher.user_input_since_precise(anchor) is False

    clock.now = 1005.0
    watcher._heartbeat = clock.now  # refresh as the live pump would
    watcher.on_event(0, WM_RBUTTONDOWN, _mouse())
    assert watcher.user_input_since_precise(anchor) is True

    # Pump heart goes stale → the watcher refuses to answer (None), so the
    # caller can never mistake a dead hook for "no user input".
    clock.now = 1010.0
    assert watcher.pump_alive() is False
    assert watcher.precise_now() is None
    assert watcher.user_input_since_precise(anchor) is None


def test_guard_prefers_precise_evidence_over_tick_margin() -> None:
    clock = _FakeClock()
    watcher = _frozen_watcher(clock)
    ticks = {"now": 10_000, "last_input": 10_000}
    detector = TakeoverDetector(
        tick_now=lambda: ticks["now"],
        last_input_tick=lambda: ticks["last_input"],
        user_input_hook=watcher,
    )
    guard = TryloTakeoverGuard(detector)
    guard.guard_enter_dispatch()
    guard.guard_arm_dispatch()

    # The tick heuristic would scream (bump far beyond the margin) — but no
    # non-Trylo LL event arrived (this bump is Trylo's own dispatch echo).
    # Precise evidence wins: no takeover.
    ticks["last_input"] = ticks["now"] + guard.OWN_DISPATCH_TICK_MARGIN_MS + 100
    assert guard.guard_takeover_check() is None
    assert guard.state is TakeoverState.AGENT_DISPATCHING

    # A real user keystroke arrives → SAFE_RELEASE, no margin delay.
    clock.now = 1002.0
    watcher._heartbeat = clock.now  # refresh as the live pump would
    watcher.on_event(0, WM_KEYDOWN, _key())
    assert guard.guard_takeover_check() is TakeoverState.SAFE_RELEASE


def test_guard_falls_back_to_tick_heuristic_when_hook_stale() -> None:
    clock = _FakeClock()
    watcher = _frozen_watcher(clock)
    ticks = {"last_input": 10_000, "now": 10_000}
    detector = TakeoverDetector(
        tick_now=lambda: ticks["now"],
        last_input_tick=lambda: ticks["last_input"],
        user_input_hook=watcher,
    )
    guard = TryloTakeoverGuard(detector)
    guard.guard_enter_dispatch()
    guard.guard_arm_dispatch()

    # The pump heart goes stale mid-dispatch: the hook must not answer
    # False. The tick heuristic takes over and reports the takeover.
    watcher._heartbeat = clock.now - 5.0
    assert watcher.pump_alive() is False
    ticks["last_input"] = ticks["now"] + guard.OWN_DISPATCH_TICK_MARGIN_MS + 1
    assert guard.guard_takeover_check() is TakeoverState.SAFE_RELEASE


def test_detector_without_hook_keeps_legacy_behaviour() -> None:
    ticks = {"last_input": 10_050, "now": 10_000}
    detector = TakeoverDetector(
        tick_now=lambda: ticks["now"],
        last_input_tick=lambda: ticks["last_input"],
    )
    assert detector.precise_now() is None
    assert detector.user_input_precise_since(0.0) is None
    assert detector.user_input_since(10_000)

    guard = TryloTakeoverGuard(detector)
    guard.guard_enter_dispatch()
    guard.guard_arm_dispatch()
    guard._dispatch_tick = 10_000
    assert guard.guard_takeover_check() is TakeoverState.SAFE_RELEASE


def test_guard_precise_false_beats_tick_in_preparing_and_verifying() -> None:
    """审计钉住（2026-09-10 集中审计）：precise=False 时 tick 启发式在
    全部三相都不参与——不只 DISPATCHING。PREPARING 的自身注入回声与
    VERIFYING 的验证窗读数都不得凭 tick bump 判定接管。"""
    clock = _FakeClock()
    watcher = _frozen_watcher(clock)
    ticks = {"now": 10_000, "last_input": 10_000}
    detector = TakeoverDetector(
        tick_now=lambda: ticks["now"],
        last_input_tick=lambda: ticks["last_input"],
        user_input_hook=watcher,
    )

    # PREPARING: the tick heuristic screams (bump far past phase start) but
    # the hook saw nothing non-Trylo → no CANCELLED.
    ticks["last_input"] = ticks["now"] + 500
    guard = TryloTakeoverGuard(detector)
    guard.guard_enter_dispatch()
    assert guard.guard_takeover_check() is None
    assert guard.state is TakeoverState.AGENT_PREPARING

    # VERIFYING: same scream, hook still says False → no mutating=False flip.
    guard.guard_arm_dispatch()
    guard.guard_enter_verification()
    assert guard.guard_takeover_check() is None
    assert guard.may_dispatch() is False  # still inside the active window…
    guard.guard_exit()
    assert guard.may_dispatch() is True  # …and the right survived VERIFYING


def test_guard_verifying_tick_fallback_uses_legacy_phase_anchor() -> None:
    """Hook died before the VERIFYING check → precise is None → the legacy
    tick semantics apply verbatim (any bump past the phase start reads as
    user takeover). Pinned as the documented fail-open behaviour so a future
    anchor change is a conscious contract decision, not a drift."""
    clock = _FakeClock()
    watcher = _frozen_watcher(clock)
    ticks = {"now": 10_000, "last_input": 10_000}
    detector = TakeoverDetector(
        tick_now=lambda: ticks["now"],
        last_input_tick=lambda: ticks["last_input"],
        user_input_hook=watcher,
    )
    guard = TryloTakeoverGuard(detector)
    guard.guard_enter_dispatch()
    guard.guard_arm_dispatch()
    # Own dispatch bumped the tick; hook then died (stale pump → precise None).
    ticks["last_input"] = ticks["now"] + 16
    watcher._heartbeat = clock.now - 5.0
    guard.guard_enter_verification()
    assert guard.guard_takeover_check() is None  # VERIFYING never transitions…
    assert guard._mutating is False  # …but the legacy read still withdraws


def test_start_is_idempotent_and_stop_is_safe_twice() -> None:
    user32 = _FakeUser32()
    watcher = _started_watcher(user32, _FakeClock())
    watcher.start()  # second start: no second install
    assert user32.hooked_ids == [WH_KEYBOARD_LL, WH_MOUSE_LL]
    assert len(user32.handlers) == 2  # one handler per hook, installed once

    watcher.stop()
    watcher.stop()
    watcher.join(timeout=2.0)
    assert not watcher._thread.is_alive()


def test_real_user_hook_smoke_with_fake_user32_thread_pump() -> None:
    """The full thread path: start → pump heartbeat goes live → stop joins.
    The callback is not fired here (no real input); the point is the
    lifecycle end to end with the pump loop actually running."""
    user32 = _FakeUser32()
    watcher = _started_watcher(user32, None)  # real time.monotonic clock
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and not watcher.pump_alive():
        time.sleep(0.01)
    assert watcher.pump_alive()
    watcher.stop()
    watcher.join(timeout=2.0)
    assert not watcher._thread.is_alive()
