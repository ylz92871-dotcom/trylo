"""Low-level user-input hook for EXACT takeover detection (spec §11.3).

``TakeoverDetector``'s ``GetLastInputInfo`` tick is a heuristic: Trylo's own
SendInput bumps the same tick, so the guard needs a compensation margin that
both delays real-takeover detection mid-dispatch and can misclassify a fast
user event landing inside the margin. This module removes the guesswork: a
WH_KEYBOARD_LL / WH_MOUSE_LL hook sees EVERY input event with its
``dwExtraInfo`` marker, and Trylo-injected events carry the §11.3 tag (set
in ``uia.core`` on every SendInput) — so a non-Trylo event is a real user
input, by hard evidence, at the event's own timestamp.

Design (mirrors ``broker/winevent.py``, the proven hook-thread template):

- a dedicated daemon thread installs both LL hooks and pumps messages
  (WH_*_LL callbacks arrive on the installing thread's queue; without a
  pump the OS silently drops the hooks after ``LowLevelHooksTimeout``);
- the callback extracts primitives only — message id and ``dwExtraInfo`` —
  and records the latest non-Trylo event under a lock. No dispatching, no
  state-machine writes: the takeover state machine stays pure (P2-04
  audit), the guard CONSUMES the recorded timestamps through
  ``TakeoverDetector``;
- every failure path degrades to the existing tick heuristic: installation
  failure, a dead pump, an unloadable user32 — all leave the watcher
  reporting unavailable and the guard falling back, never fail-closed.

Liveness contract: a hook that stops delivering (starved pump, OS-dropped
hook) must never read as "no user input". The pump publishes a heartbeat
from the hook thread itself; ``pump_alive()`` gates the precise verdict, and
a stale heartbeat downgrades consumers to the tick heuristic.
"""

from __future__ import annotations

import ctypes
import threading

from windows_mcp.runtime.takeover import tag_matches

# winuser.h constants, defined locally so importing the module never
# requires Win32 — only the host thread touches it (winevent.py style).
WH_KEYBOARD_LL = 13
WH_MOUSE_LL = 14

WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_SYSKEYDOWN = 0x0104
WM_SYSKEYUP = 0x0105
WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_RBUTTONDOWN = 0x0204
WM_RBUTTONUP = 0x0205
WM_MBUTTONDOWN = 0x0207
WM_MBUTTONUP = 0x0208
WM_MOUSEWHEEL = 0x020A
WM_MOUSEHWHEEL = 0x020E

_KIND_KEY = "key"
_KIND_MOUSE_BUTTON = "mouse_button"
_KIND_WHEEL = "wheel"

_KIND_FOR_MESSAGE = {
    WM_KEYDOWN: _KIND_KEY,
    WM_KEYUP: _KIND_KEY,
    WM_SYSKEYDOWN: _KIND_KEY,
    WM_SYSKEYUP: _KIND_KEY,
    WM_LBUTTONDOWN: _KIND_MOUSE_BUTTON,
    WM_LBUTTONUP: _KIND_MOUSE_BUTTON,
    WM_RBUTTONDOWN: _KIND_MOUSE_BUTTON,
    WM_RBUTTONUP: _KIND_MOUSE_BUTTON,
    WM_MBUTTONDOWN: _KIND_MOUSE_BUTTON,
    WM_MBUTTONUP: _KIND_MOUSE_BUTTON,
    WM_MOUSEWHEEL: _KIND_WHEEL,
    WM_MOUSEHWHEEL: _KIND_WHEEL,
}

_HOOK_IDS = (WH_KEYBOARD_LL, WH_MOUSE_LL)

# Poll cadence of the host thread's message pump. PeekMessageW does not
# block, so this bounds shutdown latency, not delivery latency.
_PUMP_POLL_SECONDS = 0.05

# Timeout for start() to wait on hook installation (tests synchronize on
# it; the real install is instantaneous).
_START_TIMEOUT = 5.0

# A pump heartbeat older than this → consumers downgrade to the tick
# heuristic instead of trusting "no user input".
_PUMP_LIVENESS_SECONDS = 1.0


class UserInputHookWatcher:
    """Owns the low-level input hooks on their own host thread.

    ``user32`` is an injectable ctypes-like namespace: the real ``WinDLL``
    loads on the host thread when omitted; tests inject fakes and drive
    ``on_event`` directly. The watcher records the latest non-Trylo input
    event (monotonic timestamp + kind) — it never blocks input, never
    dispatches, never touches the takeover state machine.
    """

    def __init__(self, *, user32=None, clock=None) -> None:
        self._user32 = user32
        self._clock = clock  # Callable[[], float] monotonic seconds; tests only
        self._user32_injected = user32 is not None
        self._started = threading.Event()
        self._ready = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._handler: object | None = None  # keeps the ctypes callback alive
        self._lock = threading.Lock()
        self._last_event_monotonic: float | None = None
        self._last_event_kind: str | None = None
        self._last_escape_monotonic: float | None = None
        self._heartbeat = 0.0

    # ── lifecycle ─────────────────────────────────────────────────────────
    def start(self) -> None:
        """Start the hook thread once (idempotent, like winevent's apply).
        Returns once installation is decided — applied or degraded; the
        caller checks nothing: absence of events is the heuristic's job."""
        if self._started.is_set():
            self._ready.wait(_START_TIMEOUT)
            return
        self._started.set()
        self._thread = threading.Thread(
            target=self._run_hook_thread, name="takeover-user-input-hook", daemon=True
        )
        self._thread.start()
        self._ready.wait(_START_TIMEOUT)

    def stop(self) -> None:
        """Signal the host thread to exit and unhook. Safe to call twice."""
        self._stop.set()

    def join(self, timeout: float = 2.0) -> None:
        thread = self._thread
        if thread is not None:
            thread.join(timeout=timeout)

    # ── recorded facts (guarded by _lock; consumed by the guard) ─────────
    def last_user_input_monotonic(self) -> float | None:
        """Monotonic timestamp of the latest non-Trylo input event, or None
        when no user input has been observed since start()."""
        with self._lock:
            return self._last_event_monotonic

    def last_user_input_kind(self) -> str | None:
        with self._lock:
            return self._last_event_kind

    def pump_alive(self) -> bool:
        """True while the hook thread's pump heartbeat is fresh.

        A dead or starved pump must not read as "no user input" — consumers
        gate on this before trusting a negative verdict.
        """
        with self._lock:
            heartbeat = self._heartbeat
        if heartbeat <= 0.0:
            return False
        return (self._monotonic() - heartbeat) <= _PUMP_LIVENESS_SECONDS

    # ── precise verdict contract (TakeoverDetector consumes these) ───────
    def precise_now(self) -> float | None:
        """Monotonic now anchored to the same clock as the recorded events,
        or None when the hook is not trustworthy (never started / install
        failed / pump stale)."""
        if not self._trustworthy():
            return None
        return self._monotonic()

    def escape_since(self, since_monotonic: float | None) -> bool:
        """Only a recorded, non-Trylo Esc keydown can stop a control scope."""
        if since_monotonic is None:
            return False
        with self._lock:
            escaped = self._last_escape_monotonic
        return escaped is not None and escaped > since_monotonic

    def user_input_since_precise(self, since_monotonic: float | None) -> bool | None:
        """Three-state verdict: True (user input after ``since``), False
        (hook healthy, none seen after ``since``), None (hook unavailable —
        caller falls back to the tick heuristic). ``since`` must be a value
        returned by ``precise_now``; None begets None."""
        if since_monotonic is None or not self._trustworthy():
            return None
        with self._lock:
            record = self._last_event_monotonic
        if record is None:
            return False
        return record > since_monotonic

    def _trustworthy(self) -> bool:
        if not self._started.is_set() or self._stop.is_set():
            return False
        thread = self._thread
        if thread is None or not thread.is_alive():
            return False
        return self.pump_alive()

    # ------------------------------------------------------------------ #
    # host thread                                                         #
    # ------------------------------------------------------------------ #

    def _monotonic(self) -> float:
        if self._clock is not None:
            return self._clock()
        import time

        return time.monotonic()

    def _load_win32(self) -> object:
        # Only the real path (nothing injected) loads the WinDLL — an
        # injected fake user32 must never be replaced, or tests would
        # install real system-wide hooks.
        if not self._user32_injected:
            self._user32 = ctypes.WinDLL("user32", use_last_error=True)
        return self._user32

    def _make_c_handler(self):
        """Wrap ``on_event`` into a real HOOKPROC pointer (real path)."""
        import ctypes

        # LRESULT LowLevelProc(int nCode, WPARAM wParam, LPARAM lParam)
        HOOKPROC = ctypes.WINFUNCTYPE(
            ctypes.c_longlong,  # LRESULT
            ctypes.c_int,  # nCode
            ctypes.c_size_t,  # wParam (message id)
            ctypes.c_void_p,  # lParam (KBDLLHOOKSTRUCT* / MSLLHOOKSTRUCT*)
        )
        return HOOKPROC(self.on_event)

    def _run_hook_thread(self) -> None:
        try:
            user32 = self._load_win32()
            handler = self.on_event if self._user32_injected else self._make_c_handler()
            self._handler = handler
            hooks = self._install_hooks(user32, handler)
        except Exception:
            hooks = []
        if not hooks:
            # No hooks → no precise stream; the guard's tick heuristic is
            # unchanged (fail-open). Idle so ``start`` stays idempotent and
            # ``stop`` still joins a live thread.
            self._ready.set()
            self._stop.wait()
            return
        try:
            self._ready.set()
            self._pump_until_stop(user32)
        finally:
            for hook in hooks:
                try:
                    user32.UnhookWindowsHookEx(hook)
                except Exception:
                    pass
            self._stop.set()

    def _install_hooks(self, user32, handler) -> list[int]:
        hooks: list[int] = []
        for hook_id in _HOOK_IDS:
            try:
                hook = user32.SetWindowsHookExW(
                    hook_id,
                    handler,
                    None,  # hmod: NULL for LL hooks
                    0,  # dwThreadId: 0 = all desktop input
                )
            except Exception:
                hook = 0
            if hook:
                hooks.append(hook)
        return hooks

    def _pump_until_stop(self, user32) -> None:
        """Drain the host thread's message queue until ``stop`` is set.

        WH_*_LL callbacks are delivered as queued messages on the installing
        thread. Peek-based like winevent.py: posting WM_QUIT from another
        thread to unblock a blocking get races the hook delivery queue,
        while a 50 ms peek loop keeps shutdown simple. Each pass refreshes
        the liveness heartbeat the precise verdict gates on.
        """
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
        with self._lock:
            self._heartbeat = self._monotonic()
        while not self._stop.is_set():
            while user32.PeekMessageW(ctypes.byref(message), None, 0, 0, PM_REMOVE):
                user32.TranslateMessage(ctypes.byref(message))
                user32.DispatchMessageW(ctypes.byref(message))
            with self._lock:
                self._heartbeat = self._monotonic()
            self._stop.wait(_PUMP_POLL_SECONDS)

    # ------------------------------------------------------------------ #
    # hook callback (host thread; test entry point)                       #
    # ------------------------------------------------------------------ #

    def on_event(self, n_code, message, l_param) -> int:
        """One LL hook callback → record it when it is REAL user input.

        Trylo's own injected events carry the §11.3 tag in ``dwExtraInfo``
        and are DISCARDED here (「不把自身输入当用户抢占」). Everything
        else — real user input, or third-party synthetic input, which by
        definition is not Trylo's — records as a user event. Never raises;
        always passes the event down the hook chain via CallNextHookEx.
        """
        try:
            if int(n_code) < 0 or l_param is None:
                return self._call_next_hook(n_code, message, l_param)
            kind = _KIND_FOR_MESSAGE.get(int(message) & 0xFFFFFFFF)
            if kind is not None:
                extra_info = self._read_extra_info(int(message), l_param)
                # An UNREADABLE struct records nothing: without the tag we
                # cannot prove the event is not Trylo's own injection, so
                # we never report it as user input (fail-silent, and the
                # tick heuristic still covers the phase).
                if extra_info is not None and not tag_matches(extra_info):
                    with self._lock:
                        self._last_event_monotonic = self._monotonic()
                        self._last_event_kind = kind
                        if int(message) in (WM_KEYDOWN, WM_SYSKEYDOWN) and _KBDLLHOOKSTRUCT.from_address(l_param).vkCode == 0x1B:
                            self._last_escape_monotonic = self._last_event_monotonic
        except Exception:
            pass
        return self._call_next_hook(n_code, message, l_param)

    def _read_extra_info(self, message: int, l_param) -> int | None:
        """Read ``dwExtraInfo`` from the hook struct the event points at.

        The struct type follows the message: keyboard events carry a
        KBDLLHOOKSTRUCT, mouse events an MSLLHOOKSTRUCT — both end in the
        ULONG_PTR ``dwExtraInfo``, with different offsets, so the real
        layouts are declared. ``l_param`` is an address (int) from the
        real callback; tests pass ``ctypes.addressof(struct)`` the same way.

        A garbage address must not crash the process: ``ctypes.cast(...).
        contents`` dereferences WITHOUT any guard and a bad pointer is an
        unrecoverable access violation (no except can catch it), so the
        address is probe-read first and an unreadable one yields None.
        """
        address = l_param if isinstance(l_param, int) else None
        if not address or address <= 0:
            return None
        if message in (WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP):
            struct_type = _KBDLLHOOKSTRUCT
        else:
            struct_type = _MSLLHOOKSTRUCT
        if not _address_readable(address, ctypes.sizeof(struct_type)):
            return None
        event = struct_type.from_address(address)
        return int(event.dwExtraInfo)

    def _call_next_hook(self, n_code, message, l_param) -> int:
        """Pass the event down the hook chain — dropping it would break
        every other installed hook (and Windows' own input processing)."""
        try:
            return int(self._user32.CallNextHookEx(None, n_code, message, l_param))
        except Exception:
            return 0


class _MemoryBasicInformation(ctypes.Structure):
    _fields_ = [("base", ctypes.c_void_p), ("allocation_base", ctypes.c_void_p),
                ("allocation_protect", ctypes.c_uint32), ("region_size", ctypes.c_size_t),
                ("state", ctypes.c_uint32), ("protect", ctypes.c_uint32), ("kind", ctypes.c_uint32)]


def _address_readable(address: int, size: int) -> bool:
    """True when ``size`` bytes at ``address`` can be read without faulting.

    Query page metadata before dereferencing the complete hook structure.
    IsBadReadPtr probes by causing an access violation; even when Windows
    handles it, Python's fault handler prints a misleading fatal stack.
    """
    try:
        query = ctypes.windll.kernel32.VirtualQuery
        query.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
        query.restype = ctypes.c_size_t
        info = _MemoryBasicInformation()
        if not query(ctypes.c_void_p(address), ctypes.byref(info), ctypes.sizeof(info)):
            return False
        return (info.state == 0x1000 and not info.protect & (0x1 | 0x100)
                and info.base is not None and address + size <= info.base + info.region_size)
    except AttributeError:
        # No ctypes.windll (non-Windows): nothing to probe with. The real
        # path is Windows-only and its l_param is always a live OS struct;
        # tests construct real ctypes structs, so assume readable.
        return True
    except Exception:
        return False


class _KBDLLHOOKSTRUCT(ctypes.Structure):
    """winuser.h KBDLLHOOKSTRUCT (x64: 24 bytes, dwExtraInfo at offset 16)."""

    _fields_ = [
        ("vkCode", ctypes.c_uint32),
        ("scanCode", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("time", ctypes.c_uint32),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class _MSLLHOOKSTRUCT(ctypes.Structure):
    """winuser.h MSLLHOOKSTRUCT (x64: 32 bytes, dwExtraInfo at offset 24)."""

    _fields_ = [
        ("pt", ctypes.c_long * 2),
        ("mouseData", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("time", ctypes.c_uint32),
        ("dwExtraInfo", ctypes.c_size_t),
    ]
