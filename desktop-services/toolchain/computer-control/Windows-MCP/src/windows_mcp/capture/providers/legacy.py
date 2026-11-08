"""Legacy provider: the existing dxcam/mss/pillow desktop capture path.

It cannot produce an exact-window DWM surface (spec §6.4), so every frame
it returns carries ``status="degraded"`` and an explicit warning — honest
fallback, never a masquerade (I-09).
"""

from __future__ import annotations

import io

import win32gui
from typing import Literal

from windows_mcp.capture.providers.base import CapturedFrame
from windows_mcp.desktop import screenshot as _screenshot


class LegacyCaptureProvider:
    backend = "legacy_desktop_crop"

    def available(self) -> bool:
        return True

    def capture_exact_window(
        self,
        hwnd: int,
        *,
        max_frames: int = 1,
        interval_ms: int = 200,
        deadline_seconds: float = 15.0,
    ) -> tuple[CapturedFrame | None, Literal["captured", "idle", "unavailable"]]:
        del max_frames, interval_ms, deadline_seconds
        if not win32gui.IsWindow(hwnd):
            return None, "unavailable"
        try:
            left, top, right, bottom = win32gui.GetWindowRect(hwnd)
            width, height = max(1, right - left), max(1, bottom - top)
            image, backend_name = _screenshot.capture(
                _screenshot.uia.Rect(left, top, right, bottom)
            )
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            png = buffer.getvalue()
        except Exception:
            return None, "unavailable"
        if not png:
            return None, "unavailable"
        return (
            CapturedFrame(
                png_bytes=png,
                pixel_width=width,
                pixel_height=height,
                status="degraded",
                backend=f"legacy:{backend_name}",
                window_rect=(left, top, right, bottom),
                client_size=(width, height),
                warnings=(
                    "legacy capture crops the desktop at the window rect; "
                    "occluding windows appear in the frame",
                ),
            ),
            "captured",
        )
