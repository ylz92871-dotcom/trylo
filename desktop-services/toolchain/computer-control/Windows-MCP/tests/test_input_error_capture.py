"""Exercise Win32 error capture without moving the pointer or sending input."""
import ctypes
from types import SimpleNamespace

import pytest

from windows_mcp.uia import core


def test_cursor_failure_preserves_error_and_discards_stale_error(monkeypatch):
    def denied(x, y):
        assert ctypes.get_last_error() == 0
        ctypes.set_last_error(5)
        return 0

    monkeypatch.setattr(core, "_input_user32", SimpleNamespace(SetCursorPos=denied))
    ctypes.set_last_error(123)
    with pytest.raises(OSError, match="SetCursorPos") as failure:
        core._checked_set_cursor_pos(10, 20)
    assert failure.value.errno == 5


def test_input_failure_without_win32_error_does_not_report_stale_error(monkeypatch):
    def blocked(count, events, size):
        assert ctypes.get_last_error() == 0
        return 0  # SendInput may fail through UIPI without setting last error.

    monkeypatch.setattr(core, "_input_user32", SimpleNamespace(SendInput=blocked))
    ctypes.set_last_error(123)
    event = core.MouseInput(0, 0, dwFlags=core.MouseEventFlag.LeftDown)
    with pytest.raises(OSError, match="inserted 0 of 1") as failure:
        core._require_send_input(event)
    assert failure.value.errno == 0


def test_native_input_bindings_enable_last_error_capture():
    assert core._input_user32.SetCursorPos._flags_ & ctypes._FUNCFLAG_USE_LASTERROR
    assert core._input_user32.SendInput._flags_ & ctypes._FUNCFLAG_USE_LASTERROR


def test_shortcut_cannot_report_success_when_keyboard_input_is_blocked(monkeypatch):
    monkeypatch.setattr(core, "SendInput", lambda *events: 0)
    with pytest.raises(OSError, match="inserted 0 of 1"):
        core.keybd_event(27, 0, 0, 0)
