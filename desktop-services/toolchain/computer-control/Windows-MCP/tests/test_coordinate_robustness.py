"""Tests for the stress-test coordinate-robustness fixes:

High priority
- loc/label/element resolution priority: loc always wins, a fuzzy element=
  match can never hijack a calibrated coordinate.
- element-name ambiguity detection (same-name multi nodes, near-tie scores).
- coordinate_space='screenshot' conversion (image pixel -> screen pixel).
- Screenshot/Snapshot metadata exposes per-display DPI and coordinate systems.
- Click hit feedback: window-under-point + outside-foreground warning.

Medium priority
- Type auto-routes non-ASCII text through the clipboard to bypass the IME.
- Move reports the actual cursor landing position (calibration aid).

Low priority
- OCR default scale_up=2.
- Click hold_seconds long-press in one call.
- Region out-of-bounds errors list display bounds; partial overflow clips.
"""

import asyncio
from collections.abc import Callable
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from windows_mcp.desktop import service
from windows_mcp.desktop.service import Desktop
from windows_mcp.desktop.views import DesktopState, Display
from windows_mcp.tools import _snapshot_helpers
from windows_mcp.tools.input import register as register_input
from windows_mcp.tools.ocr import register as register_ocr
from windows_mcp.runtime.results import DispatchStatus, EffectStatus
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


def make_desktop():
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


def make_tools(desktop):
    mcp = FakeMCP()
    register_input(mcp, get_desktop=lambda: desktop, get_analytics=lambda: None)
    return mcp.tools


def run(tool: Callable, **kwargs):
    return asyncio.run(tool(**kwargs))


def make_screenshot_desktop():
    """Desktop with a downscaled region screenshot so image->screen conversion works."""
    desktop = Desktop.__new__(Desktop)
    desktop.desktop_state = DesktopState(
        active_desktop={"name": "Desktop 1"},
        all_desktops=[],
        active_window=None,
        windows=[],
        screenshot_scale=0.5,
        screenshot_region=make_box(100, 200, 2100, 1200),
        tree_state=TreeState(interactive_nodes=[], scrollable_nodes=[]),
    )
    return desktop


# ---- P0-1: loc/label/element priority --------------------------------------


def test_click_loc_wins_over_element(monkeypatch):
    desktop = make_desktop()
    monkeypatch.setattr(desktop, "click_hit_note", lambda x, y: "")
    click_mock = MagicMock()
    monkeypatch.setattr(desktop, "click", click_mock)
    tools = make_tools(desktop)

    # element='definitely not present' must NOT be resolved when loc= is given.
    result = run(tools["Click"], loc=[5, 6], element="nope")

    assert "clicked at (5,6)" in result
    click_mock.assert_called_once_with(
        loc=[5, 6], button="left", clicks=1, modifiers=None, action="click", hold_seconds=None
    )


def test_click_loc_wins_over_label(monkeypatch):
    desktop = make_desktop()
    monkeypatch.setattr(desktop, "click_hit_note", lambda x, y: "")
    click_mock = MagicMock()
    monkeypatch.setattr(desktop, "click", click_mock)
    tools = make_tools(desktop)

    run(tools["Click"], loc=[7, 8], label=0)

    click_mock.assert_called_once_with(
        loc=[7, 8], button="left", clicks=1, modifiers=None, action="click", hold_seconds=None
    )


def test_click_records_an_accepted_unknown_action_result(monkeypatch):
    desktop = make_desktop()
    monkeypatch.setattr(desktop, "click_hit_note", lambda x, y: "")
    monkeypatch.setattr(desktop, "click", MagicMock())
    tools = make_tools(desktop)

    legacy_text = run(tools["Click"], loc=[7, 8])
    result = desktop.last_action_result()

    assert legacy_text == "Single left clicked at (7,8)."
    assert result is not None
    assert result.dispatch is DispatchStatus.ACCEPTED
    assert result.effect is EffectStatus.UNKNOWN_OUTCOME
    assert result.retry_safe is False
    assert result.requires_fresh_observation is True
    assert result.target_receipt.description == "click on screen point (7,8)"


def test_type_loc_wins_over_element(monkeypatch):
    desktop = make_desktop()
    type_mock = MagicMock()
    monkeypatch.setattr(desktop, "type", type_mock)
    monkeypatch.setattr(
        desktop, "keyboard_layout", lambda: {"layout_id": "00000409", "is_english": True}
    )
    tools = make_tools(desktop)

    run(tools["Type"], text="hi", loc=[3, 4], element="nope")

    type_mock.assert_called_once_with(
        loc=[3, 4],
        text="hi",
        caret_position="idle",
        clear=False,
        press_enter=False,
        interval=None,
    )


def test_move_loc_wins_over_element(monkeypatch):
    desktop = make_desktop()
    move_mock = MagicMock()
    monkeypatch.setattr(desktop, "move", move_mock)
    monkeypatch.setattr(desktop, "get_cursor_location", lambda: (9, 9))
    tools = make_tools(desktop)

    run(tools["Move"], loc=[9, 9], element="nope")

    move_mock.assert_called_once_with([9, 9])


def test_scroll_loc_wins_over_element(monkeypatch):
    desktop = make_desktop()
    scroll_mock = MagicMock(return_value=None)
    monkeypatch.setattr(desktop, "scroll", scroll_mock)
    tools = make_tools(desktop)

    result = run(tools["Scroll"], loc=[1, 2], element="nope")

    assert "at (1,2)" in result
    scroll_mock.assert_called_once_with([1, 2], "vertical", "down", 1, wheel_delta=120)


# ---- P0-1: element ambiguity detection --------------------------------------


def test_get_coordinates_from_element_raises_on_same_name_nodes(monkeypatch):
    desktop = Desktop.__new__(Desktop)
    desktop.desktop_state = DesktopState(
        active_desktop={},
        all_desktops=[],
        active_window=None,
        windows=[],
        tree_state=TreeState(
            interactive_nodes=[
                TreeElementNode(
                    bounding_box=make_box(0, 0, 20, 20),
                    center=Center(x=10, y=10),
                    name="发送文件",
                    control_type="Button",
                    window_name="WeChat",
                ),
                TreeElementNode(
                    bounding_box=make_box(60, 60, 80, 80),
                    center=Center(x=70, y=70),
                    name="发送文件",
                    control_type="Button",
                    window_name="WeChat",
                ),
            ],
            scrollable_nodes=[],
        ),
    )
    monkeypatch.setattr(desktop, "_live_element_match", lambda element: None)

    with pytest.raises(ValueError, match="matched 2 nodes named"):
        desktop.get_coordinates_from_element("发送文件")


def test_get_coordinates_from_element_raises_on_tie_scores(monkeypatch):
    # Stress-test scenario: element='发送文件按钮' ties 发送文件 and 文件 at 90/90
    # and would silently pick whichever the matcher ranked first.
    desktop = Desktop.__new__(Desktop)
    desktop.desktop_state = DesktopState(
        active_desktop={},
        all_desktops=[],
        active_window=None,
        windows=[],
        tree_state=TreeState(
            interactive_nodes=[
                TreeElementNode(
                    bounding_box=make_box(0, 0, 20, 20),
                    center=Center(x=10, y=10),
                    name="发送文件",
                    control_type="Button",
                    window_name="WeChat",
                ),
                TreeElementNode(
                    bounding_box=make_box(20, 20, 60, 60),
                    center=Center(x=40, y=40),
                    name="文件",
                    control_type="Button",
                    window_name="WeChat",
                ),
                TreeElementNode(
                    bounding_box=make_box(60, 60, 80, 80),
                    center=Center(x=70, y=70),
                    name="微信",
                    control_type="Button",
                    window_name="WeChat",
                ),
            ],
            scrollable_nodes=[],
        ),
    )
    monkeypatch.setattr(desktop, "_live_element_match", lambda element: None)

    with pytest.raises(ValueError, match="ambiguous"):
        desktop.get_coordinates_from_element("发送文件按钮")


def test_get_coordinates_from_element_unique_match_still_works():
    desktop = make_desktop()
    assert desktop.get_coordinates_from_element("Button 1") == (10, 10)


# ---- P0-2: coordinate_space conversion --------------------------------------


def test_image_to_screen_uses_scale_and_region_offset():
    desktop = make_screenshot_desktop()
    # 0.5 scale, region origin (100, 200): image (200, 150) -> (100+400, 200+300)
    assert desktop.image_to_screen(200, 150) == (500, 500)


def test_image_to_screen_identity_without_screenshot_state():
    desktop = make_desktop()
    assert desktop.image_to_screen(200, 150) == (200, 150)


def test_click_coordinate_space_screenshot_converts_and_notes(monkeypatch):
    desktop = make_screenshot_desktop()
    monkeypatch.setattr(desktop, "click_hit_note", lambda x, y: "")
    click_mock = MagicMock()
    monkeypatch.setattr(desktop, "click", click_mock)
    tools = make_tools(desktop)

    result = run(tools["Click"], loc=[200, 150], coordinate_space="screenshot")

    assert "image pixel (200,150) -> screen (500,500)" in result
    click_mock.assert_called_once_with(
        loc=[500, 500], button="left", clicks=1, modifiers=None, action="click", hold_seconds=None
    )


def test_coordinate_space_screenshot_requires_screenshot_state(monkeypatch):
    desktop = make_desktop()  # no screenshot_scale
    monkeypatch.setattr(desktop, "click_hit_note", lambda x, y: "")
    monkeypatch.setattr(desktop, "click", MagicMock())
    tools = make_tools(desktop)

    with pytest.raises(ValueError, match="coordinate_space='screenshot'"):
        run(tools["Click"], loc=[200, 150], coordinate_space="screenshot")


def test_snapshot_label_is_already_screen_space_and_is_not_converted(monkeypatch):
    desktop = make_screenshot_desktop()
    monkeypatch.setattr(
        desktop,
        "get_coordinates_from_snapshot_ref",
        lambda snapshot_id, **target: (500, 500),
    )
    convert = MagicMock(side_effect=AssertionError("must not convert a resolved label"))
    monkeypatch.setattr(desktop, "snapshot_image_to_screen", convert)
    monkeypatch.setattr(desktop, "mark_snapshot_mutated", MagicMock())
    monkeypatch.setattr(desktop, "click_hit_note", lambda x, y: "")
    click_mock = MagicMock()
    monkeypatch.setattr(desktop, "click", click_mock)
    tools = make_tools(desktop)

    run(
        tools["Click"],
        label=0,
        snapshot_id="snapshot-1",
        coordinate_space="screenshot",
    )

    convert.assert_not_called()
    click_mock.assert_called_once_with(
        loc=[500, 500],
        button="left",
        clicks=1,
        modifiers=None,
        action="click",
        hold_seconds=None,
    )


def test_snapshot_coordinate_uses_the_bound_frame_not_latest_state(monkeypatch):
    desktop = make_screenshot_desktop()
    convert = MagicMock(return_value=(901, 702))
    monkeypatch.setattr(desktop, "snapshot_image_to_screen", convert)
    monkeypatch.setattr(desktop, "mark_snapshot_mutated", MagicMock())
    monkeypatch.setattr(desktop, "click_hit_note", lambda x, y: "")
    click_mock = MagicMock()
    monkeypatch.setattr(desktop, "click", click_mock)
    tools = make_tools(desktop)

    run(
        tools["Click"],
        loc=[11, 12],
        snapshot_id="snapshot-1",
        coordinate_space="screenshot",
    )

    convert.assert_called_once_with("snapshot-1", 11, 12)
    click_mock.assert_called_once_with(
        loc=[901, 702],
        button="left",
        clicks=1,
        modifiers=None,
        action="click",
        hold_seconds=None,
    )


# ---- P0-3: click hit feedback ------------------------------------------------


class _FakeRect:
    def __init__(self, left, top, right, bottom):
        self.left, self.top, self.right, self.bottom = left, top, right, bottom

    def contains(self, x, y):
        return self.left <= x < self.right and self.top <= y < self.bottom


def test_click_hit_note_reports_landing_window(monkeypatch):
    desktop = make_desktop()
    monkeypatch.setattr(service.uia, "WindowFromPoint", lambda x, y: 111)
    monkeypatch.setattr(service.uia, "GetForegroundWindow", lambda: 222)
    monkeypatch.setattr(service.uia, "GetAncestor", lambda handle, flag: 111)
    monkeypatch.setattr(service.win32gui, "IsWindow", lambda handle: True)
    monkeypatch.setattr(
        service.uia, "GetWindowText",
        lambda handle: "Minesweeper" if handle == 222 else "Cell (5,7)",
    )
    monkeypatch.setattr(
        service.uia, "GetWindowRect", lambda handle: _FakeRect(0, 0, 800, 600)
    )

    note = desktop.click_hit_note(400, 300)

    assert "Landed on" in note
    assert "Minesweeper" in note
    assert "WARNING" not in note


def test_click_hit_note_warns_when_outside_foreground(monkeypatch):
    desktop = make_desktop()
    monkeypatch.setattr(service.uia, "WindowFromPoint", lambda x, y: 333)
    monkeypatch.setattr(service.uia, "GetForegroundWindow", lambda: 222)
    monkeypatch.setattr(service.uia, "GetAncestor", lambda handle, flag: 333)
    monkeypatch.setattr(service.win32gui, "IsWindow", lambda handle: True)
    monkeypatch.setattr(
        service.uia, "GetWindowText",
        lambda handle: "Minesweeper" if handle == 222 else "Trylo",
    )
    monkeypatch.setattr(
        service.uia, "GetWindowRect", lambda handle: _FakeRect(0, 0, 800, 600)
    )

    note = desktop.click_hit_note(1000, 300)

    assert "WARNING" in note
    assert "OUTSIDE" in note
    assert "Trylo" in note


def test_click_hit_note_never_raises(monkeypatch):
    desktop = make_desktop()

    def boom(*args, **kwargs):
        raise OSError("no")

    monkeypatch.setattr(service.uia, "WindowFromPoint", boom)

    assert desktop.click_hit_note(1, 2) == ""


# ---- P1-5: Type non-ASCII clipboard bypass -----------------------------------


def test_desktop_type_non_ascii_uses_clipboard_instead_of_sendkeys(monkeypatch):
    desktop = make_desktop()
    events: list[tuple] = []
    monkeypatch.setattr(
        service.uia, "GetClipboardText", lambda: "previous"
    )
    monkeypatch.setattr(
        service.uia, "SetClipboardText",
        lambda text: events.append(("set", text)) or True,
    )
    monkeypatch.setattr(
        service.uia, "SendKeys",
        lambda text, interval=0.01, waitTime=0.5: events.append(("keys", text)),
    )
    monkeypatch.setattr(service, "sleep", lambda s: None)

    desktop.type(None, "你好，世界")

    assert ("set", "你好，世界") in events
    assert ("keys", "{Ctrl}v") in events
    # The literal characters must never ride SendKeys into the IME.
    assert not any("你" in text for kind, text in events if kind == "keys")


def test_type_tool_notes_clipboard_routing_for_non_ascii(monkeypatch):
    desktop = make_desktop()
    monkeypatch.setattr(desktop, "type", MagicMock())
    tools = make_tools(desktop)

    result = run(tools["Type"], text="你好")

    assert "Auto-routed through the clipboard (Ctrl+V) to bypass the IME" in result
    assert "你好" not in result  # WCC-P0-01: text is never echoed back
    assert "Warning" not in result


# ---- P1-7: Move reports actual cursor landing position -----------------------


def test_move_tool_reports_actual_cursor_position(monkeypatch):
    desktop = make_desktop()
    move_mock = MagicMock()
    monkeypatch.setattr(desktop, "move", move_mock)
    monkeypatch.setattr(desktop, "get_cursor_location", lambda: (80, 80))
    tools = make_tools(desktop)

    result = run(tools["Move"], loc=[80, 80])

    assert "Moved the mouse pointer to (80,80)" in result
    assert "actual cursor position (80,80)" in result


def test_move_tool_warns_when_landing_differs(monkeypatch):
    desktop = make_desktop()
    monkeypatch.setattr(desktop, "move", MagicMock())
    monkeypatch.setattr(desktop, "get_cursor_location", lambda: (700, 456))
    tools = make_tools(desktop)

    result = run(tools["Move"], loc=[1045, 808])

    assert "target and landing differ" in result
    assert "actual cursor position (700,456)" in result


def test_move_tool_legacy_message_when_readback_unavailable():
    class FakeDesktop:
        desktop_state = object()

        def move(self, loc):
            pass

    tools = make_tools(FakeDesktop())
    result = run(tools["Move"], loc=[10, 20])
    assert result == "Moved the mouse pointer to (10,20)."


# ---- P1: Click hold_seconds ---------------------------------------------------


def test_desktop_click_hold_seconds_press_dwell_release(monkeypatch):
    desktop = make_desktop()
    events: list[tuple] = []
    monkeypatch.setattr(
        service.uia, "PressMouse", lambda x, y, waitTime=0.5: events.append(("down", x, y))
    )
    monkeypatch.setattr(
        service.uia, "ReleaseMouse", lambda waitTime=0.5: events.append(("up",))
    )
    monkeypatch.setattr(service, "sleep", lambda s: events.append(("sleep", s)))

    desktop.click((7, 8), hold_seconds=1.5)

    assert events == [("down", 7, 8), ("sleep", 1.5), ("up",)]


def test_desktop_click_rejects_bad_hold_seconds():
    desktop = make_desktop()
    with pytest.raises(ValueError, match="hold_seconds"):
        desktop.click((1, 2), hold_seconds=20)


def test_click_tool_hold_seconds_message(monkeypatch):
    desktop = make_desktop()
    monkeypatch.setattr(desktop, "click_hit_note", lambda x, y: "")
    monkeypatch.setattr(desktop, "click", MagicMock())
    tools = make_tools(desktop)

    result = run(tools["Click"], loc=[5, 6], hold_seconds=1.5)

    assert "Held left for 1.5s at (5,6)" in result


# ---- P1: region bounds handling -----------------------------------------------


def test_region_out_of_bounds_lists_display_bounds(monkeypatch):
    desktop = Desktop.__new__(Desktop)
    monkeypatch.setattr(
        desktop,
        "get_screen_box",
        lambda: make_box(0, 0, 1920, 1080),
    )
    fake_display = SimpleNamespace(
        index=0, device_name="DISPLAY1", rect=service.uia.Rect(0, 0, 1920, 1080)
    )
    monkeypatch.setattr(desktop, "get_displays", lambda: [fake_display])

    with pytest.raises(ValueError) as excinfo:
        desktop.parse_region_selection([5000, 5000, 6000, 6000])

    message = str(excinfo.value)
    assert "does not overlap" in message
    assert "DISPLAY1" in message
    assert "left=0" in message


def test_region_partial_overflow_clips_to_screen(monkeypatch):
    desktop = Desktop.__new__(Desktop)
    monkeypatch.setattr(
        desktop,
        "get_screen_box",
        lambda: make_box(0, 0, 1920, 1080),
    )

    clipped = desktop.parse_region_selection([-100, -100, 100, 100])

    assert clipped.left == 0
    assert clipped.top == 0
    assert clipped.right == 100
    assert clipped.bottom == 100


# ---- P1: OCR default scale_up -------------------------------------------------


def test_ocr_tool_default_scale_up_is_2x():
    mcp = FakeMCP()
    desktop = MagicMock()
    desktop.ocr_region.return_value = {"text": "x"}
    register_ocr(mcp, get_desktop=lambda: desktop, get_analytics=lambda: None)

    run(mcp.tools["Ocr"], region=[0, 0, 10, 10])

    desktop.ocr_region.assert_called_once_with(region=[0, 0, 10, 10], scale_up=2.0, language=None)


def test_ocr_region_default_scale_up_is_2x(monkeypatch):
    from PIL import Image

    image = Image.new("RGB", (40, 20), color="white")
    monkeypatch.setattr(Desktop, "get_screenshot", lambda self, capture_rect=None: image.copy())

    class FakeExecutor:
        @staticmethod
        def execute_command(command, timeout=10, shell=None):
            return "__OCR_UNAVAILABLE__\n", 0

    monkeypatch.setattr(service, "PowerShellExecutor", FakeExecutor)

    result = Desktop.ocr_region(Desktop.__new__(Desktop))

    # 2x default: 40x20 -> 80x40
    assert result["image_size"] == [80, 40]


# ---- P0-2: Snapshot metadata reports DPI and coordinate systems -------------


def test_snapshot_metadata_reports_dpi_scaling_and_coordinate_systems():
    from windows_mcp.desktop.service import Size

    desktop_state = DesktopState(
        active_desktop={"name": "Desktop 1"},
        all_desktops=[],
        active_window=None,
        windows=[],
        screenshot_scale=0.75,
        screenshot_original_size=Size(width=1440, height=810),
        available_displays=[
            Display(
                index=0,
                device_name=r"\\.\DISPLAY1",
                bounding_box=make_box(0, 0, 1920, 1080),
                primary=True,
                effective_dpi=144,
                scale=1.5,
            )
        ],
    )
    result = _snapshot_helpers.build_snapshot_response(
        {
            "desktop_state": desktop_state,
            "interactive_elements": "",
            "scrollable_elements": "",
            "semantic_tree": "",
            "windows": "No windows found",
            "active_window": "No active window found",
            "active_desktop": "",
            "all_desktops": "",
            "screenshot_bytes": None,
        },
        include_ui_details=False,
    )

    text = result[0]
    assert "Display DPI Scaling: display 0: 144 DPI (1.5x)" in text
    assert "Coordinate systems:" in text
    assert "coordinate_space='screenshot'" in text
    # Downscaled image: coordinate scale must be stated explicitly.
    assert "Screenshot Coordinate Scale: 1.333333" in text
