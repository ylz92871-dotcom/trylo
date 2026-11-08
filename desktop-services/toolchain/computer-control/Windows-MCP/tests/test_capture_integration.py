"""CaptureService ↔ Snapshot/verifier integration (WCC-P1-06 follow-up).

- frame_changed predicate: only complete digests can confirm; missing or
  degraded frames evaluate UNKNOWN (never fabricated evidence);
- verifier: frame-scoped predicates read pixel evidence via frame_reader;
- Desktop frame commands (capture_exact_window_frame / frame_digest_for_window);
- Snapshot/Screenshot scope='window'/'foreground_window' routing (flag off
  must degrade to the legacy provider, clearly labeled);
- WaitFor frame_changed condition.
"""

import hashlib

import windows_mcp.desktop.service as windows_mcp_desktop_service
from typing import Any


from windows_mcp.capture import CapturedFrame
from windows_mcp.runtime.clock import FakeClock
from windows_mcp.runtime.predicates import PredicateTruth, frame_changed
from windows_mcp.runtime.verifier import PostconditionVerifier
from windows_mcp.runtime.results import TargetReceipt
from windows_mcp.runtime.target_resolver import ResolvedTarget


def _target(hwnd: int | None = 7) -> ResolvedTarget:
    return ResolvedTarget(
        receipt=TargetReceipt(
            target_kind="element", description="t", window_handle=hwnd
        ),
        screen_point=(1, 1),
        source="test",
    )


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class FakeCaptureService:
    """Scriptable CaptureService double for Desktop-level tests."""

    def __init__(self, frames: list[tuple[CapturedFrame | None, str]]):
        self._frames = iter(frames)
        self.store = _FakeStore()

    def capture_exact_window(self, hwnd: int):
        try:
            frame, outcome = next(self._frames)
        except StopIteration:
            frame, outcome = None, "unavailable"
        if frame is None:
            return None, outcome
        # Mirror the real CaptureService contract: (FrameRef, outcome).
        ref = _ref_for(frame)
        self.store.put(ref, frame.png_bytes)
        return ref, outcome


class _FakeWindow:
    def __init__(self, handle: int, process_id: int, name: str = "Notepad"):
        self.handle = handle
        self.process_id = process_id
        self.name = name


class _FakeStore:
    def __init__(self) -> None:
        self._items: dict[str, bytes] = {}

    def put(self, ref: Any, png: bytes) -> None:
        self._items[ref.frame_id] = png

    def get(self, frame_id: str):
        png = self._items.get(frame_id)
        return (object(), png) if png is not None else None


def _ref_for(frame: CapturedFrame):
    from windows_mcp.capture import FrameRef, Affine2D, frame_id

    return FrameRef(
        frame_id=frame_id(),
        captured_at_qpc=1,
        status=frame.status,
        source_scope="exact_window",
        backend=frame.backend,
        pixel_width=frame.pixel_width,
        pixel_height=frame.pixel_height,
        desktop_bounds=frame.window_rect or (0, 0, 10, 10),
        client_bounds=None,
        content_rect=(0, 0, frame.pixel_width, frame.pixel_height),
        dpi_scale_x=1.0,
        dpi_scale_y=1.0,
        image_to_screen=Affine2D(),
        screen_to_image=Affine2D(),
        warnings=frame.warnings,
    )


def _complete_frame(png: bytes = b"frame-a") -> CapturedFrame:
    return CapturedFrame(
        png_bytes=png,
        pixel_width=100,
        pixel_height=60,
        status="complete",
        backend="wgc",
        window_rect=(0, 0, 100, 60),
        client_size=(100, 60),
    )


# ── frame_changed predicate ──────────────────────────────────────────────


def test_frame_changed_requires_complete_digests_on_both_sides() -> None:
    predicate = frame_changed()
    assert predicate.description == "frame.frame_digest_frame_changed"
    # Missing / None / non-string digests are UNKNOWN — never confirmation.
    assert predicate.evaluate({}, {"frame_digest": "x"}) is PredicateTruth.UNKNOWN
    assert predicate.evaluate({"frame_digest": None}, {"frame_digest": "x"}) is PredicateTruth.UNKNOWN
    assert predicate.evaluate({"frame_digest": "a"}, {"frame_digest": None}) is PredicateTruth.UNKNOWN
    # Complete digests: differ → TRUE, equal → FALSE.
    assert predicate.evaluate({"frame_digest": "a"}, {"frame_digest": "b"}) is PredicateTruth.TRUE
    assert predicate.evaluate({"frame_digest": "a"}, {"frame_digest": "a"}) is PredicateTruth.FALSE


def test_verifier_frame_predicate_confirms_only_on_complete_change() -> None:
    digests = iter([_digest(b"before"), _digest(b"after")])

    def frame_reader(target):
        return {"frame_digest": next(digests), "frame_status": "complete"}

    clock = FakeClock()
    verifier = PostconditionVerifier(
        lambda target: {}, clock=clock, sleeper=clock.advance, frame_reader=frame_reader
    )
    handle = verifier.prepare(_target(), pre_revision=1, predicates=(frame_changed(),))
    result = verifier.observe_after_dispatch(
        handle, frame_changed(), earliest_qpc=handle.prepared_at_qpc, timeout_seconds=2.0
    )
    assert result.truth is PredicateTruth.TRUE
    assert result.evidence is not None
    assert result.evidence.predicate == "frame.frame_digest_frame_changed"


def test_verifier_degraded_frames_stay_unknown() -> None:
    def frame_reader(target):
        # The provider could not honestly produce a complete frame.
        return {"frame_digest": None, "frame_status": "idle"}

    clock = FakeClock()
    verifier = PostconditionVerifier(
        lambda target: {}, clock=clock, sleeper=clock.advance, frame_reader=frame_reader
    )
    handle = verifier.prepare(_target(), pre_revision=1, predicates=(frame_changed(),))
    result = verifier.observe_after_dispatch(
        handle, frame_changed(), earliest_qpc=handle.prepared_at_qpc, timeout_seconds=0.2
    )
    assert result.truth is PredicateTruth.UNKNOWN
    assert result.evidence is None


def test_verifier_frame_baseline_fails_open_to_unknown(monkeypatch) -> None:
    def broken_reader(target):
        raise RuntimeError("helper dead")

    clock = FakeClock()
    verifier = PostconditionVerifier(
        lambda target: {}, clock=clock, sleeper=clock.advance, frame_reader=broken_reader
    )
    handle = verifier.prepare(_target(), pre_revision=1, predicates=(frame_changed(),))
    result = verifier.observe_after_dispatch(
        handle, frame_changed(), earliest_qpc=handle.prepared_at_qpc, timeout_seconds=0.1
    )
    assert result.truth is PredicateTruth.UNKNOWN


def test_verifier_without_frame_reader_never_confirms_frame_predicate() -> None:
    clock = FakeClock()
    verifier = PostconditionVerifier(lambda target: {}, clock=clock, sleeper=clock.advance)
    handle = verifier.prepare(_target(), pre_revision=1, predicates=(frame_changed(),))
    result = verifier.observe_after_dispatch(
        handle, frame_changed(), earliest_qpc=handle.prepared_at_qpc, timeout_seconds=0.1
    )
    assert result.truth is PredicateTruth.UNKNOWN


# ── Desktop frame commands ───────────────────────────────────────────────


def _desktop_with_capture(frames) -> Any:
    from windows_mcp.desktop.service import Desktop

    desktop = Desktop.__new__(Desktop)
    desktop._capture_service = FakeCaptureService(frames)
    return desktop


def test_desktop_capture_exact_window_frame_returns_dto() -> None:
    desktop = _desktop_with_capture([(_complete_frame(b"png-a"), "captured")])
    result = desktop.capture_exact_window_frame(hwnd=7, window_name=None)
    assert result["outcome"] == "captured"
    assert result["frame"]["status"] == "complete"
    assert result["png_bytes"] == b"png-a"


def test_desktop_frame_evidence_reader_digests_complete_frames() -> None:
    desktop = _desktop_with_capture([(_complete_frame(b"png-a"), "captured")])
    evidence = desktop._frame_evidence(_target(7))
    assert evidence["frame_digest"] == _digest(b"png-a")
    assert evidence["frame_status"] == "complete"


def test_desktop_frame_evidence_reader_degrades_on_idle() -> None:
    desktop = _desktop_with_capture([(None, "idle")])
    evidence = desktop._frame_evidence(_target(7))
    assert evidence["frame_digest"] is None
    assert evidence["frame_status"] == "idle"


def test_desktop_frame_digest_for_window(monkeypatch) -> None:
    from windows_mcp.desktop.service import Desktop

    desktop = _desktop_with_capture([(_complete_frame(b"png-w"), "captured")])
    monkeypatch.setattr(
        Desktop,
        "_find_window_by_name",
        lambda self, name, refresh_state=False: (_FakeWindow(7, 700), ""),
    )
    digest, status = desktop.frame_digest_for_window("Notepad")
    assert digest == _digest(b"png-w")
    assert status == "complete"


# ── Snapshot/Screenshot scope routing ────────────────────────────────────


class _FakeMCP:
    def __init__(self) -> None:
        self.tools: dict[str, Any] = {}

    def tool(self, *, name: str, **kwargs: Any):
        def decorator(func):
            self.tools[name] = func
            return func

        return decorator


def _register_tools(desktop):
    from windows_mcp.tools.snapshot import register

    register(_FakeMCP(), get_desktop=lambda: desktop, get_analytics=lambda: None)
    return None


def test_snapshot_scope_window_routes_to_exact_window(monkeypatch) -> None:
    import windows_mcp.tools.snapshot as snapshot_module
    import windows_mcp.desktop.service as windows_mcp_desktop_service

    desktop = _desktop_with_capture([(_complete_frame(b"wgc-png"), "captured")])
    monkeypatch.setattr(
        windows_mcp_desktop_service.Desktop,
        "_find_window_by_name",
        lambda self, name, refresh_state=False: (_FakeWindow(7, 700), ""),
    )
    captured: dict = {}

    original = desktop.capture_exact_window_frame

    def fake_capture(hwnd=None, window_name=None):
        captured["kwargs"] = (hwnd, window_name)
        return original(hwnd, window_name)

    monkeypatch.setattr(desktop, "capture_exact_window_frame", fake_capture, raising=False)
    response = snapshot_module._exact_window_response(desktop, "window", "Notepad")
    text = response[0]
    assert "Capture scope: window" in text
    assert "FrameRef:" in text
    assert "Outcome: captured" in text
    assert len(response) == 2  # text + Image
    assert captured["kwargs"] == (None, "Notepad")


def test_snapshot_scope_degraded_labels_legacy_fallback(monkeypatch) -> None:
    degraded = CapturedFrame(
        png_bytes=b"crop",
        pixel_width=100,
        pixel_height=60,
        status="degraded",
        backend="legacy:pillow",
        window_rect=(0, 0, 100, 60),
        client_size=(100, 60),
        warnings=("legacy capture crops the desktop at the window rect; "
                  "occluding windows appear in the frame",),
    )
    desktop = _desktop_with_capture([(degraded, "captured")])
    monkeypatch.setattr(
        windows_mcp_desktop_service.Desktop,
        "_find_window_by_name",
        lambda self, name, refresh_state=False: (_FakeWindow(7, 700), ""),
    )
    response = desktop_capture_response(desktop, "foreground_window")
    assert "Outcome: captured" in response[0]
    assert "WARNING: legacy capture crops the desktop" in response[0]
    assert '"status": "degraded"' in response[0]


def desktop_capture_response(desktop, scope: str):
    from windows_mcp.tools.snapshot import _exact_window_response

    return _exact_window_response(desktop, scope, None)


def test_snapshot_scope_unavailable_has_no_image(monkeypatch) -> None:
    desktop = _desktop_with_capture([(None, "unavailable")])
    response = desktop_capture_response(desktop, "window")
    assert "Outcome: unavailable" in response[0]
    assert len(response) == 1


# ── WaitFor frame_changed ────────────────────────────────────────────────


def test_wait_for_frame_changed_condition(monkeypatch) -> None:
    import asyncio

    from windows_mcp.tools.input import register

    digests = iter([None, _digest(b"f1"), _digest(b"f1"), _digest(b"f2")])

    class WaitDesktop:
        def frame_digest_for_window(self, window_name=None):
            return next(digests), "complete"

        def get_state(self, **kwargs):
            raise RuntimeError("frame_changed must not poll the desktop state")

    mcp = _FakeMCP()
    register(mcp, get_desktop=lambda: WaitDesktop(), get_analytics=lambda: None)
    result = asyncio.run(
        mcp.tools["WaitFor"](
            condition="frame_changed", window_name="Notepad", timeout=5.0, interval=0.01
        )
    )
    assert "frame content changed" in result
