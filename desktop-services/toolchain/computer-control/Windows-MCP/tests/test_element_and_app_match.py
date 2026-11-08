import asyncio
from collections.abc import Callable
from unittest.mock import MagicMock

import pytest

from windows_mcp.desktop.service import Desktop
from windows_mcp.desktop.views import DesktopState, Status, Window
from windows_mcp.tools.input import register as register_input
from windows_mcp.tree.views import BoundingBox, Center, ScrollElementNode, TreeElementNode, TreeState


# ---- shared fixtures --------------------------------------------------------


class FakeMCP:
    def __init__(self) -> None:
        self.tools: dict[str, Callable] = {}
        self.tool_options: dict[str, dict[str, object]] = {}

    def tool(self, *, name: str, **kwargs: object) -> Callable:
        self.tool_options[name] = kwargs

        def decorator(func: Callable) -> Callable:
            self.tools[name] = func
            return func

        return decorator


def make_box(left, top, right, bottom):
    return BoundingBox(
        left=left, top=top, right=right, bottom=bottom, width=right - left, height=bottom - top
    )


def make_desktop_with_tree_state():
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
                TreeElementNode(
                    bounding_box=make_box(20, 20, 60, 60),
                    center=Center(x=40, y=40),
                    name="Send message",
                    control_type="Button",
                    window_name="Chat",
                ),
            ],
            scrollable_nodes=[
                ScrollElementNode(
                    name="Messages list",
                    control_type="Pane",
                    window_name="Chat",
                    bounding_box=make_box(60, 60, 100, 100),
                    center=Center(x=80, y=80),
                )
            ],
        ),
    )
    return desktop


def register_input_tools(desktop):
    mcp = FakeMCP()
    register_input(mcp, get_desktop=lambda: desktop, get_analytics=lambda: None)
    return mcp.tools


# ---- element-by-description resolution (Desktop) ----------------------------


class TestGetCoordinatesFromElement:
    def test_matches_by_exact_element_name(self):
        desktop = make_desktop_with_tree_state()
        assert desktop.get_coordinates_from_element("Button 1") == (10, 10)

    def test_matches_scrollable_element_by_description(self):
        desktop = make_desktop_with_tree_state()
        assert desktop.get_coordinates_from_element("Messages list") == (80, 80)

    def test_raises_when_no_element_matches(self, monkeypatch):
        desktop = make_desktop_with_tree_state()
        monkeypatch.setattr(desktop, "_live_element_match", lambda element: None)
        with pytest.raises(ValueError, match="No UI element matched"):
            desktop.get_coordinates_from_element("zzz nonexistent")

    def test_raises_when_no_elements_captured(self, monkeypatch):
        desktop = Desktop.__new__(Desktop)
        desktop.desktop_state = DesktopState(
            active_desktop={},
            all_desktops=[],
            active_window=None,
            windows=[],
            tree_state=TreeState(),  # no interactive/scrollable nodes
        )
        monkeypatch.setattr(desktop, "_live_element_match", lambda element: None)
        with pytest.raises(ValueError, match="No UI element matched"):
            desktop.get_coordinates_from_element("anything")


# ---- input tools accept `element` ------------------------------------------


class TestInputToolsAcceptElement:
    def test_click_resolves_element_description(self, monkeypatch):
        desktop = make_desktop_with_tree_state()
        desktop.click = MagicMock()
        monkeypatch.setattr(desktop, "click_hit_note", lambda x, y: "")
        tools = register_input_tools(desktop)

        result = asyncio.run(tools["Click"](element="Send message"))

        assert result == "Single left clicked at (40,40)."
        desktop.click.assert_called_once_with(
            loc=[40, 40],
            button="left",
            clicks=1,
            modifiers=None,
            action="click",
            hold_seconds=None,
        )

    def test_type_resolves_element_description(self):
        desktop = make_desktop_with_tree_state()
        desktop.type = MagicMock()
        desktop.keyboard_layout = lambda: {"layout_id": "00000409", "is_english": True}
        tools = register_input_tools(desktop)

        result = asyncio.run(tools["Type"](text="hi", element="Send message"))

        # WCC-P0-01: the typed text is never echoed back — only the count.
        assert result == "Typed 2 character(s) at (40,40)."
        desktop.type.assert_called_once_with(
            loc=[40, 40],
            text="hi",
            caret_position="idle",
            clear=False,
            press_enter=False,
            interval=None,
        )

    def test_move_resolves_element_description(self, monkeypatch):
        desktop = make_desktop_with_tree_state()
        desktop.move = MagicMock()
        monkeypatch.setattr(desktop, "get_cursor_location", lambda: (80, 80))
        tools = register_input_tools(desktop)

        result = asyncio.run(tools["Move"](element="Messages list"))

        assert "Moved the mouse pointer to (80,80)" in result
        assert "actual cursor position (80,80)" in result
        desktop.move.assert_called_once_with([80, 80])

    def test_scroll_resolves_element_description(self):
        desktop = make_desktop_with_tree_state()
        desktop.scroll = MagicMock(return_value=None)
        tools = register_input_tools(desktop)

        result = asyncio.run(tools["Scroll"](element="Messages list"))

        assert result == "Scrolled vertical down by 1 wheel times at (80,80)."
        desktop.scroll.assert_called_once_with(
            [80, 80], "vertical", "down", 1, wheel_delta=120
        )

    def test_requires_one_of_loc_label_element_for_click(self):
        desktop = make_desktop_with_tree_state()
        desktop.click = MagicMock()
        tools = register_input_tools(desktop)

        with pytest.raises(ValueError, match="loc, label, or element"):
            asyncio.run(tools["Click"]())


# ---- _find_window_by_name fallbacks ----------------------------------------


def make_desktop_with_windows(windows):
    desktop = Desktop.__new__(Desktop)
    desktop.desktop_state = DesktopState(
        active_desktop={"name": "Desktop 1"},
        all_desktops=[],
        active_window=None,
        windows=windows,
    )
    return desktop


def make_window(name, handle, pid):
    return Window(
        name=name,
        is_browser=False,
        depth=0,
        status=Status.NORMAL,
        bounding_box=make_box(0, 0, 400, 300),
        handle=handle,
        process_id=pid,
    )


class FakeProcess:
    _NAMES = {100: "notepad.exe", 200: "calc.exe"}

    def __init__(self, pid):
        self._pid = pid

    def name(self):
        return self._NAMES.get(self._pid, "")


class TestFindWindowByProcessFallback:
    def test_matches_by_process_base_name_when_title_differs(self, monkeypatch):
        monkeypatch.setattr(
            "windows_mcp.desktop.service.Process", FakeProcess, raising=False
        )
        desktop = make_desktop_with_windows(
            [make_window("results - spreadsheet", 200, 200)]
        )

        window, error = desktop._find_window_by_name("calc")

        assert error == ""
        assert window is not None
        assert window.handle == 200

    def test_still_matches_by_title_first(self, monkeypatch):
        monkeypatch.setattr(
            "windows_mcp.desktop.service.Process", FakeProcess, raising=False
        )
        desktop = make_desktop_with_windows(
            [make_window("notes.txt - Notepad", 100, 100)]
        )

        window, error = desktop._find_window_by_name("Notepad")

        assert error == ""
        assert window.handle == 100

    def test_duplicate_titles_fail_closed_as_ambiguous(self, monkeypatch):
        monkeypatch.setattr(
            "windows_mcp.desktop.service.Process", FakeProcess, raising=False
        )
        desktop = make_desktop_with_windows(
            [
                make_window("Untitled - Notepad", 101, 100),
                make_window("Untitled - Notepad", 102, 100),
            ]
        )

        window, error = desktop._find_window_by_name("Untitled - Notepad")

        assert window is None
        assert "ambiguous" in error
        assert "handle=101" in error
        assert "handle=102" in error


class TestFindWindowByLocalizedAppName:
    def test_switches_by_localized_app_name(self, monkeypatch):
        monkeypatch.setattr(
            "windows_mcp.desktop.service.Process", FakeProcess, raising=False
        )
        desktop = make_desktop_with_windows([make_window("MyFile.txt - Notepad", 100, 100)])
        # Start-menu reports the localized display name that maps to an exe.
        desktop.get_apps_from_start_menu = MagicMock(
            return_value={"记事本": r"C:\Windows\System32\notepad.exe"}
        )
        monkeypatch.setattr(
            "windows_mcp.desktop.service.resolve_known_folder_guid_path",
            lambda path: path,
            raising=False,
        )

        window, error = desktop._find_window_by_name("记事本")

        assert error == ""
        assert window is not None
        assert window.handle == 100
