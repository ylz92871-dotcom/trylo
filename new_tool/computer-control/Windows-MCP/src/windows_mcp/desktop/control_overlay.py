"""Click-through Win32 feedback owned by actual desktop tool dispatches.

No input hooks, focus changes, system cursor replacement or durable UI process.
The daemon ends with its MCP server. Screenshots temporarily hide all its windows;
recording outside those short capture windows retains the gold surround.
"""

import atexit
from contextlib import contextmanager
import ctypes
import logging
import math
import threading
import time

from windows_mcp.desktop import flash_overlay as native
from windows_mcp.desktop.control_visuals import premultiplied, render_cursor, render_halo

logger = logging.getLogger(__name__)
_lock = threading.RLock()
_current = None
_capture_depth = 0
_TAIL = 1.6


class _Activity:
    def __init__(self):
        self.stop = threading.Event()
        self.closed = threading.Event()
        self.hidden = threading.Event()
        self.active = True
        self.ended = 0.0
        self.point = None
        self.click_at = None


def begin():
    """Best-effort visuals must never prevent an input operation."""
    global _current
    if native._flash_disabled():
        return None
    activity = None
    try:
        native.cancel_active_flash()
        with _lock:
            previous = _current
        if previous:
            previous.stop.set()
            if not previous.closed.wait(1.0):
                return None
        with _lock:
            activity = _Activity()
            _current = activity
            threading.Thread(target=_run, args=(activity,), daemon=True,
                             name="trylo-gold-control").start()
        return activity
    except Exception:
        if activity is not None:
            activity.stop.set()
            activity.closed.set()
            with _lock:
                if _current is activity:
                    _current = None
        logger.debug("could not start control feedback", exc_info=True)
        return None


def finish(activity, result=None, *, click=False):
    if activity is None:
        return
    # No receipt cursor for rejected, uncertain, failed or user-yielded input.
    status = getattr((result or {}).get("dispatch_status"), "value",
                     (result or {}).get("dispatch_status", "accepted"))
    if result is None or result.get("takeover") or status != "accepted":
        activity.stop.set()
        return
    with _lock:
        point = result.get("loc")
        if point is None and isinstance(result.get("locs"), (list, tuple)) and result["locs"]:
            point = result["locs"][-1]
        if isinstance(point, (tuple, list)) and len(point) >= 2:
            if all(isinstance(n, (float, int)) and math.isfinite(n) for n in point[:2]):
                activity.point = (int(point[0]), int(point[1]))
        activity.click_at = time.monotonic() if click and activity.point else None
        activity.ended = time.monotonic()
        activity.active = False


def cancel(timeout=0.5):
    global _current
    with _lock:
        activity, _current = _current, None
    if activity:
        activity.stop.set()
        activity.closed.wait(timeout)


def is_active():
    with _lock:
        return _current is not None and not _current.stop.is_set()


@contextmanager
def operation():
    """For non-pointer tools that do not return a target receipt."""
    activity = begin()
    try:
        yield
    except BaseException:
        finish(activity)
        raise
    else:
        finish(activity, {})


@contextmanager
def hidden_for_capture():
    """Wait for the UI thread to acknowledge hiding before reading pixels."""
    global _capture_depth
    with _lock:
        _capture_depth += 1
        activity = _current
    try:
        if activity and not activity.hidden.wait(1.0) and not activity.closed.is_set():
            activity.stop.set()
            if not activity.closed.wait(1.0):
                raise RuntimeError("control overlay did not hide before screenshot")
        yield
    finally:
        with _lock:
            _capture_depth -= 1


def _run(activity):
    global _current
    windows = []
    prior_dpi = None
    try:
        # Physical coordinates match UIA / SendInput even on mixed-DPI displays.
        prior_dpi = native._user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
        import windows_mcp.uia as uia
        for index, rect in enumerate(uia.GetMonitorsRect()):
            w, h = rect.right-rect.left, rect.bottom-rect.top
            if w <= 0 or h <= 0:
                continue
            name = f"TryloGold_{id(activity):x}_{index}"
            hwnd, instance = native._create_layered_window(name, rect.left, rect.top, w, h)
            windows.append((hwnd, instance, name, rect.left, rect.top, w, h, None))
            scale = max(96, native._user32.GetDpiForWindow(hwnd)) / 96
            pixels = premultiplied(render_halo(w, h, scale))
            windows[-1] = (hwnd, instance, name, rect.left, rect.top, w, h, pixels)
        if not windows:
            return
        name = f"TryloGoldCursor_{id(activity):x}"
        hwnd, instance = native._create_layered_window(name, 0, 0, 88, 88)
        windows.append((hwnd, instance, name, 0, 0, 88, 88, None))
        cursor_window = hwnd
        started = time.monotonic()
        previous_alpha = -1
        was_hidden = True
        last_input = None
        while not activity.stop.is_set():
            now = time.monotonic()
            with _lock:
                hide = _capture_depth > 0
                active, ended, point, click_at = (activity.active, activity.ended,
                                                  activity.point, activity.click_at)
                if not active and now-ended >= _TAIL:
                    break
                if hide:
                    if not was_hidden:
                        for window in windows:
                            native._user32.ShowWindow(window[0], 0)
                        ctypes.windll.dwmapi.DwmFlush()
                    activity.hidden.set()
                    was_hidden = True
                else:
                    activity.hidden.clear()
                    # The tail belongs to the receipt. Any subsequent human input
                    # dismisses it immediately; no new hooks or takeover policy.
                    if not active:
                        from windows_mcp.runtime.takeover import _win32_last_input_tick
                        current_input = _win32_last_input_tick()
                        if last_input is not None and current_input != last_input:
                            break
                        last_input = current_input
                    intensity = min(1.0, (now-started)/0.16)
                    if not active:
                        intensity *= min(1.0, max(0.0, (_TAIL-(now-ended))/0.35))
                    alpha = round(intensity*24)*255//24
                    if alpha != previous_alpha or was_hidden:
                        for window in windows[:-1]:
                            target, _, _, x, y, w, h, pixels = window
                            native._push_bitmap(target, x, y, w, h, pixels, opacity=alpha)
                            native._user32.ShowWindow(target, native._SW_SHOWNA)
                        previous_alpha = alpha
                    if point:
                        # Cursor size follows the monitor containing the receipt.
                        monitor = next((window for window in windows[:-1]
                                        if window[3] <= point[0] < window[3]+window[5]
                                        and window[4] <= point[1] < window[4]+window[6]), None)
                        if monitor:
                            scale = max(96, native._user32.GetDpiForWindow(monitor[0]))/96
                            pulse = (now-click_at)/0.45 if click_at is not None else None
                            image = render_cursor(scale, pulse)
                            native._push_bitmap(cursor_window,
                                                point[0]-round(24*scale), point[1]-round(24*scale),
                                                image.width, image.height, premultiplied(image),
                                                opacity=alpha)
                            native._user32.ShowWindow(cursor_window, native._SW_SHOWNA)
                    was_hidden = False
            for window in windows:
                native._pump_messages(window[0])
            activity.stop.wait(1/30)
    except Exception:
        logger.debug("control feedback unavailable", exc_info=True)
    finally:
        for hwnd, instance, name, *_ in reversed(windows):
            try:
                native._user32.DestroyWindow(hwnd)
                native._user32.UnregisterClassW(name, instance)
            except Exception:
                logger.debug("could not dispose feedback window", exc_info=True)
        if prior_dpi:
            native._user32.SetThreadDpiAwarenessContext(prior_dpi)
        with _lock:
            if _current is activity:
                _current = None
        activity.closed.set()
        activity.hidden.set()


native._user32.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
native._user32.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
native._user32.GetDpiForWindow.argtypes = [ctypes.c_void_p]
native._user32.GetDpiForWindow.restype = ctypes.c_uint
atexit.register(cancel)
