"""P0 coordinate dispatch invariants for multi-monitor Windows desktops."""

from unittest.mock import MagicMock

import pytest

from windows_mcp.uia import core


def test_virtual_absolute_point_supports_negative_monitor_origin(monkeypatch):
    monkeypatch.setattr(core, "GetVirtualScreenRect", lambda: (-1920, -200, 3840, 1280))

    assert core._virtual_absolute_point(-1920, -200) == (0, 0)
    assert core._virtual_absolute_point(1919, 1079) == (65535, 65535)
    center_x, center_y = core._virtual_absolute_point(0, 440)
    assert center_x == pytest.approx(32776, abs=1)
    assert center_y == pytest.approx(32793, abs=1)


def test_virtual_absolute_point_rejects_outside_target(monkeypatch):
    monkeypatch.setattr(core, "GetVirtualScreenRect", lambda: (-1920, 0, 3840, 1080))

    with pytest.raises(ValueError, match="outside virtual screen"):
        core._virtual_absolute_point(1920, 0)


def test_click_uses_virtualdesk_and_checks_both_dispatches(monkeypatch):
    monkeypatch.setattr(core, "_checked_set_cursor_pos", MagicMock())
    monkeypatch.setattr(core, "_virtual_absolute_point", lambda x, y: (123, 456))
    send = MagicMock(return_value=1)
    monkeypatch.setattr(core, "SendInput", send)
    monkeypatch.setattr(core.time, "sleep", lambda _: None)

    core.Click(-100, 50, waitTime=0)

    assert send.call_count == 2
    for call in send.call_args_list:
        flags = call.args[0].union.mi.dwFlags
        assert flags & core.MouseEventFlag.Absolute
        assert flags & core.MouseEventFlag.VirtualDesk


def test_checked_send_input_raises_on_partial_dispatch(monkeypatch):
    monkeypatch.setattr(core, "SendInput", lambda *inputs: 0)
    event = core.MouseInput(0, 0, dwFlags=core.MouseEventFlag.LeftDown)

    with pytest.raises(OSError, match="inserted 0 of 1"):
        core._require_send_input(event)
