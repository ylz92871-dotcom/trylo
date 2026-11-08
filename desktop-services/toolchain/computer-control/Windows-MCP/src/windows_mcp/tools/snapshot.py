"""Snapshot and Screenshot tools — desktop state capture."""

import logging

from mcp.types import ToolAnnotations
from windows_mcp.infrastructure import with_analytics
from windows_mcp.runtime.errors import ComputerControlError, ErrorCode, StructuredError
from fastmcp import Context

from fastmcp.utilities.types import Image

from windows_mcp.tools._snapshot_helpers import (
    _as_bool,
    _as_region,
    capture_desktop_state,
    build_snapshot_response,
)


def _exact_window_response(desktop, scope: str, window: str | None):
    """Flag-gated exact-window capture (§13.1 scope parameter).

    WGC available → honest ``complete`` FrameRef; otherwise the legacy
    desktop-crop fallback answers with status ``degraded`` and a visible
    warning — the scope never silently turns into a whole-desktop capture.
    Returns the legacy response shape: [text, Image?]."""
    import json

    result = desktop.capture_exact_window_frame(None, window if scope == "window" else None)
    frame = result.get("frame")
    png = result.get("png_bytes")
    parts = [
        f"Capture scope: {scope}",
        f"Window: {result.get('window_title') or '(unknown)'}",
        f"Outcome: {result.get('outcome')}",
    ]
    if frame is not None:
        parts.append(
            "FrameRef: " + json.dumps(frame, ensure_ascii=False)
        )
        parts.append(
            "Coordinates: frame pixel (0,0) maps to screen "
            f"({frame['image_to_screen'][0][2]:.0f},{frame['image_to_screen'][1][2]:.0f}) "
            "(client-area physical pixels; screen = pixel + origin)."
        )
    for warning in (frame or {}).get("warnings", []):
        parts.append(f"WARNING: {warning}")
    response: list = [chr(10).join(parts)]
    if png:
        response.append(Image(data=png, format="png"))
    return response


logger = logging.getLogger(__name__)

# Populated by register(); exposed for backward-compatible test imports.
state_tool = None
screenshot_tool = None


def register(mcp, *, get_desktop, get_analytics):
    global state_tool, screenshot_tool
    @mcp.tool(
        name='Snapshot',
        description="Take a screenshot and inspect the screen. Keywords: screenshot, screen capture, see screen, observe, look, inspect, UI elements, what's on screen. Captures complete desktop state including: system language, focused/opened windows, interactive elements (buttons, text fields, links, menus with coordinates), and scrollable areas. Set use_vision=True to include screenshot with cursor highlight. Set use_annotation=False to get a clean screenshot without bounding box overlays on UI elements (default: True, draws colored rectangles around detected elements). Set use_ui_tree=False for a faster screenshot-only snapshot when you do not need interactive or scrollable element extraction (Screenshot tool is the optimized version of this). Set width_reference_lines/height_reference_lines to overlay a grid with real screen-pixel ruler labels for better spatial reasoning (make sure vision is enabled to use it). Set use_dom=True for browser content to get web page elements instead of browser UI. Set display=[0] or display=[0,1] using zero-based active Windows display indices; omit it to keep the default full-desktop behavior. Set region=[left, top, right, bottom] in virtual-desktop pixel coordinates to capture and inspect only that rectangle instead of the whole screen/display — useful when you already know which area matters and want to save tokens; region takes precedence over display when both are given, and an invalid or out-of-bounds region raises an error (listing display bounds) rather than silently capturing something else. Coordinate systems: UI Tree element coordinates and Cursor Position are physical screen pixels — usable directly in Click/Move. Image pixel coordinates need the reported Coordinate Scale, or pass coordinate_space='screenshot' to Click/Move/Scroll. Always call this first to understand the current desktop state before taking actions. scope='window' (with window=<title>) or scope='foreground_window' captures ONE exact window via Windows Graphics Capture (flag-gated; falls back to a clearly-labeled degraded desktop crop) and returns a FrameRef with pixel→screen affine — frame pixel (0,0) sits at the reported screen origin.",
        annotations=ToolAnnotations(
            title="Snapshot",
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "State-Tool")
    def _state_tool(
        use_vision: bool | str = False,
        use_dom: bool | str = False,
        use_annotation: bool | str = True,
        use_ui_tree: bool | str = True,
        width_reference_line: int | None = None,
        height_reference_line: int | None = None,
        display: list[int] | None = None,
        region: list[int] | str | None = None,
        scope: str = "desktop",
        window: str | None = None,
        ctx: Context = None,
    ):
        if scope in ("window", "foreground_window"):
            return _exact_window_response(
                get_desktop(), scope, window
            )
        try:
            capture_result = capture_desktop_state(
                get_desktop(),
                use_vision=_as_bool(use_vision),
                use_dom=_as_bool(use_dom),
                use_annotation=_as_bool(use_annotation),
                use_ui_tree=_as_bool(use_ui_tree),
                width_reference_line=width_reference_line,
                height_reference_line=height_reference_line,
                display=display,
                region=_as_region(region),
                tool_name="Snapshot tool",
            )
        except Exception as e:
            logger.warning(
                "Snapshot failed with display=%s region=%s use_vision=%s use_dom=%s",
                display,
                region,
                use_vision if 'use_vision' in locals() else None,
                use_dom if 'use_dom' in locals() else None,
                exc_info=True,
            )
            raise ComputerControlError(
                StructuredError(
                    ErrorCode.CAPTURE_UNAVAILABLE,
                    f"failed to capture desktop state: {e}",
                    retryable=True,
                )
            ) from e

        return build_snapshot_response(capture_result, include_ui_details=True)

    @mcp.tool(
        name='Screenshot',
        description="Captures a fast screenshot-first desktop snapshot with cursor position, desktop/window summaries, and an image. This is the LIGHTWEIGHT mode — it skips UI tree extraction for speed; use Snapshot when you need interactive element ids, scrollable regions, or browser DOM extraction. Set display=[0] or display=[0,1] using zero-based active Windows display indices to capture only those monitors. Set region=[left, top, right, bottom] in virtual-desktop pixel coordinates to capture only that rectangle instead of the whole screen/display — useful when you already know which area matters and want to save tokens; region takes precedence over display when both are given, and an invalid or out-of-bounds region raises an error (listing display bounds) rather than silently capturing something else. Note: the returned image may be downscaled for efficiency; the metadata reports the exact Coordinate Scale — when it is not 1.0, multiply image coordinates by that scale, or pass coordinate_space='screenshot' to Click/Move/Scroll and let the tool convert. The metadata also reports per-display DPI scaling and the display bounds. scope='window' (with window=<title>) or scope='foreground_window' captures ONE exact window via Windows Graphics Capture (flag-gated; falls back to a clearly-labeled degraded desktop crop) and returns a FrameRef with pixel→screen affine.",
        annotations=ToolAnnotations(
            title="Screenshot",
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "Screenshot-Tool")
    def _screenshot_tool(
        use_annotation: bool | str = False,
        width_reference_line: int | None = None,
        height_reference_line: int | None = None,
        display: list[int] | None = None,
        region: list[int] | str | None = None,
        scope: str = "desktop",
        window: str | None = None,
        ctx: Context = None,
    ):
        if scope in ("window", "foreground_window"):
            return _exact_window_response(
                get_desktop(), scope, window
            )
        try:
            capture_result = capture_desktop_state(
                get_desktop(),
                use_vision=True,
                use_dom=False,
                use_annotation=_as_bool(use_annotation),
                use_ui_tree=False,
                width_reference_line=width_reference_line,
                height_reference_line=height_reference_line,
                display=display,
                region=_as_region(region),
                tool_name="Screenshot tool",
            )
        except Exception as e:
            logger.warning(
                "Screenshot failed with display=%s region=%s",
                display,
                region,
                exc_info=True,
            )
            raise ComputerControlError(
                StructuredError(
                    ErrorCode.CAPTURE_UNAVAILABLE,
                    f"failed to capture screenshot: {e}",
                    retryable=True,
                )
            ) from e

        return build_snapshot_response(
            capture_result,
            include_ui_details=False,
            ui_detail_note="UI Tree: Skipped for fast screenshot-only capture. Call Snapshot when you need interactive or scrollable elements.",
        )

    state_tool = _state_tool
    screenshot_tool = _screenshot_tool
