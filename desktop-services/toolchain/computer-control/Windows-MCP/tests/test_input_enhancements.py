"""Tests for the CAD-workflow input enhancements:

- Click: modifiers (Ctrl/Shift+Click), press/hold + release, double-click
  timing honored for EVERY button (middle double click = Zoom Extents),
  window pre-focus.
- Type: focused mode (no click), per-key interval, IME/layout warning,
  multi-line escape handling.
- Scroll: raw wheel-delta granularity.
- Move/drag: right / middle button drags.
- Element resolution: live UIA fallback for native file-dialog list items.
- keyboard_layout / ocr_region: pure-logic tests with faked Win32/PowerShell.
"""

import asyncio
from collections.abc import Callable
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from windows_mcp.desktop import service
from windows_mcp.desktop.service import Desktop
from windows_mcp.desktop.views import DesktopState
from windows_mcp.tools.input import (
    _as_str_list,
    register as register_input,
)
from windows_mcp.tree.views import BoundingBox, Center, TreeElementNode, TreeState


class FakeMCP:
    def __init__(self) -> None:
        self.tools: dict[str, Callable] = {}

    def tool(self, *, name: str, **kwargs: object) -> Callable:
        def decorator(func: Callable) -> Callable:
            self.tools[name] = func
            return func

        return decorator


def make_box(left, top, right, bottom):
    return BoundingBox(
        left=left, top=top, right=right, bottom=bottom, width=right - left, height=bottom - top
    )


def make_desktop() -> Desktop:
    desktop = Desktop.__new__(Desktop)
    desktop.desktop_state = DesktopState(
        active_desktop={"name": "Desktop 1"},
        all_desktops=[],
        active_window=None,
        windows=[],
        tree_state=TreeState(
            interactive_nodes=[
                TreeElementNode(
                    bounding_box=make_box(0, 0, 20, 20),
                    center=Center(x=10, y=10),
                    name="Button 1",
                    control_type="Button",
                    window_name="Notepad",
                ),
            ],
            scrollable_nodes=[],
        ),
    )
    return desktop


def make_tools(desktop: Desktop) -> dict[str, Callable]:
    mcp = FakeMCP()
    register_input(mcp, get_desktop=lambda: desktop, get_analytics=lambda: None)
    return mcp.tools


def run(tool: Callable, **kwargs):
    return asyncio.run(tool(**kwargs))


# ---- modifiers argument coercion -------------------------------------------


def test_as_str_list_accepts_plus_separated_string():
    assert _as_str_list("ctrl+shift", "modifiers") == ["ctrl", "shift"]


def test_as_str_list_accepts_json_string():
    assert _as_str_list('["ctrl"]', "modifiers") == ["ctrl"]


def test_as_str_list_rejects_garbage():
    with pytest.raises(ValueError, match="modifiers"):
        _as_str_list(17, "modifiers")


# ---- desktop.click: timing, modifiers, down/up ------------------------------


def test_desktop_click_double_middle_honors_double_click_time(monkeypatch):
    desktop = make_desktop()
    monkeypatch.setattr(service.uia, "GetDoubleClickTime", lambda: 500)
    middle_calls = []

    def middle_click(x, y, waitTime=0.5):
        middle_calls.append((x, y, waitTime))

    monkeypatch.setattr(service.uia, "MiddleClick", middle_click)

    desktop.click((5, 6), button="middle", clicks=2)

    # The gap between the two clicks must be HALF the double-click budget
    # (GetDoubleClickTime()/2000), not OPERATION_WAIT_TIME (0.5s) — the old
    # code spaced middle/right clicks wider than the OS grouping window, so
    # CAD's double-middle-click Zoom Extents never registered.
    assert [wait for _, _, wait in middle_calls] == [0.25, 0.5]


def test_desktop_click_right_double_uses_same_timing(monkeypatch):
    desktop = make_desktop()
    monkeypatch.setattr(service.uia, "GetDoubleClickTime", lambda: 400)
    right_calls = []
    monkeypatch.setattr(
        service.uia,
        "RightClick",
        lambda x, y, waitTime=0.5: right_calls.append(waitTime),
    )

    desktop.click((1, 2), button="right", clicks=2)

    assert right_calls == [0.2, 0.5]


def test_desktop_click_with_modifiers_holds_and_releases(monkeypatch):
    desktop = make_desktop()
    events: list[tuple] = []
    monkeypatch.setattr(
        service.uia,
        "Click",
        lambda x, y, waitTime=0.5: events.append(("click", x, y)),
    )
    monkeypatch.setattr(
        service.uia,
        "PressKey",
        lambda key, waitTime=0.05: events.append(("press", key)),
    )
    monkeypatch.setattr(
        service.uia,
        "ReleaseKey",
        lambda key, waitTime=0.05: events.append(("release", key)),
    )

    desktop.click((3, 4), modifiers=["ctrl", "shift"])

    assert events == [
        ("press", service.uia.Keys.VK_CONTROL),
        ("press", service.uia.Keys.VK_SHIFT),
        ("click", 3, 4),
        ("release", service.uia.Keys.VK_SHIFT),
        ("release", service.uia.Keys.VK_CONTROL),
    ]


def test_desktop_click_rejects_unknown_modifier():
    desktop = make_desktop()
    with pytest.raises(ValueError, match="Unknown modifier"):
        desktop.click((1, 2), modifiers=["hyper"])


def test_desktop_click_down_up_lifecycle(monkeypatch):
    desktop = make_desktop()
    events: list[tuple] = []
    monkeypatch.setattr(
        service.uia, "PressMouse", lambda x, y, waitTime=0.5: events.append(("down", x, y))
    )
    monkeypatch.setattr(service.uia, "ReleaseMouse", lambda waitTime=0.5: events.append(("up",)))
    monkeypatch.setattr(
        service.uia,
        "MiddleReleaseMouse",
        lambda waitTime=0.5: events.append(("middle-up",)),
    )
    monkeypatch.setattr(service.uia, "SetCursorPos", lambda x, y: events.append(("move", x, y)))

    desktop.click((7, 8), action="down")
    desktop.click(None, button="middle", action="up")

    assert events == [("down", 7, 8), ("middle-up",)]


def test_desktop_safe_release_releases_only_tracked_mouse_button(monkeypatch):
    desktop = make_desktop()
    desktop._held_mouse_buttons = set()
    desktop._held_modifier_keys = set()
    events: list[str] = []
    monkeypatch.setattr(
        service.uia,
        "RightPressMouse",
        lambda x, y, waitTime=0.5: events.append("right-down"),
    )
    monkeypatch.setattr(
        service.uia,
        "RightReleaseMouse",
        lambda waitTime=0.5: events.append("right-up"),
    )
    monkeypatch.setattr(
        service.uia,
        "ReleaseMouse",
        lambda waitTime=0.5: events.append("left-up"),
    )

    desktop.click((7, 8), button="right", action="down")
    desktop.safe_release_input()

    assert events == ["right-down", "right-up"]
    assert desktop._held_mouse_buttons == set()


# ---- Click tool surface ------------------------------------------------------


def test_click_tool_passes_modifiers_and_window(monkeypatch):
    desktop = make_desktop()
    focus_calls: list[str] = []
    monkeypatch.setattr(
        desktop, "focus_window", lambda name: focus_calls.append(name) or f"Focused {name}."
    )
    monkeypatch.setattr(desktop, "click_hit_note", lambda x, y: "")
    click_mock = MagicMock()
    monkeypatch.setattr(desktop, "click", click_mock)
    tools = make_tools(desktop)

    result = run(tools["Click"], loc=[10, 10], modifiers="ctrl", window="AutoCAD")

    assert result == "Focused AutoCAD.Single left clicked at (10,10) with ctrl."
    assert focus_calls == ["AutoCAD"]
    click_mock.assert_called_once_with(
        loc=[10, 10],
        button="left",
        clicks=1,
        modifiers=["ctrl"],
        action="click",
        hold_seconds=None,
    )


def test_click_tool_action_up_needs_no_loc(monkeypatch):
    desktop = make_desktop()
    click_mock = MagicMock()
    monkeypatch.setattr(desktop, "click", click_mock)
    tools = make_tools(desktop)

    result = run(tools["Click"], action="up", button="left")

    assert "Released left mouse button" in result
    click_mock.assert_called_once_with(
        loc=None, button="left", clicks=1, modifiers=None, action="up", hold_seconds=None
    )


def test_click_tool_still_requires_a_target_for_clicks():
    desktop = make_desktop()
    tools = make_tools(desktop)
    with pytest.raises(ValueError, match="loc, label, or element"):
        run(tools["Click"])


# ---- Type: focused mode, interval, IME note ---------------------------------


def test_desktop_type_without_loc_does_not_click(monkeypatch):
    desktop = make_desktop()
    click_mock = MagicMock()
    send_mock = MagicMock()
    monkeypatch.setattr(service.uia, "Click", click_mock)
    monkeypatch.setattr(service.uia, "SendKeys", send_mock)

    desktop.type(None, "ZOOM", interval=0.08)

    assert click_mock.call_count == 0
    assert send_mock.call_count == 1
    args, kwargs = send_mock.call_args
    assert kwargs["interval"] == 0.08


def test_desktop_type_with_loc_clicks_first(monkeypatch):
    desktop = make_desktop()
    click_mock = MagicMock()
    monkeypatch.setattr(service.uia, "Click", click_mock)
    monkeypatch.setattr(service.uia, "SendKeys", MagicMock())

    desktop.type((9, 9), "hi")

    click_mock.assert_called_once_with(9, 9)


def test_escape_text_converts_newlines_to_enter():
    assert service._escape_text_for_sendkeys("line1\nline2") == "line1{Enter}line2"


def test_type_tool_focused_mode_reports_focus_and_ime(monkeypatch):
    desktop = make_desktop()
    type_mock = MagicMock()
    monkeypatch.setattr(desktop, "type", type_mock)
    monkeypatch.setattr(
        desktop,
        "keyboard_layout",
        lambda: {"layout_id": "00000804", "is_english": False, "ime_open": True},
    )
    tools = make_tools(desktop)

    result = run(tools["Type"], text="LINE")

    # WCC-P0-01: the typed text is never echoed; the IME warning stays.
    assert "Typed 4 character(s) into the focused control." in result
    assert "LINE" not in result
    assert "Warning: non-English keyboard layout" in result
    assert "IME open" in result
    type_mock.assert_called_once_with(
        loc=None,
        text="LINE",
        caret_position="idle",
        clear=False,
        press_enter=False,
        interval=None,
    )


def test_type_tool_no_ime_note_for_english_layout(monkeypatch):
    desktop = make_desktop()
    monkeypatch.setattr(desktop, "type", MagicMock())
    monkeypatch.setattr(
        desktop, "keyboard_layout", lambda: {"layout_id": "00000409", "is_english": True}
    )
    tools = make_tools(desktop)

    result = run(tools["Type"], text="hi", loc=[10, 10])

    assert result == "Typed 2 character(s) at (10,10)."


def test_type_tool_validates_interval():
    desktop = make_desktop()
    tools = make_tools(desktop)
    with pytest.raises(ValueError, match="interval"):
        run(tools["Type"], text="hi", interval=2.0)


# ---- Type: sensitive output policy (WCC-P0-01) --------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "hunter2 password",  # ASCII secret
        "密码123456",  # non-ASCII secret
        "multi\nline\ntoken",  # newline-containing secret
        "ghp_abc123Def456Ghi789JKL",  # token-like secret
    ],
)
def test_type_tool_never_echoes_text(monkeypatch, text):
    desktop = make_desktop()
    monkeypatch.setattr(desktop, "type", MagicMock())
    monkeypatch.setattr(
        desktop, "keyboard_layout", lambda: {"layout_id": "00000409", "is_english": True}
    )
    tools = make_tools(desktop)

    result = run(tools["Type"], text=text)

    assert text not in result
    for fragment in text.split():
        assert fragment not in result


def test_type_tool_reports_char_count_only(monkeypatch):
    desktop = make_desktop()
    monkeypatch.setattr(desktop, "type", MagicMock())
    monkeypatch.setattr(
        desktop, "keyboard_layout", lambda: {"layout_id": "00000409", "is_english": True}
    )
    tools = make_tools(desktop)

    result = run(tools["Type"], text="hello world")

    assert result.startswith("Typed 11 character(s) into the focused control.")


def test_focused_control_is_protected_true_for_password_field(monkeypatch):
    desktop = make_desktop()
    focused = SimpleNamespace(IsPassword=True)
    monkeypatch.setattr(service.uia, "GetFocusedControl", lambda: focused)

    assert desktop.focused_control_is_protected() is True


def test_focused_control_is_protected_false_for_plain_field(monkeypatch):
    desktop = make_desktop()
    focused = SimpleNamespace(IsPassword=False)
    monkeypatch.setattr(service.uia, "GetFocusedControl", lambda: focused)

    assert desktop.focused_control_is_protected() is False


def test_focused_control_is_protected_none_on_probe_failure(monkeypatch):
    desktop = make_desktop()

    def boom():
        raise OSError("COM unavailable")

    monkeypatch.setattr(service.uia, "GetFocusedControl", boom)
    assert desktop.focused_control_is_protected() is False


def test_focused_control_is_protected_false_without_control(monkeypatch):
    desktop = make_desktop()
    monkeypatch.setattr(service.uia, "GetFocusedControl", lambda: None)
    assert desktop.focused_control_is_protected() is False


def test_type_tool_password_field_withholds_all_content_facts(monkeypatch):
    desktop = make_desktop()
    monkeypatch.setattr(desktop, "type", MagicMock())
    monkeypatch.setattr(desktop, "focused_control_is_protected", lambda: True)
    tools = make_tools(desktop)

    secret = "hunter2"
    result = run(tools["Type"], text=secret)

    # No value, no length, no character-class facts: nothing to correlate.
    assert secret not in result
    assert "7" not in result
    assert "character" not in result
    assert "protected field" in result


def test_type_tool_password_check_runs_before_dispatch(monkeypatch):
    """The IsPassword probe must be read BEFORE desktop.type injects keys,
    so the classification can never race the typing."""
    desktop = make_desktop()
    order: list[str] = []

    def record_type(**kwargs):
        order.append("type")

    monkeypatch.setattr(desktop, "type", record_type)
    monkeypatch.setattr(desktop, "keyboard_layout", lambda: {"is_english": True})

    def record_probe():
        order.append("probe")
        return False

    monkeypatch.setattr(desktop, "focused_control_is_protected", record_probe)
    tools = make_tools(desktop)

    run(tools["Type"], text="x")

    assert order == ["probe", "type"]


# ---- Scroll: wheel delta -----------------------------------------------------


def test_desktop_scroll_passes_wheel_delta(monkeypatch):
    desktop = make_desktop()
    calls: list[tuple] = []
    monkeypatch.setattr(
        service.uia,
        "WheelUp",
        lambda times, delta=120: calls.append(("up", times, delta)),
    )

    desktop.scroll(None, "vertical", "up", 2, wheel_delta=30)

    assert calls == [("up", 2, 30)]


def test_scroll_tool_rejects_out_of_range_delta():
    desktop = make_desktop()
    tools = make_tools(desktop)
    with pytest.raises(ValueError, match="wheel_delta"):
        run(tools["Scroll"], loc=[1, 2], wheel_delta=500)


def test_scroll_tool_reports_custom_delta(monkeypatch):
    desktop = make_desktop()
    monkeypatch.setattr(desktop, "scroll", lambda *a, **k: None)
    tools = make_tools(desktop)

    result = run(tools["Scroll"], loc=[5, 5], direction="up", wheel_delta=30)

    assert "delta 30/notch" in result


# ---- Move: right / middle drag -----------------------------------------------


def test_move_tool_right_drag(monkeypatch):
    desktop = make_desktop()
    drag_mock = MagicMock(
        return_value={"start": [1, 2], "end": [3, 4], "duration": None, "button": "right"}
    )
    monkeypatch.setattr(desktop, "drag", drag_mock)
    tools = make_tools(desktop)

    result = run(tools["Move"], loc=[3, 4], from_loc=[1, 2], drag=True, button="right")

    assert "with the right button" in result
    drag_mock.assert_called_once_with([3, 4], from_loc=[1, 2], duration=None, button="right")


def test_move_tool_button_requires_drag():
    desktop = make_desktop()
    tools = make_tools(desktop)
    with pytest.raises(ValueError, match="button requires drag"):
        run(tools["Move"], loc=[1, 2], button="middle")


# ---- focus_window -------------------------------------------------------------


def test_desktop_focus_window_restores_minimized(monkeypatch):
    desktop = make_desktop()
    window = SimpleNamespace(name="Drawing1.dwg - AutoCAD", handle=4242)
    monkeypatch.setattr(
        desktop,
        "_find_window_by_name",
        lambda name, refresh_state: (window, ""),
    )
    monkeypatch.setattr(service.uia, "IsIconic", lambda handle: True)
    bring_mock = MagicMock()
    monkeypatch.setattr(desktop, "bring_window_to_top", bring_mock)
    verify_mock = MagicMock(return_value=True)
    monkeypatch.setattr(desktop, "verify_foreground_window", verify_mock)

    message = desktop.focus_window("acad")

    assert "Restored" in message
    bring_mock.assert_called_once_with(4242)
    verify_mock.assert_called_once_with(4242, None)


def test_desktop_focus_window_fails_when_foreground_readback_disagrees(monkeypatch):
    desktop = make_desktop()
    window = SimpleNamespace(name="Drawing1.dwg - AutoCAD", handle=4242, process_id=99)
    monkeypatch.setattr(
        desktop,
        "_find_window_by_name",
        lambda name, refresh_state: (window, ""),
    )
    monkeypatch.setattr(service.uia, "IsIconic", lambda handle: False)
    monkeypatch.setattr(desktop, "bring_window_to_top", MagicMock())
    monkeypatch.setattr(desktop, "verify_foreground_window", lambda handle, pid: False)

    with pytest.raises(RuntimeError, match="Focus verification failed"):
        desktop.focus_window("acad")


def test_desktop_focus_window_raises_when_not_found(monkeypatch):
    desktop = make_desktop()
    monkeypatch.setattr(
        desktop,
        "_find_window_by_name",
        lambda name, refresh_state: (None, "Application Acad not found."),
    )
    with pytest.raises(ValueError, match="not found"):
        desktop.focus_window("acad")


# ---- keyboard_layout ------------------------------------------------------------


class _FakeBuffer:
    def __init__(self, value: str) -> None:
        self.value = value


def _fake_ctypes(hkl: int, layout_name: str, ime_open: bool | None):
    return SimpleNamespace(
        windll=_fake_windll(hkl, layout_name, ime_open),
        create_unicode_buffer=_FakeBuffer,
    )


def _fake_windll(hkl: int, layout_name: str, ime_open: bool | None):
    user32 = SimpleNamespace()

    def get_window_thread_process_id(handle, _pid):
        return 4321

    def get_keyboard_layout(thread_id):
        return hkl

    def get_keyboard_layout_name_w(buffer):
        buffer.value = layout_name
        return True

    user32.GetWindowThreadProcessId = get_window_thread_process_id
    user32.GetKeyboardLayout = get_keyboard_layout
    user32.GetKeyboardLayoutNameW = get_keyboard_layout_name_w

    imm32 = None
    if ime_open is not None:
        def get_context(handle):
            return 0x1

        def get_open_status(_himc):
            return 1 if ime_open else 0

        def release_context(handle, himc):
            return True

        imm32 = SimpleNamespace(
            ImmGetContext=get_context,
            ImmGetOpenStatus=get_open_status,
            ImmReleaseContext=release_context,
        )
    return SimpleNamespace(user32=user32, imm32=imm32)


def test_keyboard_layout_detects_chinese_ime(monkeypatch):
    monkeypatch.setattr(service.uia, "GetForegroundWindow", lambda: 1234)
    monkeypatch.setattr(service, "ctypes", _fake_ctypes(0x08040804, "00000804", True))

    layout = Desktop.keyboard_layout(Desktop.__new__(Desktop))

    assert layout["is_english"] is False
    assert layout["layout_id"] == "00000804"
    assert layout["ime_open"] is True


def test_keyboard_layout_english_skips_ime_probe(monkeypatch):
    monkeypatch.setattr(service.uia, "GetForegroundWindow", lambda: 1234)
    monkeypatch.setattr(service, "ctypes", _fake_ctypes(0x04090409, "00000409", None))

    layout = Desktop.keyboard_layout(Desktop.__new__(Desktop))

    assert layout["is_english"] is True
    assert layout["ime_open"] is None


def test_keyboard_layout_never_raises(monkeypatch):
    def boom(*args, **kwargs):
        raise OSError("nope")

    monkeypatch.setattr(service.uia, "GetForegroundWindow", boom)
    layout = Desktop.keyboard_layout(Desktop.__new__(Desktop))
    assert layout["is_english"] is None
    assert "error" in layout


# ---- ocr_region ------------------------------------------------------------------


def _fake_ps_executor(output: str, status: int = 0):
    class FakeExecutor:
        @staticmethod
        def execute_command(command, timeout=10, shell=None):
            FakeExecutor.command = command
            FakeExecutor.shell = shell
            return output, status

    return FakeExecutor


@pytest.fixture()
def tiny_image(monkeypatch):
    from PIL import Image

    image = Image.new("RGB", (40, 20), color="white")

    def fake_screenshot(self, capture_rect=None):
        return image.copy()

    monkeypatch.setattr(Desktop, "get_screenshot", fake_screenshot)
    return image


def test_ocr_region_parses_marker_output(monkeypatch, tiny_image):
    monkeypatch.setattr(
        "windows_mcp.desktop.ocr_backend.PowerShellExecutor",
        _fake_ps_executor(
            "some preamble\n__OCR_LANG_TAG__=en-US\n__OCR_TEXT__\nCommand: ZOOM\nSpecify corner: "
        ),
    )

    result = Desktop.ocr_region(
        Desktop.__new__(Desktop), region=[10, 20, 110, 70], scale_up=2.0
    )

    assert result["text"] == "Command: ZOOM\nSpecify corner:"
    assert result["engine_available"] is True
    assert result["language"] == "en-US"
    assert result["image_size"] == [80, 40]
    assert result["region"] == [10, 20, 110, 70]


def test_ocr_region_reports_missing_engine(monkeypatch, tiny_image):
    monkeypatch.setattr(
        "windows_mcp.desktop.ocr_backend.PowerShellExecutor",
        _fake_ps_executor("__OCR_UNAVAILABLE__\n"),
    )

    result = Desktop.ocr_region(Desktop.__new__(Desktop))

    assert result["engine_available"] is False
    assert result["text"] == ""


def test_ocr_region_raises_on_command_failure(monkeypatch, tiny_image):
    monkeypatch.setattr(
        "windows_mcp.desktop.ocr_backend.PowerShellExecutor",
        _fake_ps_executor("boom", status=1),
    )
    with pytest.raises(RuntimeError, match="OCR command failed"):
        Desktop.ocr_region(Desktop.__new__(Desktop))


def test_ocr_region_validates_scale_up():
    with pytest.raises(ValueError, match="scale_up"):
        Desktop.ocr_region(Desktop.__new__(Desktop), scale_up=9)


# ---- live element fallback (native file dialogs) --------------------------------


class FakeUIAControl:
    def __init__(self, name: str, control_type: str, children: list, rect=None):
        self.Name = name
        self.ControlTypeName = control_type
        self._children = children
        self.BoundingRectangle = rect or _fake_rect(0, 0, 100, 100)

    def GetChildren(self):
        return self._children


def _fake_rect(left, top, right, bottom):
    return SimpleNamespace(
        left=left,
        top=top,
        right=right,
        bottom=bottom,
        isempty=lambda: False,
        width=lambda: right - left,
        height=lambda: bottom - top,
    )


def test_live_element_match_finds_dialog_list_item(monkeypatch):
    desktop = make_desktop()
    item = FakeUIAControl(
        "acadiso.dwt",
        "ListItemControl",
        [],
        rect=_fake_rect(300, 200, 500, 224),
    )
    root = FakeUIAControl("Select Template", "WindowControl", [item])
    monkeypatch.setattr(service.uia, "GetForegroundWindow", lambda: 999)
    monkeypatch.setattr(service.uia, "ControlFromHandle", lambda handle: root)

    center = desktop._live_element_match("acadiso.dwt")

    assert center == (400, 212)


def test_get_coordinates_from_element_falls_back_to_live_search(monkeypatch):
    desktop = make_desktop()
    monkeypatch.setattr(desktop, "_live_element_match", lambda element: (400, 212))

    assert desktop.get_coordinates_from_element("acadiso.dwt") == (400, 212)


def test_live_element_match_returns_none_when_no_window(monkeypatch):
    desktop = make_desktop()
    monkeypatch.setattr(service.uia, "GetForegroundWindow", lambda: 0)
    assert desktop._live_element_match("anything") is None
