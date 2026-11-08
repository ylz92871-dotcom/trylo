"""Immutable observation and interaction-node contracts."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Mapping

from windows_mcp.runtime.identity import ElementRef, WindowRef
from windows_mcp.runtime.results import RuntimeWarning

OBSERVATION_SCHEMA_VERSION = 2


@dataclass(frozen=True, slots=True)
class Rect:
    left: int
    top: int
    right: int
    bottom: int

    def __post_init__(self) -> None:
        if self.right < self.left or self.bottom < self.top:
            raise ValueError("Rect uses [left, top, right, bottom) and cannot invert")


@dataclass(frozen=True, slots=True)
class Affine2D:
    values: tuple[float, float, float, float, float, float, float, float, float]

    def apply(self, x: float, y: float) -> tuple[float, float]:
        a, b, c, d, e, f, g, h, i = self.values
        divisor = g * x + h * y + i
        if divisor == 0:
            raise ValueError("affine transform produced a zero homogeneous divisor")
        return ((a * x + b * y + c) / divisor, (d * x + e * y + f) / divisor)


@dataclass(frozen=True, slots=True)
class ElementCapabilities:
    invoke: bool = False
    toggle: bool = False
    select: bool = False
    expand_collapse: bool = False
    set_value: bool = False
    set_range_value: bool = False
    text: bool = False
    scroll: bool = False
    scroll_into_view: bool = False
    focus: bool = False
    raw_click: bool = False


@dataclass(frozen=True, slots=True)
class RedactedValue:
    present: bool
    protected: bool
    display: str | None = None

    def __post_init__(self) -> None:
        if self.protected and self.display is not None:
            raise ValueError("protected values cannot carry display content")


@dataclass(frozen=True, slots=True)
class InteractionNode:
    ref: ElementRef
    role: str
    name: str
    description: str | None
    value: RedactedValue | None
    bounds_screen: Rect | None
    bounds_frame: Rect | None
    enabled: bool
    offscreen: bool
    focused: bool
    protected: bool
    states: Mapping[str, Any]
    capabilities: ElementCapabilities
    provenance: tuple[
        Literal["app_provider", "dom", "uia", "ia2", "ocr", "vision"], ...
    ]
    confidence: float | None
    children: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.protected and self.value is not None and self.value.display is not None:
            raise ValueError("protected nodes cannot expose value text")
        if self.confidence is not None and not 0 <= self.confidence <= 1:
            raise ValueError("confidence must be between 0 and 1")


@dataclass(frozen=True, slots=True)
class ObservationScope:
    kind: Literal["exact_window", "application", "display", "virtual_desktop", "region"]
    identity: str | None = None


@dataclass(frozen=True, slots=True)
class WindowObservation:
    ref: WindowRef
    title: str
    bounds: Rect | None
    active: bool


@dataclass(frozen=True, slots=True)
class CoverageReport:
    requested_windows: int
    observed_windows: int
    failed_window_handles: tuple[int, ...] = ()
    tree_truncated: bool = False
    visited_elements: int = 0
    emitted_elements: int = 0
    providers: tuple[str, ...] = ()
    included_transients: bool = False
    protected_regions: tuple[Rect, ...] = ()
    unsupported_capabilities: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class FrameRef:
    frame_id: str
    captured_at_qpc: int
    status: Literal["complete", "idle", "occluded_fallback", "protected", "black", "degraded"]
    source_scope: Literal["exact_window", "application", "display", "virtual_desktop", "region"]
    source_window: WindowRef | None
    desktop_bounds: Rect
    client_bounds: Rect | None
    content_rect: Rect
    pixel_width: int
    pixel_height: int
    dpi_scale_x: float
    dpi_scale_y: float
    image_to_screen: Affine2D
    screen_to_image: Affine2D
    dirty_rects: tuple[Rect, ...]
    backend: str


@dataclass(frozen=True, slots=True)
class ObservationReceipt:
    producer_id: str
    producer_generation: int
    snapshot_id: str
    revision: int
    observed_at_qpc: int
    expires_at_monotonic: float
    scope: ObservationScope
    active_window: WindowRef | None
    windows: tuple[WindowObservation, ...]
    elements: tuple[InteractionNode, ...]
    frame: FrameRef | None
    coverage: CoverageReport
    warnings: tuple[RuntimeWarning, ...] = ()
    schema_version: int = field(default=OBSERVATION_SCHEMA_VERSION, init=False)

    def __post_init__(self) -> None:
        if self.producer_generation < 0 or self.revision < 0:
            raise ValueError("observation generations and revisions must be non-negative")
        if not self.producer_id or not self.snapshot_id:
            raise ValueError("producer_id and snapshot_id must not be empty")
        for element in self.elements:
            if element.ref.snapshot_id != self.snapshot_id:
                raise ValueError("every element ref must be bound to this snapshot")
