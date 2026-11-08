"""CaptureService: provider selection + FrameRef construction (spec §6.4).

Scope this package serves first: ``exact_window``. The WGC provider is the
only one allowed to claim that scope honestly; the legacy desktop-crop path
degrades loudly (status ``degraded`` + warning, I-09) and is a fallback,
never a masquerade.
"""

from __future__ import annotations

import os
import time
from typing import Literal

from windows_mcp.capture.frame_store import FrameStore
from windows_mcp.capture.frames import Affine2D, FrameRef, frame_id
from windows_mcp.capture.providers.base import CapturedFrame, CaptureProvider
from windows_mcp.capture.providers.legacy import LegacyCaptureProvider
from windows_mcp.capture.providers.wgc import WgcProvider
from windows_mcp.runtime.metrics import METRICS


def wgc_flag_enabled() -> bool:
    value = os.getenv("WINDOWS_MCP_CAPTURE_WGC")
    if value is None:
        return False
    return value.strip().lower() in {"on", "1", "true", "yes", "enabled"}


class CaptureService:
    def __init__(
        self,
        *,
        wgc: CaptureProvider | None = None,
        legacy: CaptureProvider | None = None,
        store: FrameStore | None = None,
        clock: object | None = None,
    ) -> None:
        self._wgc = wgc if wgc is not None else WgcProvider()
        self._legacy = legacy if legacy is not None else LegacyCaptureProvider()
        self._store = store if store is not None else FrameStore()
        self._clock = clock or SystemClock()

    @property
    def store(self) -> FrameStore:
        return self._store

    def backend_name(self) -> str:
        """The backend an exact-window capture would use right now."""
        if wgc_flag_enabled() and self._wgc.available():
            return self._wgc.backend
        return self._legacy.backend

    def capture_exact_window(self, hwnd: int) -> tuple[FrameRef | None, Literal["captured", "idle", "unavailable"]]:
        from windows_mcp.desktop import control_overlay, flash_overlay

        provider = self._select_provider()
        flash_overlay.cancel_active_flash()
        with control_overlay.hidden_for_capture():
            frame, outcome = provider.capture_exact_window(hwnd, max_frames=1, interval_ms=250)
        if frame is None:
            return None, outcome
        if not control_overlay.is_active():
            flash_overlay.show_capture_flash()
        if frame.status == "degraded":
            # §18.3 capture_degraded_count: the honest-fallback path (I-09).
            # Best-effort; a metrics failure never degrades the frame.
            try:
                METRICS.inc("capture_degraded_count")
            except Exception:
                pass
        ref = self._build_ref(frame, hwnd)
        self._store.put(ref, frame.png_bytes)
        return ref, "captured"

    def _select_provider(self) -> CaptureProvider:
        if wgc_flag_enabled() and self._wgc.available():
            return self._wgc
        return self._legacy

    def _build_ref(self, frame: CapturedFrame, hwnd: int) -> FrameRef:
        window_rect = frame.window_rect
        client_size = frame.client_size
        if window_rect is not None and client_size is not None:
            # PNG covers the client area in physical pixels; the affine maps
            # frame pixels to the client origin's physical screen position.
            client_left = window_rect[0] + max(0, (window_rect[2] - window_rect[0] - client_size[0]) // 2)
            client_top = window_rect[1] + max(0, (window_rect[3] - window_rect[1] - client_size[1]) // 2)
            client_bounds = (client_left, client_top, client_left + client_size[0], client_top + client_size[1])
            image_to_screen = Affine2D(a=1.0, d=1.0, tx=float(client_left), ty=float(client_top))
        else:
            client_bounds = None
            image_to_screen = Affine2D()

        dpi_x = 1.0
        dpi_y = 1.0
        if client_size is not None and client_size[0] > 0:
            dpi_x = frame.pixel_width / client_size[0]
            dpi_y = frame.pixel_height / max(1, client_size[1])

        ref = FrameRef(
            frame_id=frame_id(),
            captured_at_qpc=int(time.perf_counter_ns()),
            status=frame.status,
            source_scope="exact_window",
            backend=frame.backend,
            pixel_width=frame.pixel_width,
            pixel_height=frame.pixel_height,
            desktop_bounds=window_rect if window_rect is not None else (0, 0, frame.pixel_width, frame.pixel_height),
            client_bounds=client_bounds,
            content_rect=(0, 0, frame.pixel_width, frame.pixel_height),
            dpi_scale_x=dpi_x,
            dpi_scale_y=dpi_y,
            image_to_screen=image_to_screen,
            screen_to_image=image_to_screen.inverse(),
            source_hwnd=hwnd,
            warnings=frame.warnings,
        )
        return ref


class SystemClock:
    def perf_counter_ns(self) -> int:
        return time.perf_counter_ns()
