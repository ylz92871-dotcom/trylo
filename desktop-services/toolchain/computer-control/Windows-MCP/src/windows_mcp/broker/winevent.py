"""WinEvent source inside the broker process (spec P1-05 step 4).

Covers the two event kinds the UIA subscription source cannot see:

- ``foreground_changed`` — EVENT_SYSTEM_FOREGROUND: the shell-level "another
  window took the foreground" fact behind lease ``revokeOn:
  foreground_changed`` (WCC-P2-01) and §18.3 ``focus_theft_count``.
- ``window_moved`` — EVENT_OBJECT_LOCATIONCHANGE (OBJID_WINDOW): an
  exact-window capture frame going stale, or a window the agent is about to
  click sliding away mid-approach.

Hooks are installed OUT_OF_CONTEXT: callbacks are delivered to the host
thread's Win32 message queue, so that thread pumps messages (``_pump_until_stop``).
Callbacks only extract primitive identity fields (hwnd, pid) and enqueue —
no tree traversal, no pattern calls, no model logic (spec §6.3). Every
failure path degrades to polling: installation errors are swallowed by the
caller (``broker.__main__``), and a dead message pump merely stops the
increment stream while heartbeats keep the supervisor from restarting an
otherwise healthy process.
"""

from __future__ import annotations

import threading

# Event constants (winuser.h); defined locally so importing the module never
# requires anything beyond the stdlib — only the host thread touches Win32,
# matching the lazy-COM style of uia_subscriptions.
EVENT_SYSTEM_FOREGROUND = 0x0003
EVENT_OBJECT_LOCATIONCHANGE = 0x800B
OBJID_WINDOW = 0
WINEVENT_OUTOFCONTEXT = 0x0000
WINEVENT_SKIPOWNPROCESS = 0x0002

_KIND_FOREGROUND = "foreground_changed"
_KIND_MOVED = "window_moved"

_KIND_FOR_EVENT = {
    EVENT_SYSTEM_FOREGROUND: _KIND_FOREGROUND,
    EVENT_OBJECT_LOCATIONCHANGE: _KIND_MOVED,
}

# Event ids hooked, one SetWinEventHook per id. A ranged hook (min..max)
# would also fire for every other event id in between — menu/capture/name
# churn the callback would only discard — so the hook set is exact.
_HOOK_EVENT_IDS = (EVENT_SYSTEM_FOREGROUND, EVENT_OBJECT_LOCATIONCHANGE)

# Poll cadence of the host thread's message pump. PeekMessageW does not
# block, so this bounds shutdown latency, not event delivery latency.
_PUMP_POLL_SECONDS = 0.05

# Timeout for apply() to wait on hook installation before returning (tests
# synchronize on it; the real install is instantaneous).
_INSTALL_TIMEOUT = 5.0


class WinEventSource:
    """Owns the broker's WinEvent hooks on their own host thread.

    ``user32``/``kernel32`` are injectable ctypes-like namespaces: real
    ``WinDLL`` loads happen on the host thread when omitted, tests inject
    fakes and drive ``on_event`` directly.
    """

    def __init__(self, core, *, user32=None, kernel32=None) -> None:
        self._core = core
        self._user32 = user32
        self._kernel32 = kernel32
        # True while a test fake is injected; the real WinDLLs load lazily
        # on the host thread and replace the None placeholders.
        self._user32_injected = user32 is not None
        self._installed = threading.Event()
        self._ready = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._handler: object | None = None  # keeps the ctypes callback alive

    def apply(self, request) -> None:
        """Start the host thread on first use; later subscribes are no-ops.

        The hook scope is desktop-wide on purpose (same steady state as the
        UIA automation-event registration), so one install per broker
        process lifetime is the design; ``request`` is not scoped to.
        Returns once hooks are installed (or installation failed and the
        thread idles — check nothing: absence of events is polling's job).
        """
        if self._installed.is_set():
            self._ready.wait(_INSTALL_TIMEOUT)
            return
        self._installed.set()
        self._thread = threading.Thread(
            target=self._run_hook_thread, name="broker-winevent", daemon=True
        )
        self._thread.start()
        self._ready.wait(_INSTALL_TIMEOUT)

    def stop(self) -> None:
        """Signal the host thread to exit and unhook. Safe to call twice."""
        self._stop.set()

    # ------------------------------------------------------------------ #
    # host thread                                                         #
    # ------------------------------------------------------------------ #

    def _load_win32(self) -> tuple[object, object]:
        # Only the real path (nothing injected) loads WinDLLs — an injected
        # fake user32 must never be replaced, or tests would install real
        # system hooks.
        if not self._user32_injected:
            import ctypes

            self._user32 = ctypes.WinDLL("user32", use_last_error=True)
            self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        return self._user32, self._kernel32

    def _make_c_handler(self):
        """Wrap ``on_event`` into a real WINEVENTPROC pointer (real path)."""
        import ctypes

        # LRESULT WinEventProc(HWINEVENTHOOK, DWORD event, HWND hWnd,
        #   LONG idObject, LONG idChild, DWORD idThread, DWORD dwmsEventTime)
        WINEVENTPROC = ctypes.WINFUNCTYPE(
            ctypes.c_long,  # LRESULT
            ctypes.c_void_p,  # hook handle
            ctypes.c_uint32,  # event id
            ctypes.c_void_p,  # hwnd
            ctypes.c_long,  # idObject
            ctypes.c_long,  # idChild
            ctypes.c_uint32,  # thread id
            ctypes.c_uint32,  # event time (ms)
        )
        return WINEVENTPROC(self.on_event)

    def _run_hook_thread(self) -> None:
        try:
            user32, _kernel32 = self._load_win32()
            # Fake seam (user32 injected by tests): a plain Python callable
            # works as the handler. The real path needs a ctypes pointer
            # that must outlive the install — keep it on ``self._handler``.
            handler = self.on_event if self._user32_injected else self._make_c_handler()
            self._handler = handler
            hooks = self._install_hooks(user32, handler)
        except Exception:
            hooks = []
        if not hooks:
            # No hooks means no increment stream; the supervisor's polling
            # fallback is unchanged. Idle so ``apply`` stays idempotent and
            # ``stop`` still joins a live thread.
            self._ready.set()
            self._stop.wait()
            return
        try:
            self._ready.set()  # hooks decided: applied or degraded
            _pump_until_stop(self._user32, self._stop)
        finally:
            for hook in hooks:
                try:
                    self._user32.UnhookWinEvent(hook)
                except Exception:
                    pass
            self._stop.set()

    def _install_hooks(self, user32, handler) -> list[int]:
        hooks: list[int] = []
        for event_id in _HOOK_EVENT_IDS:
            try:
                hook = user32.SetWinEventHook(
                    event_id,
                    event_id,
                    None,  # hmod: NULL for OUTOFCONTEXT callbacks outside a DLL
                    handler,
                    0,  # idProcess: all processes
                    0,  # idThread: all threads
                    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
                )
            except Exception:
                hook = 0
            if hook:
                hooks.append(hook)
        return hooks

    # ------------------------------------------------------------------ #
    # WinEvent callback (host thread; test entry point)                   #
    # ------------------------------------------------------------------ #

    def on_event(self, _hook, event_id, hwnd, id_object, _id_child, _thread_id, _time) -> int:
        """One WinEvent → at most one enqueued identity event.

        OBJID_WINDOW keeps LOCATIONCHANGE to real windows: object-level
        churn (caret moves, child elements) would flood the bounded queue.
        Returns S_OK; never raises (a raised ctypes callback would only be
        printed, but honesty about the swallow is worth the try/except).
        """
        try:
            if not hwnd or int(id_object) != OBJID_WINDOW:
                return 0
            kind = _KIND_FOR_EVENT.get(int(event_id))
            if kind is None:
                return 0
            handle = int(hwnd)
            self._core.emit(
                kind,
                window_hwnd=handle,
                window_pid=self._pid_of(handle),
            )
        except Exception:
            pass
        return 0

    def _pid_of(self, hwnd: int) -> int | None:
        """Best-effort pid for a hwnd. Primitive-only; never raises."""
        try:
            import ctypes

            pid = ctypes.c_ulong()
            self._user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            return int(pid.value) if pid.value else None
        except Exception:
            return None


def _pump_until_stop(user32, stop: threading.Event) -> None:
    """Drain the host thread's message queue until ``stop`` is set.

    Out-of-context hook callbacks arrive as queued messages; without this
    pump they are never delivered. Peek-based (not GetMessageW): posting
    WM_QUIT from another thread to unblock a blocking get races the hook
    delivery queue, while a 50 ms peek loop keeps shutdown simple.
    """
    import ctypes

    class _MSG(ctypes.Structure):
        # winuser.h MSG; natural alignment matches the OS layout on win64.
        _fields_ = [
            ("hwnd", ctypes.c_void_p),
            ("message", ctypes.c_uint32),
            ("wParam", ctypes.c_void_p),
            ("lParam", ctypes.c_void_p),
            ("time", ctypes.c_uint32),
            ("pt", ctypes.c_long * 2),
        ]

    message = _MSG()
    PM_REMOVE = 0x0001
    while not stop.is_set():
        while user32.PeekMessageW(ctypes.byref(message), None, 0, 0, PM_REMOVE):
            user32.TranslateMessage(ctypes.byref(message))
            user32.DispatchMessageW(ctypes.byref(message))
        stop.wait(_PUMP_POLL_SECONDS)
