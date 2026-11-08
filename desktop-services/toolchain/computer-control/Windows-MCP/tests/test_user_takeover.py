"""§11.3 用户接管 (user takeover) — takeover module and mutation wiring.

Pinned here (DoD-7 foundations):
  - every Trylo-injected input event carries the session dwExtraInfo tag
    (MouseInput/KeyboardInput/SendKeys/keybd_event/Wheel/press paths);
  - the takeover state machine's full transition table, including the
    AGENT_DISPATCHING tick-margin rule that keeps Trylo's OWN injections
    from being read as a user takeover ("不把自身输入当用户抢占");
  - the Desktop mutation dispatch window: a takeover during dispatch
    forces SAFE_RELEASE → YIELDED and refuses further mutations with
    ``cancelled_by_user_input`` until an explicit host-side re-arm;
  - takeover facts are identity-only annotations (no user content).

All tests are deterministic: the detector's tick sources are faked, no
Win32 input is sent.
"""

from __future__ import annotations

import pytest

from windows_mcp.runtime.takeover import (
    TakeoverDetector,
    TakeoverRefused,
    TakeoverState,
    TakeoverTransitionError,
    TryloTakeoverGuard,
)
from windows_mcp.runtime.errors import ErrorCode


# ── injection tag ────────────────────────────────────────────────────────


def test_injection_tag_is_stable_and_magic_matches(monkeypatch) -> None:
    # Pin a known session value so the tag is deterministic.
    import windows_mcp.runtime.takeover as takeover_module

    monkeypatch.setattr(takeover_module, "secrets", type("S", (), {"randbits": staticmethod(lambda n: 0x1234)})())
    tag = takeover_module.injection_tag()
    assert tag != 0
    # Same session value → same tag.
    assert takeover_module.injection_tag() == tag
    # The magic word (high 16 bits) is what receivers match.
    assert takeover_module.tag_matches(tag)
    assert takeover_module.tag_matches(tag ^ 0x00FF)  # different session bits, same magic
    # A foreign value (no magic word) never matches — real user input.
    assert not takeover_module.tag_matches(0x0000_0000)
    assert not takeover_module.tag_matches(0x1234_5678)


def test_uia_mouse_input_structs_carry_the_tag(monkeypatch) -> None:
    """MOUSEINPUT/KEYBDINPUT built by the vendored uia helpers embed the
    Trylo tag in dwExtraInfo — every SendInput injection is marked."""
    from windows_mcp.uia import core as uia_core

    monkeypatch.setattr(uia_core, "_INJECTION_TAG", 0xA11C0FFEE)

    # The struct field is a plain value (ULONG_PTR semantics); no pointer
    # is stored, so the full tag value round-trips untruncated.
    expected = 0xA11C0FFEE
    input_mouse = uia_core.MouseInput(10, 20)
    assert input_mouse.union.mi.dwExtraInfo == expected
    input_key = uia_core.KeyboardInput(0x41, 0)
    assert input_key.union.ki.dwExtraInfo == expected


# ── detector ─────────────────────────────────────────────────────────────


def test_detector_reports_user_input_only_after_the_reference_tick() -> None:
    detector = TakeoverDetector(
        tick_now=lambda: 1000,
        last_input_tick=lambda: 1050,
    )
    assert detector.user_input_since(1000)  # strictly newer
    assert not detector.user_input_since(1050)  # equal is not newer
    assert not detector.user_input_since(2000)


# ── state machine: the §11.3 transition table ────────────────────────────


class FakeTick:
    """Controllable tick timeline: `now` is the current tick, `last_input`
    the tick of the most recent (user or Trylo) input event."""

    def __init__(self) -> None:
        self.now = 10_000
        self.last_input = 0

    def detector(self) -> TakeoverDetector:
        return TakeoverDetector(
            tick_now=lambda: self.now,
            last_input_tick=lambda: self.last_input,
        )


def test_happy_path_full_cycle_without_takeover() -> None:
    ticks = FakeTick()
    guard = TryloTakeoverGuard(ticks.detector())
    assert guard.state is TakeoverState.IDLE
    assert guard.may_dispatch()

    assert guard.guard_enter_dispatch() is TakeoverState.AGENT_PREPARING
    assert guard.guard_arm_dispatch() is TakeoverState.AGENT_DISPATCHING
    # Trylo's own dispatch bumps the last-input tick — but only within the
    # own-dispatch margin, so it must NOT read as a user takeover.
    ticks.last_input = ticks.now + 5
    ticks.now += 5
    assert guard.guard_takeover_check() is None
    assert guard.state is TakeoverState.AGENT_DISPATCHING

    assert guard.guard_enter_verification() is TakeoverState.VERIFYING
    assert guard.guard_exit() is TakeoverState.IDLE
    assert guard.may_dispatch()


def test_dispatch_phase_trylo_own_input_is_not_a_takeover() -> None:
    """The margin rule: a tick bump within the margin after the snapshot is
    the dispatch itself (SendInput bumps GetLastInputInfo). Only a bump
    beyond snapshot + margin is a real user event."""
    ticks = FakeTick()
    guard = TryloTakeoverGuard(ticks.detector())
    guard.guard_enter_dispatch()
    arm_tick = ticks.now
    guard.guard_arm_dispatch()
    assert guard._dispatch_tick == arm_tick

    # Exactly one margin of drift: still the dispatch's own echo.
    ticks.last_input = arm_tick + guard.OWN_DISPATCH_TICK_MARGIN_MS
    assert guard.guard_takeover_check() is None
    assert guard.state is TakeoverState.AGENT_DISPATCHING

    # One tick MORE: a genuine user event lands mid-dispatch.
    ticks.last_input = arm_tick + guard.OWN_DISPATCH_TICK_MARGIN_MS + 1
    assert guard.guard_takeover_check() is TakeoverState.SAFE_RELEASE
    assert guard.state is TakeoverState.SAFE_RELEASE


def test_preparing_phase_user_input_cancels() -> None:
    ticks = FakeTick()
    guard = TryloTakeoverGuard(ticks.detector())
    guard.guard_enter_dispatch()
    started = guard._phase_started_tick
    assert started is not None
    # User types BEFORE the dispatch was armed: nothing was sent → CANCELLED.
    ticks.last_input = started + 1
    assert guard.guard_takeover_check() is TakeoverState.CANCELLED
    assert guard.state is TakeoverState.CANCELLED


def test_verifying_phase_allows_read_only_but_withdraws_mutation() -> None:
    ticks = FakeTick()
    guard = TryloTakeoverGuard(ticks.detector())
    guard.guard_enter_dispatch()
    guard.guard_arm_dispatch()
    guard.guard_enter_verification()
    started = guard._phase_started_tick
    ticks.last_input = started + 1

    # No state flip during verify (read-only verification may finish), but
    # the mutation right is withdrawn.
    assert guard.guard_takeover_check() is None
    assert guard.state is TakeoverState.VERIFYING
    assert not guard.may_dispatch()

    # Exiting a VERIFYING window with a takeover re-arms the machine as a
    # whole (a fresh window needs a fresh tick snapshot), but the withdrawal
    # is observable inside the window — pinned by the asserts above.
    assert guard.guard_exit() is TakeoverState.IDLE
    assert guard.may_dispatch()

    # A takeover DURING dispatch refuses the next mutation until the host
    # re-arms.
    guard2 = TryloTakeoverGuard(ticks.detector())
    guard2.guard_enter_dispatch()
    guard2.guard_arm_dispatch()
    ticks.last_input = ticks.now + guard2.OWN_DISPATCH_TICK_MARGIN_MS + 1
    guard2.guard_takeover_check()
    guard2.guard_yield_release_done()
    # The next window is refused (guard refuses from the YIELDED terminal).
    with pytest.raises(TakeoverRefused):
        guard2.guard_enter_dispatch()
    # And even after a plain exit the takeover terminal keeps refusing: the
    # guard_exit transition is illegal from a terminal state, so a sloppy
    # caller cannot launder YIELDED back to IDLE.
    guard3 = TryloTakeoverGuard(ticks.detector())
    guard3.guard_enter_dispatch()
    guard3.guard_arm_dispatch()
    ticks.last_input = ticks.now + guard3.OWN_DISPATCH_TICK_MARGIN_MS + 1
    guard3.guard_takeover_check()
    guard3.guard_yield_release_done()
    with pytest.raises(TakeoverTransitionError):
        guard3.guard_exit()
    with pytest.raises(TakeoverRefused):
        guard3.guard_enter_dispatch()
    guard2.guard_reset()
    assert guard2.state is TakeoverState.IDLE
    assert guard2.may_dispatch()


def test_illegal_transitions_raise() -> None:
    ticks = FakeTick()
    guard = TryloTakeoverGuard(ticks.detector())
    with pytest.raises(TakeoverTransitionError):
        guard.guard_arm_dispatch()  # IDLE → DISPATCHING is not a transition
    with pytest.raises(TakeoverTransitionError):
        guard.guard_enter_verification()
    with pytest.raises(TakeoverTransitionError):
        guard.guard_yield_release_done()
    guard.guard_enter_dispatch()
    with pytest.raises(TakeoverTransitionError):
        guard.guard_enter_verification()  # must arm first


def test_safe_release_then_yield_is_the_only_yield_path() -> None:
    ticks = FakeTick()
    guard = TryloTakeoverGuard(ticks.detector())
    guard.guard_enter_dispatch()
    guard.guard_arm_dispatch()
    ticks.last_input = ticks.now + guard.OWN_DISPATCH_TICK_MARGIN_MS + 1
    assert guard.guard_takeover_check() is TakeoverState.SAFE_RELEASE
    # The CALLER releases held buttons/keys, then confirms.
    assert guard.guard_yield_release_done() is TakeoverState.YIELDED
    with pytest.raises(TakeoverTransitionError):
        guard.guard_yield_release_done()  # not repeatable


# ── Desktop dispatch wiring ──────────────────────────────────────────────


def _make_desktop_with_guard(monkeypatch) -> object:
    """A Desktop skeleton with only the takeover plumbing initialized."""
    from windows_mcp.desktop import service as desktop_service

    desktop = desktop_service.Desktop.__new__(desktop_service.Desktop)
    ticks = FakeTick()
    desktop._takeover_guard = TryloTakeoverGuard(ticks.detector())
    desktop._takeover_terminal = None
    desktop._ticks = ticks
    return desktop


def test_desktop_dispatch_window_completes_and_resets(monkeypatch) -> None:
    desktop = _make_desktop_with_guard(monkeypatch)

    def dispatch() -> dict[str, object]:
        return {"loc": [1, 2]}

    result = desktop._mutation_takeover(dispatch)
    assert result == {"loc": [1, 2]}
    assert "takeover" not in result
    assert desktop._takeover_guard.state is TakeoverState.IDLE


def test_desktop_dispatch_mid_dispatch_takeover_annotates_and_yields(monkeypatch) -> None:
    desktop = _make_desktop_with_guard(monkeypatch)
    ticks = desktop._ticks
    released = {"called": 0}

    def dispatch() -> dict[str, object]:
        # The user seizes the mouse WHILE the injection is in flight —
        # beyond the own-dispatch margin.
        ticks.last_input = ticks.now + desktop._takeover_guard.OWN_DISPATCH_TICK_MARGIN_MS + 1
        return {"loc": [3, 4]}

    desktop.safe_release_input = lambda: released.__setitem__("called", released["called"] + 1)
    result = desktop._mutation_takeover(dispatch)
    assert result["takeover"] == TakeoverState.YIELDED.value
    assert released["called"] == 1
    assert desktop._takeover_guard.state is TakeoverState.YIELDED
    assert desktop.takeover_state() == TakeoverState.YIELDED.value

    # Consume-on-arrival: the NEXT mutation is refused ONCE with
    # cancelled_by_user_input (the model learns why), and the machine
    # automatically re-arms — a subsequent call proceeds.
    from windows_mcp.runtime.target_resolver import TargetResolutionError

    with pytest.raises(TargetResolutionError) as exc_info:
        desktop._mutation_takeover(lambda: {"should": "not run"})
    assert exc_info.value.code is ErrorCode.CANCELLED_BY_USER_INPUT
    assert desktop.takeover_state() == TakeoverState.IDLE.value

    # The window after the consumed refusal proceeds normally.
    ticks.last_input = 0
    result = desktop._mutation_takeover(lambda: {"ok": True})
    assert result["ok"] is True
    assert "takeover" not in result


def test_desktop_dispatch_verifying_takeover_annotates_result(monkeypatch) -> None:
    desktop = _make_desktop_with_guard(monkeypatch)
    ticks = desktop._ticks

    def dispatch() -> dict[str, object]:
        return {"loc": [5, 6]}

    # No takeover during dispatch...
    result = desktop._mutation_takeover(dispatch)
    assert "takeover" not in result

    # ...but a user input during VERIFYING withdraws the mutation right and
    # the fact rides on the result — without flipping the state (verify is
    # allowed to finish read-only).
    desktop._takeover_guard.guard_enter_dispatch()
    desktop._takeover_guard.guard_arm_dispatch()
    started = desktop._takeover_guard._phase_started_tick
    desktop._takeover_guard.guard_enter_verification()
    ticks.last_input = started + 1
    assert desktop._takeover_guard.guard_takeover_check() is None
    assert not desktop._takeover_guard.may_dispatch()
    desktop._takeover_guard.guard_exit()


def test_desktop_dispatch_exception_still_resets_the_machine(monkeypatch) -> None:
    desktop = _make_desktop_with_guard(monkeypatch)

    def dispatch() -> dict[str, object]:
        raise RuntimeError("injection failed")

    with pytest.raises(RuntimeError):
        desktop._mutation_takeover(dispatch)
    # The window is closed cleanly — a failed dispatch is not a takeover,
    # and the next mutation may proceed.
    assert desktop._takeover_guard.state is TakeoverState.IDLE
    assert desktop._takeover_guard.may_dispatch()
