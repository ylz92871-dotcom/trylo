"""Adapt a legacy DesktopState into the immutable V2 observation contract."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from windows_mcp.runtime.clock import Clock
from windows_mcp.runtime.identity import (
    ElementRef,
    IdentityFactory,
    ProcessInstanceRef,
    ReacquireLocator,
    WindowRef,
)
from windows_mcp.runtime.observations import (
    Affine2D,
    CoverageReport,
    ElementCapabilities,
    FrameRef,
    InteractionNode,
    ObservationReceipt,
    ObservationScope,
    Rect,
    RedactedValue,
    WindowObservation,
)

if TYPE_CHECKING:
    from windows_mcp.runtime.generation_registry import GenerationRegistry


def _rect(value: Any) -> Rect | None:
    if value is None:
        return None
    return Rect(int(value.left), int(value.top), int(value.right), int(value.bottom))


def _process_ref(process_id: int) -> ProcessInstanceRef:
    started_at = 0
    try:
        from psutil import Process

        started_at = int(Process(process_id).create_time() * 10_000_000)
    except Exception:
        pass
    return ProcessInstanceRef(pid=process_id, started_at_100ns=started_at)


def _window_ref(
    window: Any,
    *,
    desktop_session_id: str,
    producer_generation: int,
    generation_registry: GenerationRegistry | None,
) -> WindowRef:
    owner = _process_ref(int(window.process_id))
    window_generation = (
        generation_registry.observe_window(int(window.handle), owner)
        if generation_registry is not None
        else 0
    )
    return WindowRef(
        desktop_session_id=desktop_session_id,
        producer_generation=producer_generation,
        hwnd=int(window.handle),
        owner=owner,
        window_generation=window_generation,
    )


def _capabilities(node: Any, *, scrollable: bool) -> ElementCapabilities:
    patterns = getattr(node, "pattern_availability", None)
    return ElementCapabilities(
        invoke=bool(getattr(patterns, "invoke", False)),
        toggle=bool(getattr(patterns, "toggle", False)),
        select=bool(getattr(patterns, "selection_item", False)),
        expand_collapse=bool(getattr(patterns, "expand_collapse", False)),
        set_value=bool(getattr(patterns, "value", False)),
        set_range_value=bool(getattr(patterns, "range_value", False)),
        text=bool(getattr(patterns, "text", False)),
        scroll=scrollable or bool(getattr(patterns, "scroll", False)),
        scroll_into_view=bool(getattr(patterns, "scroll_item", False)),
        focus=True,
        raw_click=getattr(node, "uia_identity", None) is not None,
    )


def _frame_ref(
    desktop_state: Any,
    identity_factory: IdentityFactory,
    clock: Clock,
) -> FrameRef | None:
    screenshot = getattr(desktop_state, "screenshot", None)
    if screenshot is None:
        return None
    pixel_width = int(getattr(screenshot, "width", 0))
    pixel_height = int(getattr(screenshot, "height", 0))
    if pixel_width <= 0 or pixel_height <= 0:
        return None

    displays = list(getattr(desktop_state, "available_displays", None) or [])
    if displays:
        left = min(display.bounding_box.left for display in displays)
        top = min(display.bounding_box.top for display in displays)
        right = max(display.bounding_box.right for display in displays)
        bottom = max(display.bounding_box.bottom for display in displays)
        desktop_bounds = Rect(left, top, right, bottom)
    else:
        desktop_bounds = Rect(0, 0, pixel_width, pixel_height)

    region = getattr(desktop_state, "screenshot_region", None)
    selected_displays = getattr(desktop_state, "screenshot_displays", None)
    if region is not None:
        content_rect = _rect(region)
        source_scope = "display" if selected_displays else "region"
    else:
        content_rect = desktop_bounds
        source_scope = "display" if selected_displays else "virtual_desktop"
    assert content_rect is not None
    scale = float(getattr(desktop_state, "screenshot_scale", None) or 1.0)
    if scale <= 0:
        raise ValueError("screenshot scale must be positive")
    image_to_screen = Affine2D(
        (
            1.0 / scale,
            0.0,
            float(content_rect.left),
            0.0,
            1.0 / scale,
            float(content_rect.top),
            0.0,
            0.0,
            1.0,
        )
    )
    screen_to_image = Affine2D(
        (
            scale,
            0.0,
            -float(content_rect.left) * scale,
            0.0,
            scale,
            -float(content_rect.top) * scale,
            0.0,
            0.0,
            1.0,
        )
    )
    dpi_scale = float(getattr(displays[0], "scale", None) or 1.0) if displays else 1.0
    return FrameRef(
        frame_id=identity_factory.new_id("frame", pixel_width, pixel_height),
        captured_at_qpc=clock.qpc_ns(),
        status="complete",
        source_scope=source_scope,
        source_window=None,
        desktop_bounds=desktop_bounds,
        client_bounds=None,
        content_rect=content_rect,
        pixel_width=pixel_width,
        pixel_height=pixel_height,
        dpi_scale_x=dpi_scale,
        dpi_scale_y=dpi_scale,
        image_to_screen=image_to_screen,
        screen_to_image=screen_to_image,
        dirty_rects=(),
        backend=str(getattr(desktop_state, "screenshot_backend", None) or "unknown"),
    )


def _bounds_in_frame(bounds: Rect | None, frame: FrameRef | None) -> Rect | None:
    """Map a screen-space rectangle into an image frame and clip it."""
    if bounds is None or frame is None:
        return None
    left, top = frame.screen_to_image.apply(bounds.left, bounds.top)
    right, bottom = frame.screen_to_image.apply(bounds.right, bounds.bottom)
    mapped = Rect(
        max(0, min(frame.pixel_width, int(round(min(left, right))))),
        max(0, min(frame.pixel_height, int(round(min(top, bottom))))),
        max(0, min(frame.pixel_width, int(round(max(left, right))))),
        max(0, min(frame.pixel_height, int(round(max(top, bottom))))),
    )
    if mapped.right <= mapped.left or mapped.bottom <= mapped.top:
        return None
    return mapped


def build_observation_receipt(
    desktop_state: Any,
    *,
    identity_factory: IdentityFactory,
    producer_id: str,
    producer_generation: int,
    revision: int,
    ttl_seconds: float,
    clock: Clock,
    generation_registry: GenerationRegistry | None = None,
) -> tuple[ObservationReceipt, dict[int, str]]:
    if ttl_seconds <= 0:
        raise ValueError("snapshot TTL must be positive")
    snapshot_id = identity_factory.new_id("snapshot", producer_generation, revision)
    active_desktop = getattr(desktop_state, "active_desktop", {}) or {}
    session_id = str(active_desktop.get("id") or active_desktop.get("name") or "default")
    windows = [
        window
        for window in [
            getattr(desktop_state, "active_window", None),
            *(getattr(desktop_state, "windows", None) or []),
        ]
        if window is not None
    ]
    unique_windows: dict[int, Any] = {int(window.handle): window for window in windows}
    window_refs = {
        handle: _window_ref(
            window,
            desktop_session_id=session_id,
            producer_generation=producer_generation,
            generation_registry=generation_registry,
        )
        for handle, window in unique_windows.items()
    }
    window_observations = tuple(
        WindowObservation(
            ref=window_refs[handle],
            title=str(window.name),
            bounds=_rect(window.bounding_box),
            active=window is getattr(desktop_state, "active_window", None),
        )
        for handle, window in unique_windows.items()
    )
    active_window = getattr(desktop_state, "active_window", None)
    active_ref = window_refs.get(int(active_window.handle)) if active_window else None

    refs_by_name: dict[str, list[WindowRef]] = {}
    for observation in window_observations:
        refs_by_name.setdefault(observation.title, []).append(observation.ref)

    tree_state = getattr(desktop_state, "tree_state", None)
    interactive = list(getattr(tree_state, "interactive_nodes", []) or [])
    scrollable = list(getattr(tree_state, "scrollable_nodes", []) or [])
    frame = _frame_ref(desktop_state, identity_factory, clock)
    elements: list[InteractionNode] = []
    labels: dict[int, str] = {}
    for label, node in enumerate([*interactive, *scrollable]):
        candidates = refs_by_name.get(str(getattr(node, "window_name", "")), [])
        window_ref = candidates[0] if len(candidates) == 1 else active_ref
        if window_ref is None:
            continue
        metadata = dict(getattr(node, "metadata", {}) or {})
        identity = getattr(node, "uia_identity", None)
        protected = bool(metadata.get("is_password", False))
        raw_value = metadata.get("value")
        value = None
        if raw_value is not None:
            value = RedactedValue(
                present=True,
                protected=protected,
                display=None if protected else str(raw_value),
            )
        element_id = identity_factory.new_id(
            "element",
            snapshot_id,
            window_ref.hwnd,
            getattr(identity, "runtime_id", None),
            getattr(node, "control_type", ""),
            getattr(identity, "automation_id", None),
            label,
        )
        ref = ElementRef(
            element_id=element_id,
            snapshot_id=snapshot_id,
            window=window_ref,
            runtime_id=getattr(identity, "runtime_id", None),
            locator=ReacquireLocator(
                control_type=str(getattr(node, "control_type", "")),
                automation_id=getattr(identity, "automation_id", None),
                class_name=getattr(identity, "class_name", None),
                framework_id=getattr(identity, "framework_id", None),
                name_hint=str(getattr(node, "name", "")) or None,
                spatial_hint=(
                    float(node.center.x),
                    float(node.center.y),
                ),
            ),
        )
        bounds_screen = _rect(getattr(node, "bounding_box", None))
        elements.append(
            InteractionNode(
                ref=ref,
                role=str(getattr(node, "control_type", "")),
                name=str(getattr(node, "name", "")),
                description=metadata.get("help_text"),
                value=value,
                bounds_screen=bounds_screen,
                bounds_frame=_bounds_in_frame(bounds_screen, frame),
                enabled=metadata.get("is_enabled", True) is True,
                offscreen=False,
                focused=bool(metadata.get("has_focused", False)),
                protected=protected,
                states=metadata,
                capabilities=_capabilities(node, scrollable=label >= len(interactive)),
                provenance=("uia",),
                confidence=1.0,
            )
        )
        labels[label] = element_id

    failed_handles = tuple(getattr(tree_state, "failed_handles", ()) or ())
    if frame is not None:
        scope = ObservationScope(frame.source_scope)
    else:
        scope = ObservationScope("virtual_desktop")
    receipt = ObservationReceipt(
        producer_id=producer_id,
        producer_generation=producer_generation,
        snapshot_id=snapshot_id,
        revision=revision,
        observed_at_qpc=clock.qpc_ns(),
        expires_at_monotonic=clock.monotonic() + ttl_seconds,
        scope=scope,
        active_window=active_ref,
        windows=window_observations,
        elements=tuple(elements),
        frame=frame,
        coverage=CoverageReport(
            requested_windows=len(unique_windows),
            observed_windows=max(0, len(unique_windows) - len(failed_handles)),
            failed_window_handles=failed_handles,
            tree_truncated=bool(getattr(tree_state, "truncated", False))
            or bool(getattr(tree_state, "time_truncated", False)),
            emitted_elements=len(elements),
            providers=("uia",),
        ),
    )
    return receipt, labels
