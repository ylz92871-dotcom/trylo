"""WCC-P1-06: CaptureService / FrameRef / provider tests.

Real capture is exercised by the live-fire spike (scripts/wgc_spike.py);
these tests pin the contracts with fakes:
- FrameRef affine round-trips frame↔screen and maps the client origin;
- provider selection: flag off / helper missing → legacy (honest degraded);
- WGC protocol parsing against a scripted fake helper process;
- degraded/idle/unavailable mapping (minimized windows produce no frames);
- FrameStore bounds.
"""

import base64
import io
import json
import struct

import pytest

from windows_mcp.capture import (
    Affine2D,
    CapturedFrame,
    CaptureService,
    FrameRef,
    FrameStore,
    LegacyCaptureProvider,
    WgcProvider,
    wgc_flag_enabled,
)
from windows_mcp.capture.providers.base import CaptureProvider


# ── fakes ────────────────────────────────────────────────────────────────


class FakeProvider(CaptureProvider):
    backend = "fake"

    def __init__(self, frame: CapturedFrame | None, outcome="captured"):
        self._frame = frame
        self._outcome = outcome

    def available(self) -> bool:
        return True

    def capture_exact_window(self, hwnd, *, max_frames=1, interval_ms=200, deadline_seconds=15.0):
        return self._frame, self._outcome


def _complete_frame(**overrides) -> CapturedFrame:
    fields = dict(
        png_bytes=b"png-bytes",
        pixel_width=696,
        pixel_height=421,
        status="complete",
        backend="wgc",
        window_rect=(180, 180, 900, 660),
        client_size=(696, 421),
    )
    fields.update(overrides)
    return CapturedFrame(**fields)


# ── FrameRef contract ────────────────────────────────────────────────────


def test_frame_ref_affine_maps_client_origin_to_screen() -> None:
    image_to_screen = Affine2D(a=1.0, d=1.0, tx=180.0, ty=180.0)
    x, y = image_to_screen.apply(0, 0)
    assert (x, y) == (180.0, 180.0)
    back = image_to_screen.inverse()
    assert back.apply(180.0, 180.0) == (0.0, 0.0)
    # Frame pixel (100, 50) → screen (280, 230), and back.
    assert image_to_screen.apply(100, 50) == (280.0, 230.0)
    assert back.apply(280.0, 230.0) == (100.0, 50.0)


def test_frame_ref_to_dict_field_names_and_affine_roundtrip() -> None:
    ref = FrameRef(
        frame_id="frm_test",
        captured_at_qpc=1,
        status="complete",
        source_scope="exact_window",
        backend="wgc",
        pixel_width=696,
        pixel_height=421,
        desktop_bounds=(180, 180, 900, 660),
        client_bounds=(180, 180, 876, 601),
        content_rect=(0, 0, 696, 421),
        dpi_scale_x=1.0,
        dpi_scale_y=1.0,
        image_to_screen=Affine2D(a=1.0, d=1.0, tx=180.0, ty=180.0),
        screen_to_image=Affine2D(a=1.0, d=1.0, tx=-180.0, ty=-180.0),
        source_hwnd=7,
    )
    payload = ref.to_dict()
    expected_fields = {
        "frame_id", "captured_at_qpc", "status", "source_scope", "backend",
        "pixel_width", "pixel_height", "desktop_bounds", "client_bounds",
        "content_rect", "dpi_scale_x", "dpi_scale_y", "image_to_screen",
        "screen_to_image", "source_hwnd", "source_pid", "dirty_rects", "warnings",
    }
    assert set(payload) == expected_fields
    assert payload["image_to_screen"] == [[1.0, 0.0, 180.0], [0.0, 1.0, 180.0]]
    assert payload["status"] == "complete"


def test_frame_ref_rejects_zero_size() -> None:
    with pytest.raises(ValueError):
        FrameRef(
            frame_id="frm_bad", captured_at_qpc=1, status="complete",
            source_scope="exact_window", backend="wgc", pixel_width=0,
            pixel_height=10, desktop_bounds=(0, 0, 1, 1), client_bounds=None,
            content_rect=(0, 0, 0, 10), dpi_scale_x=1.0, dpi_scale_y=1.0,
            image_to_screen=Affine2D(), screen_to_image=Affine2D(),
        )


# ── service: provider selection + ref construction ───────────────────────


def test_service_flag_off_uses_legacy(monkeypatch) -> None:
    monkeypatch.delenv("WINDOWS_MCP_CAPTURE_WGC", raising=False)
    assert wgc_flag_enabled() is False
    service = CaptureService()
    assert service.backend_name() == "legacy_desktop_crop"


def test_service_flag_on_without_helper_falls_back_to_legacy(monkeypatch) -> None:
    monkeypatch.setenv("WINDOWS_MCP_CAPTURE_WGC", "on")
    service = CaptureService(wgc=WgcProvider(helper_path=None))
    assert service.backend_name() == "legacy_desktop_crop"


def test_service_flag_on_selects_wgc(monkeypatch) -> None:
    monkeypatch.setenv("WINDOWS_MCP_CAPTURE_WGC", "on")
    service = CaptureService(wgc=FakeProvider(_complete_frame()))
    assert service.backend_name() == "fake"


def test_service_builds_exact_window_ref(monkeypatch) -> None:
    monkeypatch.setenv("WINDOWS_MCP_CAPTURE_WGC", "on")
    service = CaptureService(wgc=FakeProvider(_complete_frame()))
    ref, outcome = service.capture_exact_window(7)
    assert outcome == "captured"
    assert isinstance(ref, FrameRef)
    assert ref.status == "complete"
    assert ref.source_scope == "exact_window"
    assert ref.pixel_width == 696 and ref.pixel_height == 421
    assert ref.dpi_scale_x == pytest.approx(1.0)
    # The affine anchors frame (0,0) at the client origin: the client is
    # centered horizontally in the window (720−696)/2 = 12, and flush to the
    # title bar vertically (720−421 window height minus borders = 180 top).
    assert ref.image_to_screen.apply(0, 0)[0] == pytest.approx(192.0)
    assert service.store.get(ref.frame_id) is not None


def test_service_reports_idle_when_window_produces_no_frames(monkeypatch) -> None:
    monkeypatch.setenv("WINDOWS_MCP_CAPTURE_WGC", "on")
    service = CaptureService(wgc=FakeProvider(None, outcome="idle"))
    ref, outcome = service.capture_exact_window(7)
    assert ref is None and outcome == "idle"


def test_service_reports_unavailable_without_frame(monkeypatch) -> None:
    service = CaptureService(legacy=FakeProvider(None, outcome="unavailable"))
    ref, outcome = service.capture_exact_window(7)
    assert ref is None and outcome == "unavailable"


def test_legacy_provider_flags_degraded(monkeypatch) -> None:
    """The desktop-crop fallback must never claim exact-window quality."""
    import win32gui

    monkeypatch.setattr(win32gui, "IsWindow", lambda hwnd: True)
    monkeypatch.setattr(win32gui, "GetWindowRect", lambda hwnd: (0, 0, 100, 60))
    import windows_mcp.capture.providers.legacy as legacy_module
    from PIL import Image

    def fake_capture(rect, backend=None):
        return Image.new("RGB", (100, 60)), "pillow"

    monkeypatch.setattr(legacy_module._screenshot, "capture", fake_capture)
    provider = LegacyCaptureProvider()
    frame, outcome = provider.capture_exact_window(7)
    assert outcome == "captured"
    assert frame is not None
    assert frame.status == "degraded"
    assert any("occluding" in warning for warning in frame.warnings)


# ── WGC provider protocol parsing (scripted fake process) ────────────────


class FakeHelperProcess:
    def __init__(self, script: list[dict], stdin_ok=True):
        self.buffer = io.BytesIO()
        for message in script:
            data = json.dumps(message).encode()
            self.buffer.write(struct.pack("<I", len(data)) + data)
        self.buffer.seek(0)
        self.stdin = io.BytesIO()
        self.stdout = self
        self.killed = False

    def read(self, n):
        return self.buffer.read(n)

    def write(self, data):
        self.stdin.write(data)
        return len(data)

    def flush(self):
        return

    def close(self):
        return

    def wait(self, timeout=None):
        return 0

    def kill(self):
        self.killed = True


def _frame_message(**overrides) -> dict:
    message = {
        "type": "frame",
        "hwnd": 7,
        "status": "complete",
        "contentWidth": 696,
        "contentHeight": 421,
        "windowRect": [180, 180, 900, 660],
        "clientSize": [696, 421],
        "systemRelativeTimeTicks": 42,
        "pngBase64": base64.b64encode(b"png").decode(),
    }
    message.update(overrides)
    return message


def test_wgc_provider_parses_scripted_burst(monkeypatch) -> None:
    provider = WgcProvider(helper_path=__file__)  # any existing file
    monkeypatch.setattr(
        "windows_mcp.capture.providers.wgc.subprocess.Popen",
        lambda *a, **k: FakeHelperProcess(
            [
                {"type": "hello", "version": 1, "ok": True, "captureSupported": True},
                _frame_message(),
                {"type": "done", "frames": 1},
            ]
        ),
    )
    frame, outcome = provider.capture_exact_window(7)
    assert outcome == "captured"
    assert frame is not None
    assert frame.status == "complete"
    assert frame.png_bytes == b"png"
    assert frame.window_rect == (180, 180, 900, 660)
    assert frame.client_size == (696, 421)


def test_wgc_provider_unavailable_window(monkeypatch) -> None:
    provider = WgcProvider(helper_path=__file__)
    monkeypatch.setattr(
        "windows_mcp.capture.providers.wgc.subprocess.Popen",
        lambda *a, **k: FakeHelperProcess(
            [
                {"type": "hello", "version": 1, "ok": True, "captureSupported": True},
                {"type": "error", "code": "window_unavailable"},
            ]
        ),
    )
    frame, outcome = provider.capture_exact_window(999999)
    assert frame is None and outcome == "unavailable"


def test_wgc_provider_minimized_maps_to_idle(monkeypatch) -> None:
    provider = WgcProvider(helper_path=__file__)
    monkeypatch.setattr(
        "windows_mcp.capture.providers.wgc.subprocess.Popen",
        lambda *a, **k: FakeHelperProcess(
            [
                {"type": "hello", "version": 1, "ok": True, "captureSupported": True},
                {"type": "done", "frames": 0},
            ]
        ),
    )
    frame, outcome = provider.capture_exact_window(7)
    assert frame is None and outcome == "idle"


def test_wgc_provider_broken_pipe_is_unavailable(monkeypatch) -> None:
    provider = WgcProvider(helper_path=__file__)

    class BrokenPipe:
        def write(self, data):
            raise OSError("pipe closed")

        def flush(self):
            raise OSError("pipe closed")

        def close(self):
            return

    class Broken:
        stdin = BrokenPipe()
        stdout = BrokenPipe()

        def wait(self, timeout=None):
            return 1

        def kill(self):
            return

    monkeypatch.setattr(
        "windows_mcp.capture.providers.wgc.subprocess.Popen", lambda *a, **k: Broken()
    )
    frame, outcome = provider.capture_exact_window(7)
    assert frame is None and outcome == "unavailable"


# ── FrameStore bounds ────────────────────────────────────────────────────


def test_frame_store_evicts_oldest_and_honors_byte_cap() -> None:
    store = FrameStore(max_frames=2, max_bytes=10_000)

    def _ref(fid):
        return FrameRef(
            frame_id=fid, captured_at_qpc=1, status="complete",
            source_scope="exact_window", backend="wgc", pixel_width=4,
            pixel_height=4, desktop_bounds=(0, 0, 4, 4), client_bounds=None,
            content_rect=(0, 0, 4, 4), dpi_scale_x=1.0, dpi_scale_y=1.0,
            image_to_screen=Affine2D(), screen_to_image=Affine2D(),
        )

    store.put(_ref("a"), b"x" * 100)
    store.put(_ref("b"), b"y" * 100)
    store.put(_ref("c"), b"z" * 100)
    assert len(store) == 2
    assert store.get("a") is None
    assert store.get("c") is not None
