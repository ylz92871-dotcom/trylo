"""FrameRef contract (spec §7.2) and coordinate transforms.

A FrameRef always pairs the captured picture with the coordinate transform
needed to map between frame pixels and physical screen coordinates. Raw
``[x, y]`` pairs are never valid across spaces (§9.1); callers must go
through the affine.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from typing import Any, Literal

FrameStatus = Literal["complete", "idle", "occluded_fallback", "protected", "black", "degraded"]


def frame_id() -> str:
    """Opaque frame id (§15.3): no hwnd/pid material in the id itself."""
    return f"frm_{secrets.token_hex(16)}"


@dataclass(frozen=True, slots=True)
class Affine2D:
    """3×3 homogeneous affine: ``x' = a*x + b*y + tx``, ``y' = c*x + d*y + ty``."""

    a: float = 1.0
    b: float = 0.0
    tx: float = 0.0
    c: float = 0.0
    d: float = 1.0
    ty: float = 0.0

    def apply(self, x: float, y: float) -> tuple[float, float]:
        return (self.a * x + self.b * y + self.tx, self.c * x + self.d * y + self.ty)

    def inverse(self) -> "Affine2D":
        det = self.a * self.d - self.b * self.c
        if abs(det) < 1e-12:
            raise ValueError("affine transform is singular")
        ia = self.d / det
        ib = -self.b / det
        ic = -self.c / det
        idet = self.a / det
        itx = -(ia * self.tx + ib * self.ty)
        ity = -(ic * self.tx + idet * self.ty)
        return Affine2D(a=ia, b=ib, tx=itx, c=ic, d=idet, ty=ity)

    def to_dict(self) -> list[list[float]]:
        return [[self.a, self.b, self.tx], [self.c, self.d, self.ty]]


@dataclass(frozen=True, slots=True)
class FrameRef:
    """One versioned observation of a captured frame (§7.2)."""

    frame_id: str
    captured_at_qpc: int
    status: FrameStatus
    source_scope: Literal["exact_window", "application", "display", "virtual_desktop", "region"]
    backend: str
    pixel_width: int
    pixel_height: int
    desktop_bounds: tuple[int, int, int, int]
    client_bounds: tuple[int, int, int, int] | None
    content_rect: tuple[int, int, int, int]
    dpi_scale_x: float
    dpi_scale_y: float
    image_to_screen: Affine2D
    screen_to_image: Affine2D
    source_hwnd: int | None = None
    source_pid: int | None = None
    dirty_rects: tuple[tuple[int, int, int, int], ...] = field(default=())
    warnings: tuple[str, ...] = field(default=())

    def __post_init__(self) -> None:
        if self.pixel_width <= 0 or self.pixel_height <= 0:
            raise ValueError("frame pixel size must be positive")
        if self.status == "complete" and self.dpi_scale_x <= 0:
            raise ValueError("a complete frame needs a positive dpi scale")

    def to_dict(self) -> dict[str, Any]:
        return {
            "frame_id": self.frame_id,
            "captured_at_qpc": self.captured_at_qpc,
            "status": self.status,
            "source_scope": self.source_scope,
            "backend": self.backend,
            "pixel_width": self.pixel_width,
            "pixel_height": self.pixel_height,
            "desktop_bounds": list(self.desktop_bounds),
            "client_bounds": list(self.client_bounds) if self.client_bounds else None,
            "content_rect": list(self.content_rect),
            "dpi_scale_x": self.dpi_scale_x,
            "dpi_scale_y": self.dpi_scale_y,
            "image_to_screen": self.image_to_screen.to_dict(),
            "screen_to_image": self.screen_to_image.to_dict(),
            "source_hwnd": self.source_hwnd,
            "source_pid": self.source_pid,
            "dirty_rects": [list(r) for r in self.dirty_rects],
            "warnings": list(self.warnings),
        }
