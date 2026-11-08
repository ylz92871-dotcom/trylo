import asyncio
from unittest.mock import MagicMock

import pytest

from windows_mcp.desktop.service import Desktop
from windows_mcp.desktop.views import DesktopState
from windows_mcp.runtime.errors import ErrorCode
from windows_mcp.runtime.results import TargetReceipt
from windows_mcp.runtime.target_resolver import ResolvedTarget, TargetResolutionError
from windows_mcp.tree.views import BoundingBox, Center, ScrollElementNode, TreeElementNode, TreeState
from windows_mcp.tools.multi import register


class FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, *, name, **kwargs):
        def decorator(func):
            self.tools[name] = func
            return func

        return decorator


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
                    bounding_box=BoundingBox(left=0, top=0, right=20, bottom=20, width=20, height=20),
                    center=Center(x=10, y=10),
                    name="Button 1",
                    control_type="Button",
                    window_name="Notepad",
                ),
                TreeElementNode(
                    bounding_box=BoundingBox(left=20, top=20, right=60, bottom=60, width=40, height=40),
                    center=Center(x=40, y=40),
                    name="Button 2",
                    control_type="Button",
                    window_name="Notepad",
                ),
            ],
            scrollable_nodes=[
                ScrollElementNode(
                    name="Scrollable 1",
                    control_type="Pane",
                    window_name="Notepad",
                    bounding_box=BoundingBox(left=60, top=60, right=100, bottom=100, width=40, height=40),
                    center=Center(x=80, y=80),
                )
            ],
        ),
    )
    return desktop


def register_tools(desktop):
    mcp = FakeMCP()
    register(mcp, get_desktop=lambda: desktop, get_analytics=lambda: None)
    return mcp.tools


def test_get_coordinates_from_labels_returns_bulk_coordinates():
    desktop = make_desktop_with_tree_state()

    assert desktop.get_coordinates_from_labels([0, 1, 2]) == [(10, 10), (40, 40), (80, 80)]


def test_multiselect_uses_bulk_coordinate_resolution():
    desktop = MagicMock()
    desktop.desktop_state = object()
    desktop.get_coordinates_from_labels.return_value = [(10, 10), (40, 40)]

    tools = register_tools(desktop)
    result = asyncio.run(tools["MultiSelect"](labels=[0, 1], press_ctrl=False))

    assert result == "Multi-selected elements at:\n(10,10)\n(40,40)"
    desktop.get_coordinates_from_labels.assert_called_once_with([0, 1])
    desktop.multi_select.assert_called_once_with(False, [[10, 10], [40, 40]])


def test_multiedit_uses_bulk_coordinate_resolution():
    desktop = MagicMock()
    desktop.desktop_state = object()
    desktop.get_coordinates_from_labels.return_value = [(10, 10), (40, 40)]

    tools = register_tools(desktop)
    result = asyncio.run(tools["MultiEdit"](labels=[[0, "First"], [1, "Second"]]))

    assert result == "Multi-edited 2 element(s) at: (10,10), (40,40)"
    assert "First" not in result
    assert "Second" not in result
    desktop.get_coordinates_from_labels.assert_called_once_with([0, 1])
    desktop.multi_edit.assert_called_once_with([[10, 10, "First"], [40, 40, "Second"]])


def _resolved(x: int, y: int, *, hwnd: int = 11, pid: int = 22) -> ResolvedTarget:
    return ResolvedTarget(
        receipt=TargetReceipt(
            target_kind="element",
            description="test target",
            snapshot_id="snapshot-1",
            window_handle=hwnd,
            process_id=pid,
        ),
        screen_point=(x, y),
        source="test",
    )


def test_multiselect_dispatch_resolves_and_injects_in_one_desktop_command():
    desktop = Desktop.__new__(Desktop)
    targets = [_resolved(10, 20), _resolved(30, 40)]
    desktop.resolve_action_points = MagicMock(return_value=targets)
    desktop._focus_resolved_batch = MagicMock()
    desktop.multi_select = MagicMock()
    desktop._finish_target_mutation = MagicMock()

    result = desktop.dispatch_multi_select_targets(
        locs=[[10, 20], [30, 40]],
        labels=None,
        snapshot_id="snapshot-1",
        coordinate_space="screen",
        press_ctrl=True,
    )

    assert result["locs"] == [[10, 20], [30, 40]]
    desktop._focus_resolved_batch.assert_called_once_with(targets)
    desktop.multi_select.assert_called_once_with(True, [[10, 20], [30, 40]])
    desktop._finish_target_mutation.assert_called_once_with(targets[0])


def test_multiedit_dispatch_keeps_text_with_resolved_point_inside_command():
    desktop = Desktop.__new__(Desktop)
    targets = [_resolved(10, 20), _resolved(30, 40)]
    desktop.resolve_action_points = MagicMock(return_value=targets)
    desktop._focus_resolved_batch = MagicMock()
    desktop.multi_edit = MagicMock()
    desktop._finish_target_mutation = MagicMock()

    result = desktop.dispatch_multi_edit_targets(
        locs=None,
        labels=[[0, "First"], [1, "Second"]],
        snapshot_id="snapshot-1",
        coordinate_space="screen",
    )

    assert result["locs"] == [[10, 20, "First"], [30, 40, "Second"]]
    desktop.multi_edit.assert_called_once_with(
        [[10, 20, "First"], [30, 40, "Second"]]
    )
    desktop._finish_target_mutation.assert_called_once_with(targets[0])


def test_batch_focus_rejects_targets_spanning_multiple_windows():
    desktop = Desktop.__new__(Desktop)

    with pytest.raises(TargetResolutionError) as exc_info:
        desktop._focus_resolved_batch(
            [_resolved(10, 20, hwnd=11), _resolved(30, 40, hwnd=12)]
        )

    assert exc_info.value.code is ErrorCode.AMBIGUOUS_TARGET
