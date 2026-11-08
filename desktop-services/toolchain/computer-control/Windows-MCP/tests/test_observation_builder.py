import os
from types import SimpleNamespace

from windows_mcp.desktop.views import DesktopState, Display, Status, Window
from windows_mcp.runtime.clock import FakeClock
from windows_mcp.runtime.identity import IdentityFactory
from windows_mcp.runtime.observation_builder import build_observation_receipt
from windows_mcp.runtime.serialization import to_json_value
from windows_mcp.tree.views import (
    BoundingBox,
    Center,
    TreeElementNode,
    TreeState,
    UiaIdentity,
    UiaPatternAvailability,
)


def _box(left: int, top: int, right: int, bottom: int) -> BoundingBox:
    return BoundingBox(
        left=left,
        top=top,
        right=right,
        bottom=bottom,
        width=right - left,
        height=bottom - top,
    )


def test_receipt_preserves_uia_identity_capabilities_and_frame_mapping() -> None:
    window = Window(
        name="Editor",
        is_browser=False,
        depth=0,
        status=Status.NORMAL,
        bounding_box=_box(100, 200, 1100, 700),
        handle=101,
        process_id=os.getpid(),
    )
    node = TreeElementNode(
        bounding_box=_box(300, 300, 500, 400),
        center=Center(400, 350),
        name="Save",
        control_type="button",
        window_name="Editor",
        metadata={"is_enabled": True},
        uia_identity=UiaIdentity(
            runtime_id=(42, 7),
            automation_id="save-button",
            class_name="Button",
            framework_id="Win32",
            clickable_point=(400, 350),
        ),
        pattern_availability=UiaPatternAvailability(invoke=True, toggle=True),
    )
    state = DesktopState(
        active_desktop={"id": "desktop-a"},
        all_desktops=[],
        active_window=window,
        windows=[],
        screenshot=SimpleNamespace(width=500, height=250),
        screenshot_scale=0.5,
        screenshot_region=_box(100, 200, 1100, 700),
        available_displays=[
            Display(0, "DISPLAY1", _box(0, 0, 1920, 1080), True, 144, 1.5)
        ],
        screenshot_backend="wgc",
        tree_state=TreeState(interactive_nodes=[node], scrollable_nodes=[]),
    )

    receipt, labels = build_observation_receipt(
        state,
        identity_factory=IdentityFactory(b"test-observation-secret"),
        producer_id="actor-1",
        producer_generation=3,
        revision=9,
        ttl_seconds=30,
        clock=FakeClock(now=5),
    )

    assert labels == {0: receipt.elements[0].ref.element_id}
    element = receipt.elements[0]
    assert element.ref.snapshot_id == receipt.snapshot_id
    assert element.ref.runtime_id == (42, 7)
    assert element.ref.locator.automation_id == "save-button"
    assert element.ref.locator.framework_id == "Win32"
    assert element.capabilities.invoke is True
    assert element.capabilities.toggle is True
    assert element.bounds_frame is not None
    assert (
        element.bounds_frame.left,
        element.bounds_frame.top,
        element.bounds_frame.right,
        element.bounds_frame.bottom,
    ) == (100, 50, 200, 100)

    frame = receipt.frame
    assert frame is not None
    assert frame.source_scope == "region"
    assert frame.backend == "wgc"
    assert frame.image_to_screen.apply(100, 50) == (300, 300)
    assert frame.screen_to_image.apply(300, 300) == (100, 50)

    payload = to_json_value(receipt)
    assert list(payload) == [
        "producer_id",
        "producer_generation",
        "snapshot_id",
        "revision",
        "observed_at_qpc",
        "expires_at_monotonic",
        "scope",
        "active_window",
        "windows",
        "elements",
        "frame",
        "coverage",
        "warnings",
        "schema_version",
    ]
    assert payload["schema_version"] == 2
    assert list(payload["frame"]) == [
        "frame_id",
        "captured_at_qpc",
        "status",
        "source_scope",
        "source_window",
        "desktop_bounds",
        "client_bounds",
        "content_rect",
        "pixel_width",
        "pixel_height",
        "dpi_scale_x",
        "dpi_scale_y",
        "image_to_screen",
        "screen_to_image",
        "dirty_rects",
        "backend",
    ]
    assert list(payload["elements"][0]["ref"]) == [
        "element_id",
        "snapshot_id",
        "window",
        "runtime_id",
        "locator",
    ]


def test_selected_display_frame_reports_display_scope() -> None:
    state = DesktopState(
        active_desktop={"id": "desktop-a"},
        all_desktops=[],
        active_window=None,
        windows=[],
        screenshot=SimpleNamespace(width=800, height=600),
        screenshot_region=_box(-800, 0, 0, 600),
        screenshot_displays=[1],
        available_displays=[Display(1, "DISPLAY2", _box(-800, 0, 0, 600), False)],
        tree_state=TreeState(interactive_nodes=[], scrollable_nodes=[]),
    )

    receipt, _ = build_observation_receipt(
        state,
        identity_factory=IdentityFactory(b"test-observation-secret"),
        producer_id="actor-1",
        producer_generation=1,
        revision=1,
        ttl_seconds=30,
        clock=FakeClock(),
    )

    assert receipt.scope.kind == "display"
    assert receipt.frame is not None
    assert receipt.frame.image_to_screen.apply(0, 0) == (-800, 0)
