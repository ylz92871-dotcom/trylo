"""Snapshot / Screenshot shared helpers.

These functions were originally defined in ``__main__.py`` and are now shared
by the Snapshot and Screenshot tool modules.
"""

import io
import hashlib
import json
import logging
import os
import time
from pathlib import Path

from fastmcp.utilities.types import Image
from fastmcp.tools import ToolResult
from textwrap import dedent
from windows_mcp.desktop.service import Desktop, Size
from windows_mcp.desktop.utils import remove_private_use_chars, repair_surrogates
from windows_mcp.runtime.observations import ObservationReceipt


logger = logging.getLogger(__name__)

MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT = 1920, 1080


def _cache_original_preview(root: str, data: bytes) -> dict:
    digest = hashlib.sha256(data).hexdigest()
    path = Path(root).resolve() / digest[:2] / f"{digest}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("xb") as preview_file:
            preview_file.write(data)
    except (FileExistsError, PermissionError):
        # Windows can report EACCES for CREATE_NEW on an existing read-only
        # file. Reuse only the exact immutable bytes; never change its ACL.
        if path.is_symlink() or not path.is_file():
            raise
        if path.stat().st_size != len(data) or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError("Original preview cache checksum mismatch")
    return {
        "id": f"bin-{digest[:16]}", "storage": "ephemeral-tool-cache",
        "path": str(path), "mimeType": "image/png", "size": len(data), "sha256": digest,
    }


def _screenshot_scale() -> float:
    value = os.getenv("WINDOWS_MCP_SCREENSHOT_SCALE", "1.0")
    try:
        scale = float(value)
    except ValueError:
        logger.warning("Invalid WINDOWS_MCP_SCREENSHOT_SCALE value %r, using 1.0", value)
        scale = 1.0
    if not (0.1 <= scale <= 1.0):
        logger.warning("WINDOWS_MCP_SCREENSHOT_SCALE %r out of range [0.1, 1.0], clamping", scale)
        scale = max(0.1, min(1.0, scale))
    return scale


def _snapshot_profile_enabled() -> bool:
    value = os.getenv("WINDOWS_MCP_PROFILE_SNAPSHOT", "")
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _as_bool(value: bool | str) -> bool:
    return value is True or (isinstance(value, str) and value.lower() == "true")


def _as_region(value: list | str | None) -> list | None:
    if value is None or isinstance(value, list):
        return value
    return json.loads(value)


def capture_desktop_state(
    desktop: Desktop,
    *,
    use_vision: bool,
    use_dom: bool,
    use_annotation: bool,
    use_ui_tree: bool,
    width_reference_line: int | None,
    height_reference_line: int | None,
    display: list[int] | None,
    region: list[int] | None,
    tool_name: str,
):
    profile_enabled = _snapshot_profile_enabled()
    native_preview = os.getenv("WINDOWS_MCP_SCREENSHOT_NATIVE") == "1"
    profile_started_at = time.perf_counter()
    stage_started_at = profile_started_at
    desktop_state_ms = 0.0
    metadata_render_ms = 0.0
    screenshot_encode_ms = 0.0

    if use_dom and not use_ui_tree:
        raise ValueError("use_dom=True requires use_ui_tree=True")

    display_indices = Desktop.parse_display_selection(display)

    grid_lines = None
    if width_reference_line and height_reference_line:
        grid_lines = (int(width_reference_line), int(height_reference_line))

    desktop_state = desktop.get_state(
        use_vision=use_vision,
        use_dom=use_dom,
        use_annotation=use_annotation,
        use_ui_tree=use_ui_tree,
        as_bytes=False,
        scale=1.0 if native_preview else _screenshot_scale(),
        grid_lines=grid_lines,
        display_indices=display_indices,
        region=region,
        max_image_size=None if native_preview else Size(width=MAX_IMAGE_WIDTH, height=MAX_IMAGE_HEIGHT),
    )
    if profile_enabled:
        desktop_state_ms = (time.perf_counter() - stage_started_at) * 1000
        stage_started_at = time.perf_counter()

    interactive_elements = desktop_state.tree_state.interactive_elements_to_string()
    scrollable_elements = desktop_state.tree_state.scrollable_elements_to_string()
    semantic_tree = desktop_state.tree_state.semantic_tree_to_string()
    windows = desktop_state.windows_to_string()
    active_window = desktop_state.active_window_to_string()
    active_desktop = desktop_state.active_desktop_to_string()
    all_desktops = desktop_state.desktops_to_string()
    if profile_enabled:
        metadata_render_ms = (time.perf_counter() - stage_started_at) * 1000
        stage_started_at = time.perf_counter()

    screenshot_bytes = None
    preview_ref = None
    preview_warning = None
    if use_vision and desktop_state.screenshot is not None:
        buffered = io.BytesIO()
        desktop_state.screenshot.save(buffered, format="PNG")
        screenshot_bytes = buffered.getvalue()
        buffered.close()
        preview_cache = os.getenv("WINDOWS_MCP_PREVIEW_CACHE") if native_preview else None
        if preview_cache:
            try:
                preview_ref = _cache_original_preview(preview_cache, screenshot_bytes)
            except OSError:
                # The original-resolution workbench cache is optional. A
                # working capture must still deliver its inline model image.
                logger.warning("Original screenshot preview cache unavailable", exc_info=True)
                preview_warning = "Original preview cache unavailable; the screenshot image is still attached. Do not recapture to repair the cache."
            # Keep the model image within its existing dimension limit; the
            # Desktop workbench reads the lossless original through BinaryRef.
            model_image = desktop_state.screenshot.copy()
            model_image.thumbnail((MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT))
            desktop_state.screenshot_scale = model_image.width / desktop_state.screenshot.width
            desktop_state.screenshot = model_image
            with io.BytesIO() as model_buffer:
                model_image.save(model_buffer, format="PNG")
                screenshot_bytes = model_buffer.getvalue()
    if profile_enabled:
        screenshot_encode_ms = (time.perf_counter() - stage_started_at) * 1000
        logger.info(
            "%s profile: desktop_state_ms=%.1f metadata_render_ms=%.1f png_encode_ms=%.1f total_ms=%.1f use_vision=%s use_dom=%s use_ui_tree=%s use_annotation=%s display=%s",
            tool_name,
            desktop_state_ms,
            metadata_render_ms,
            screenshot_encode_ms,
            (time.perf_counter() - profile_started_at) * 1000,
            use_vision,
            use_dom,
            use_ui_tree,
            use_annotation,
            display,
        )

    observation_receipt = None
    receipt_builder = getattr(desktop, "create_observation_receipt", None)
    if callable(receipt_builder):
        candidate = receipt_builder(desktop_state)
        if isinstance(candidate, ObservationReceipt):
            observation_receipt = candidate

    return {
        "preview_warning": preview_warning,
        "desktop_state": desktop_state,
        "interactive_elements": interactive_elements,
        "scrollable_elements": scrollable_elements,
        "semantic_tree": semantic_tree,
        "windows": windows,
        "active_window": active_window,
        "active_desktop": active_desktop,
        "all_desktops": all_desktops,
        "screenshot_bytes": screenshot_bytes,
        "preview_ref": preview_ref,
        "observation_receipt": observation_receipt,
    }


def _window_receipts_block(desktop_state) -> str:
    """Compact machine-readable window receipts for the model to copy into a
    mutation's ``window_receipt`` argument (WCC-P2-02). Identity fields only:
    hwnd, pid, process start time, digest, display title. The server
    re-verifies the digest at dispatch, so a stale or forged receipt fails
    closed instead of steering the action to another window."""
    try:
        from windows_mcp.runtime.identity import window_receipt

        seen: set[int] = set()
        entries: list[dict] = []
        for window in [desktop_state.active_window, *(desktop_state.windows or [])]:
            if window is None:
                continue
            handle = int(getattr(window, "handle", 0) or 0)
            pid = int(getattr(window, "process_id", 0) or 0)
            if handle <= 0 or pid <= 0 or handle in seen:
                continue
            seen.add(handle)
            entries.append(window_receipt(handle, pid, title=getattr(window, "name", None)))
        if not entries:
            return ""
        body = json.dumps(entries, ensure_ascii=False, sort_keys=True)
        header = (
            "\n    Window Receipts (copy one verbatim into window_receipt "
            "to bind the next action to that exact window):\n    "
        )
        return f"{header}{body}\n"
    except Exception:
        # Receipts are an enhancement; a failure here must never break the
        # Snapshot itself.
        return ""


def build_snapshot_response(
    capture_result: dict[str, object],
    *,
    include_ui_details: bool,
    ui_detail_note: str | None = None,
):
    desktop_state = capture_result["desktop_state"]
    interactive_elements = capture_result["interactive_elements"]
    scrollable_elements = capture_result["scrollable_elements"]
    semantic_tree = capture_result["semantic_tree"]
    windows = capture_result["windows"]
    active_window = capture_result["active_window"]
    active_desktop = capture_result["active_desktop"]
    all_desktops = capture_result["all_desktops"]
    screenshot_bytes = capture_result["screenshot_bytes"]
    observation_receipt = capture_result.get("observation_receipt")
    window_receipts_block = _window_receipts_block(desktop_state)

    # Some applications (e.g. VS Code) embed Unicode Private Use Area characters in the
    # Automation Element Name property of certain UI elements (e.g. navigation bar items in VS Code).
    # These characters can cause display issues, so we strip them out before rendering.
    interactive_elements = remove_private_use_chars(interactive_elements)
    scrollable_elements = remove_private_use_chars(scrollable_elements)
    semantic_tree = remove_private_use_chars(semantic_tree)

    # Emoji reach us from UIA as raw UTF-16 surrogate pairs. Left alone they make
    # the strict UTF-8 JSON encoder reject the entire response, so every string
    # heading into it is repaired -- window titles included, since an emoji in a
    # window title is enough to take the whole snapshot down.
    interactive_elements = repair_surrogates(interactive_elements)
    scrollable_elements = repair_surrogates(scrollable_elements)
    semantic_tree = repair_surrogates(semantic_tree)
    windows = repair_surrogates(windows)
    active_window = repair_surrogates(active_window)
    active_desktop = repair_surrogates(active_desktop)
    all_desktops = repair_surrogates(all_desktops)

    def display_to_string(display):
        primary = " primary" if display.primary else ""
        return (
            f"{display.index}:{display.device_name} "
            f"{display.bounding_box.xyxy_to_string()}{primary}"
        )

    metadata_text = f"Cursor Position: {desktop_state.cursor_position}\n"
    if isinstance(observation_receipt, ObservationReceipt):
        metadata_text += (
            f"Snapshot Receipt: {observation_receipt.snapshot_id} "
            f"(schema={observation_receipt.schema_version}, "
            f"revision={observation_receipt.revision}, "
            f"elements={len(observation_receipt.elements)})\n"
        )
        if observation_receipt.elements:
            metadata_text += (
                "Element References: labels in this response are bound only to "
                f"snapshot {observation_receipt.snapshot_id}; expired or cross-snapshot "
                "labels are rejected.\n"
            )
        if observation_receipt.frame is not None:
            frame = observation_receipt.frame
            metadata_text += (
                f"Frame Reference: {frame.frame_id} "
                f"({frame.pixel_width}x{frame.pixel_height}, "
                f"scope={frame.source_scope}, backend={frame.backend})\n"
            )
    if desktop_state.screenshot_original_size:
        orig = desktop_state.screenshot_original_size
        scale = desktop_state.screenshot_scale or 1.0
        # ALWAYS state the image→screen mapping (P2-11): when the image is
        # downscaled, image pixels are NOT screen pixels, and guessing the
        # ratio is the #1 source of misclicks. When scale is 1.0 the line
        # confirms 1:1 so the model never has to wonder.
        if scale < 1.0:
            coord_scale = round(1.0 / scale, 6)
            metadata_text += (
                f"Screenshot Image Size: {orig.to_string()} (downscaled)\n"
                f"Screenshot Coordinate Scale: {coord_scale} "
                f"— image pixels are downscaled; multiply every image pixel coordinate by "
                f"{coord_scale} before passing to Click, Move, Scroll, or any loc= argument "
                f"(e.g. image pixel (200, 150) → screen coordinate ({round(200 * coord_scale)}, {round(150 * coord_scale)}))\n"
            )
        else:
            metadata_text += (
                f"Screenshot Image Size: {orig.to_string()}\n"
                "Screenshot Coordinate Scale: 1.0 — image pixels map 1:1 to screen "
                "coordinates, no conversion needed\n"
            )
    if desktop_state.available_displays:
        metadata_text += "Visible Displays: "
        metadata_text += "; ".join(
            display_to_string(display) for display in desktop_state.available_displays
        )
        metadata_text += "\n"
        # Explicit DPI scaling per display (stress-test finding: at 150% DPI
        # the agent had to fit the image->screen factor by hand). With these
        # numbers, plus the Coordinate Scale above, the mapping is fully
        # documented instead of implied.
        dpi_parts = []
        for display in desktop_state.available_displays:
            dpi = getattr(display, "effective_dpi", None)
            scale = getattr(display, "scale", None)
            if dpi is None and scale is None:
                continue
            dpi_parts.append(
                f"display {display.index}: {dpi or '?'} DPI"
                + (f" ({scale}x)" if scale else "")
            )
        if dpi_parts:
            metadata_text += "Display DPI Scaling: " + "; ".join(dpi_parts) + "\n"
        metadata_text += (
            "Coordinate systems: UI Tree coordinates and Cursor Position are "
            "physical screen (virtual desktop) pixels — pass them to Click/Move/"
            "Scroll directly. Image pixel coordinates need the Coordinate Scale "
            "above, or pass coordinate_space='screenshot' to Click/Move/Scroll and "
            "let the tool convert.\n"
        )
    if desktop_state.screenshot_displays:
        metadata_text += f"Selected Displays: {','.join(str(index) for index in desktop_state.screenshot_displays)}\n"
    if desktop_state.screenshot_region:
        metadata_text += f"Screenshot Region: {desktop_state.screenshot_region.xyxy_to_string()}\n"
        metadata_text += "Coordinate Space: Virtual desktop coordinates\n"
    if desktop_state.screenshot_backend:
        metadata_text += f"Screenshot Backend: {desktop_state.screenshot_backend}\n"
    if ui_detail_note:
        metadata_text += f"{ui_detail_note}\n"

    response_text = dedent(f'''
    {metadata_text}
    Active Desktop:
    {active_desktop}

    All Desktops:
    {all_desktops}

    Focused Window:
    {active_window}

    Opened Windows:
    {windows}
{window_receipts_block}    ''')
    if include_ui_details:
        response_text += dedent(f'''

    UI Tree:
    {semantic_tree or "No elements found."}''')

    if capture_result.get("preview_warning"):
        response_text += "\nWARNING: " + capture_result["preview_warning"]
    response = [response_text]
    if screenshot_bytes:
        response.append(Image(data=screenshot_bytes, format="png"))
    if capture_result.get("preview_ref"):
        # Older bundled CLIs preserve content but omit MCP _meta on stdout.
        # This small reference survives that boundary; no image bytes do.
        response.append("TRYLO_PREVIEW_REF_V1 " + json.dumps(capture_result["preview_ref"]))
        return ToolResult(content=response, meta={"trylo/preview": capture_result["preview_ref"]})
    return response
