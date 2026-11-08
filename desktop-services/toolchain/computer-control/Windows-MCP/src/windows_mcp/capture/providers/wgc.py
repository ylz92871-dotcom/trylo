"""WGC provider: drives the .NET ``trylo-wgc-helper`` over its stdio protocol.

Isolation model (spike-verified, WCC-P1-06): the helper is a separate
process with a one-burst lifetime — a native capture crash takes one
observation, never the server. The helper reports physical-pixel window
rects (it is per-monitor DPI aware) and the frame's PNG covers the client
area.
"""

from __future__ import annotations

import json
import os
import struct
import subprocess
import time
from pathlib import Path
from typing import Any, Literal

from windows_mcp.capture.providers.base import CapturedFrame

_MAX_FRAME_BYTES = 64 * 1024 * 1024


def default_helper_path() -> Path | None:
    """Locate the pinned helper artifact. ``WINDOWS_MCP_WGC_HELPER`` wins;
    the repo-relative path covers dev/test runs."""
    override = os.getenv("WINDOWS_MCP_WGC_HELPER")
    if override:
        path = Path(override)
        return path if path.is_file() else None
    root = Path(__file__).resolve().parents[3]
    path = root / "native" / "wgc-helper" / "bin" / "Release" / "net8.0-windows10.0.19041.0" / "win-x64" / "trylo-wgc-helper.exe"
    return path if path.is_file() else None


class WgcProvider:
    backend = "wgc"

    def __init__(self, helper_path: Path | None = None) -> None:
        self._helper_path = helper_path if helper_path is not None else default_helper_path()
        self._supported: bool | None = None

    def available(self) -> bool:
        return self._helper_path is not None

    def capture_exact_window(
        self,
        hwnd: int,
        *,
        max_frames: int = 1,
        interval_ms: int = 200,
        deadline_seconds: float = 15.0,
    ) -> tuple[CapturedFrame | None, Literal["captured", "idle", "unavailable"]]:
        if not self.available():
            return None, "unavailable"
        try:
            proc = subprocess.Popen(
                [str(self._helper_path)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except OSError:
            return None, "unavailable"
        try:
            return self._run_burst(proc, hwnd, max_frames=max_frames, interval_ms=interval_ms,
                                   deadline_seconds=deadline_seconds)
        finally:
            _close_burst(proc)

    def _run_burst(
        self,
        proc: subprocess.Popen,
        hwnd: int,
        *,
        max_frames: int,
        interval_ms: int,
        deadline_seconds: float,
    ) -> tuple[CapturedFrame | None, Literal["captured", "idle", "unavailable"]]:
        deadline = time.monotonic() + deadline_seconds
        try:
            _write(proc, {"cmd": "hello"})
            hello = _read(proc, deadline)
            if hello is None or hello.get("type") != "hello":
                return None, "unavailable"
            self._supported = bool(hello.get("captureSupported"))
            if not self._supported:
                return None, "unavailable"

            _write(proc, {"cmd": "capture", "hwnd": int(hwnd), "maxFrames": max_frames,
                          "intervalMs": interval_ms})
            frames: list[CapturedFrame] = []
            while len(frames) < max_frames and time.monotonic() < deadline:
                message = _read(proc, deadline)
                if message is None:
                    break
                kind = message.get("type")
                if kind == "frame":
                    frames.append(_frame_from_message(message))
                elif kind == "error":
                    warning = f"wgc helper error: {message.get('code')}"
                    if frames:
                        frames[-1] = CapturedFrame(
                            **{**_as_dict(frames[-1]), "warnings": (*frames[-1].warnings, warning)},
                        )
                        break
                    return None, "unavailable"
                elif kind == "done":
                    break
            if frames:
                return frames[-1], "captured"
            return None, "idle"
        except (OSError, struct.error, json.JSONDecodeError, ValueError):
            # A broken helper pipe degrades this one observation; the burst
            # process model keeps the server alive regardless.
            return None, "unavailable"


def _as_dict(frame: CapturedFrame) -> dict[str, Any]:
    return {
        "png_bytes": frame.png_bytes,
        "pixel_width": frame.pixel_width,
        "pixel_height": frame.pixel_height,
        "status": frame.status,
        "backend": frame.backend,
        "window_rect": frame.window_rect,
        "client_size": frame.client_size,
        "warnings": frame.warnings,
    }


def _frame_from_message(message: dict[str, Any]) -> CapturedFrame:
    png = message.get("pngBase64", "")
    import base64

    window_rect = message.get("windowRect")
    client_size = message.get("clientSize")
    return CapturedFrame(
        png_bytes=base64.b64decode(png),
        pixel_width=int(message["contentWidth"]),
        pixel_height=int(message["contentHeight"]),
        status="complete",
        backend="wgc",
        window_rect=tuple(window_rect) if window_rect else None,
        client_size=tuple(client_size) if client_size else None,
    )


def _write(proc: subprocess.Popen, payload: dict[str, Any]) -> None:
    data = json.dumps(payload).encode("utf-8")
    assert proc.stdin is not None
    proc.stdin.write(struct.pack("<I", len(data)) + data)
    proc.stdin.flush()


def _read(proc: subprocess.Popen, deadline: float) -> dict[str, Any] | None:
    assert proc.stdout is not None
    header = _read_exact(proc.stdout, 4, deadline)
    if header is None:
        return None
    (length,) = struct.unpack("<I", header)
    if length == 0 or length > _MAX_FRAME_BYTES:
        return None
    payload = _read_exact(proc.stdout, length, deadline)
    if payload is None:
        return None
    return json.loads(payload)


def _read_exact(stream, size: int, deadline: float) -> bytes | None:
    chunks: list[bytes] = []
    remaining = size
    while remaining > 0:
        if time.monotonic() > deadline:
            return None
        chunk = stream.read(min(remaining, 1 << 20))
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _close_burst(proc: subprocess.Popen) -> None:
    for pipe in (proc.stdin, proc.stdout):
        try:
            if pipe is not None:
                pipe.close()
        except OSError:
            pass
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
