"""WCC-P1-05 step 4: the broker's WinEvent source (foreground/window moved).

The UIA subscription source cannot see shell-level foreground switches or
HWND location changes; ``winevent.py`` adds them via SetWinEventHook. These
tests pin the seam without touching real Win32 hooks (user32/kernel32 are
injected fakes, and the callback is driven directly):

- EVENT_SYSTEM_FOREGROUND → ``foreground_changed`` and
  EVENT_OBJECT_LOCATIONCHANGE (OBJID_WINDOW only) → ``window_moved``, with
  primitive hwnd/pid identity only;
- object-level events (caret, child elements), zero hwnd, and unknown event
  ids are dropped, not enqueued;
- the callback never raises, even when identity extraction fails;
- hook installation failure degrades to an idle thread — no events, no
  crash, ``apply`` returns, ``stop`` still joins;
- ``run_broker`` wires the source and hello reports the ``winevent``
  capability.
"""

import io
import threading
import time

from windows_mcp.broker.__main__ import BrokerCore, run_broker
from windows_mcp.broker.winevent import (
    EVENT_OBJECT_LOCATIONCHANGE,
    EVENT_SYSTEM_FOREGROUND,
    WinEventSource,
)


class _FakeCore:
    """Captures ``emit`` calls the way BrokerCore would enqueue them."""

    def __init__(self) -> None:
        self.emitted: list[dict] = []

    def emit(self, kind, **fields) -> bool:
        self.emitted.append({"kind": kind, **fields})
        return True


class _FakeUser32:
    """The user32 surface WinEventSource touches.

    ``SetWinEventHook`` records the hooked ids and returns a nonzero handle
    (or 0 when ``hook_ok=False``); ``fire`` replays a WinEvent callback
    through the recorded handler so the real ``on_event`` logic runs without
    a message pump. ``PeekMessageW`` returns "no message" so the pump loop,
    when the thread runs it, just idles.
    """

    def __init__(self, *, hook_ok: bool = True, pid: int = 4242) -> None:
        self.handler = None
        self.hooked_ids: list[int] = []
        self.unhooked: list[int] = []
        self._next_hook = 0x1000
        self.hook_ok = hook_ok
        self.pid = pid

    def SetWinEventHook(self, event_min, event_max, hmod, handler, id_process, id_thread, flags):
        self.handler = handler
        self.hooked_ids.append(int(event_min))
        if not self.hook_ok:
            return 0
        self._next_hook += 1
        return self._next_hook

    def UnhookWinEvent(self, hook) -> int:
        self.unhooked.append(int(hook))
        return 1

    def PeekMessageW(self, msg, hwnd, msg_min, msg_max, remove) -> int:
        return 0

    def TranslateMessage(self, msg) -> int:
        return 0

    def DispatchMessageW(self, msg) -> int:
        return 0

    def GetWindowThreadProcessId(self, hwnd, out_pid) -> int:
        # ctypes passes the byref() wrapper; unwrap to reach the target.
        pid_cell = getattr(out_pid, "_obj", out_pid)
        pid_cell.value = self.pid
        return 100


def _fire(user32: _FakeUser32, event_id: int, hwnd: int | None, id_object: int) -> None:
    user32.handler(None, event_id, hwnd, id_object, 0, 100, 5)


def _started_source(core: _FakeCore, user32: _FakeUser32) -> WinEventSource:
    source = WinEventSource(core, user32=user32, kernel32=None)
    source.apply(None)
    return source


def test_foreground_and_move_events_are_emitted_with_identity() -> None:
    core = _FakeCore()
    user32 = _FakeUser32()
    source = _started_source(core, user32)

    _fire(user32, EVENT_SYSTEM_FOREGROUND, 0x10A, 0)
    _fire(user32, EVENT_OBJECT_LOCATIONCHANGE, 0x10A, 0)

    assert [e["kind"] for e in core.emitted] == [
        "foreground_changed",
        "window_moved",
    ]
    assert core.emitted[0]["window_hwnd"] == 0x10A
    assert core.emitted[0]["window_pid"] == 4242
    # Primitive identity only — no content fields beyond hwnd/pid.
    assert set(core.emitted[0]) == {"kind", "window_hwnd", "window_pid"}
    source.stop()
    assert source._thread is not None
    source._thread.join(timeout=2.0)
    assert not source._thread.is_alive()
    assert len(user32.unhooked) == 2


def test_object_level_and_unknown_events_are_dropped() -> None:
    core = _FakeCore()
    user32 = _FakeUser32()
    source = _started_source(core, user32)

    # Caret / child-object churn (OBJID != WINDOW) must not flood the queue.
    _fire(user32, EVENT_OBJECT_LOCATIONCHANGE, 0x10A, 0xFFFFFFF0)  # OBJID_CARET
    _fire(user32, EVENT_OBJECT_LOCATIONCHANGE, 0x10A, 3)  # OBJID_CLIENT-ish
    # Zero hwnd is not a window.
    _fire(user32, EVENT_SYSTEM_FOREGROUND, None, 0)
    _fire(user32, EVENT_SYSTEM_FOREGROUND, 0, 0)
    # An event id inside the hooked pair's range but not hooked (defensive:
    # the source hooks exact ids, so this arrives only via a misrouted call).
    _fire(user32, 0x0005, 0x10A, 0)  # EVENT_SYSTEM_MENUSTART — not mapped

    assert core.emitted == []
    source.stop()
    source._thread.join(timeout=2.0)


def test_pid_failure_still_emits_with_null_pid() -> None:
    """Best-effort identity: a dead window's pid is None, the event flows."""
    core = _FakeCore()
    user32 = _FakeUser32()

    def broken_pid(hwnd, out_pid) -> int:
        raise OSError("dead window")

    user32.GetWindowThreadProcessId = broken_pid
    source = _started_source(core, user32)

    _fire(user32, EVENT_SYSTEM_FOREGROUND, 0x10A, 0)  # must not raise

    assert core.emitted == [
        {"kind": "foreground_changed", "window_hwnd": 0x10A, "window_pid": None}
    ]
    source.stop()
    source._thread.join(timeout=2.0)


def test_hook_installation_failure_degrades_to_idle_thread() -> None:
    """No hooks → no pump → nothing to unhook; the thread idles cleanly.

    Real Win32 never calls the handler without a hook, so nothing is fired
    here — the assertion is the lifecycle, not the event stream.
    """
    core = _FakeCore()
    user32 = _FakeUser32(hook_ok=False)
    source = _started_source(core, user32)

    assert user32.hooked_ids == [EVENT_SYSTEM_FOREGROUND, EVENT_OBJECT_LOCATIONCHANGE]
    source.stop()
    assert source._thread is not None
    source._thread.join(timeout=2.0)
    assert not source._thread.is_alive()
    assert user32.unhooked == []  # nothing was ever installed
    assert core.emitted == []


def test_apply_is_idempotent_and_stop_is_safe_twice() -> None:
    core = _FakeCore()
    user32 = _FakeUser32()
    source = _started_source(core, user32)
    first_handler = user32.handler

    source.apply(None)  # second subscribe: no second install
    assert user32.hooked_ids == [EVENT_SYSTEM_FOREGROUND, EVENT_OBJECT_LOCATIONCHANGE]
    assert user32.handler is first_handler

    source.stop()
    source.stop()  # safe to call twice
    source._thread.join(timeout=2.0)
    assert not source._thread.is_alive()


def test_broker_core_runs_with_winevent_source() -> None:
    """BrokerCore + WinEventSource end to end: hook callback → output frame."""
    out = io.BytesIO()
    core = BrokerCore(9, out)
    # read() on BytesIO returns fewer bytes at EOF, which read_frame treats
    # as a frame boundary only when the header is torn; run() loops on it
    # (same trick as the hello test in test_broker_protocol.py).
    stdin = io.BytesIO()
    stdin_read = stdin.read
    stdin.read = lambda n: stdin_read(n) if stdin.tell() < len(stdin.getvalue()) else None  # type: ignore[method-assign]

    user32 = _FakeUser32()
    source = WinEventSource(core, user32=user32, kernel32=None)
    source.apply(None)

    run_thread = threading.Thread(target=core.run, args=(stdin,), daemon=True)
    run_thread.start()
    try:
        _fire(user32, EVENT_SYSTEM_FOREGROUND, 0x7B, 0)
        deadline = time.monotonic() + 2.0
        data = b""
        while time.monotonic() < deadline:
            with out.getbuffer() as buffer:
                data = bytes(buffer)
            if data.count(b'"type": "event"') >= 1:
                break
            time.sleep(0.01)
        assert b'"foreground_changed"' in data
    finally:
        source.stop()
        source._thread.join(timeout=2.0)
        core._stopped.set()
        run_thread.join(timeout=2.0)


def test_hello_advertises_winevent_capability() -> None:
    core = BrokerCore(5, io.BytesIO())
    assert core._hello()["capabilities"] == [
        "focus",
        "property",
        "structure",
        "winevent",
    ]


def test_run_broker_wires_winevent_source(monkeypatch) -> None:
    """The real entry point applies the source at start and stops it at exit."""
    lifecycle: list[str] = []

    class _FakeSource:
        def apply(self, request) -> None:
            lifecycle.append("applied")

        def stop(self) -> None:
            lifecycle.append("stopped")

    monkeypatch.setattr(
        "windows_mcp.broker.__main__._winevent_adapter", lambda core: _FakeSource()
    )

    class _Eof(io.BytesIO):
        # A closed stdin makes the broker loop exit at the first read.
        closed = True

    run_broker(_Eof(), io.BytesIO(), 5)
    assert lifecycle == ["applied", "stopped"]
