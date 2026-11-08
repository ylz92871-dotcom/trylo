"""CaptureProvider contract and the raw per-provider frame product.

Providers own the OS-specific capture path; the service owns provider
selection, FrameRef construction, and degradation honesty (spec §6.4).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

from windows_mcp.capture.frames import FrameStatus


@dataclass(frozen=True, slots=True)
class CapturedFrame:
    """One raw capture product, pre-FrameRef (no transforms yet)."""

    png_bytes: bytes
    pixel_width: int
    pixel_height: int
    status: FrameStatus
    backend: str
    """Physical (per-monitor-DPI-aware) rects, ``(left, top, right, bottom)``:
    ``window_rect`` is the whole window, ``client_rect``'s size is the client
    area. The PNG covers the CLIENT area unless the provider says otherwise."""
    window_rect: tuple[int, int, int, int] | None = None
    client_size: tuple[int, int] | None = None
    warnings: tuple[str, ...] = field(default=())


class CaptureProvider(Protocol):
    """One capture backend. Implementations must be crash-isolated from the
    MCP server (separate process for native helpers) and must never block
    beyond ``deadline_seconds``."""

    @property
    def backend(self) -> str: ...

    def available(self) -> bool: ...

    def capture_exact_window(
        self,
        hwnd: int,
        *,
        max_frames: int = 1,
        interval_ms: int = 200,
        deadline_seconds: float = 15.0,
    ) -> tuple[CapturedFrame | None, Literal["captured", "idle", "unavailable"]]:
        """Capture ``max_frames`` of one exact window.

        Returns ``(frame, outcome)``; ``outcome`` distinguishes a real frame
        ("captured") from a window that produced nothing while staying alive
        ("idle" — minimized windows do this) from a backend that cannot serve
        this window at all ("unavailable")."""
        ...
