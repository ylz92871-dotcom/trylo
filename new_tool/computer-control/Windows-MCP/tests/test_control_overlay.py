"""Receipt, capture and native lifecycle boundaries without real user input."""

from unittest.mock import Mock

import pytest

from windows_mcp.desktop import control_overlay as overlay
from windows_mcp.desktop.control_visuals import GOLD, render_cursor, render_halo
from windows_mcp.desktop.service import Desktop
from windows_mcp.runtime.results import DispatchStatus


@pytest.fixture(autouse=True)
def reset():
    overlay.cancel()
    yield
    overlay.cancel()
    assert overlay._capture_depth == 0


def test_halo_centre_remains_transparent_at_dpi_scales():
    for scale in (1, 1.25, 2):
        image = render_halo(640, 400, scale)
        assert image.getpixel((320, 200))[3] == 0
        assert image.getpixel((3, 200))[:3] == GOLD
        assert image.getpixel((3, 200))[3] > image.getpixel((25, 200))[3]
        assert render_cursor(scale).size == (round(88*scale), round(88*scale))


@pytest.mark.parametrize("result", [None, {"takeover": "yielded"},
                                    {"dispatch_status": DispatchStatus.POSSIBLE},
                                    {"dispatch_status": "rejected"}])
def test_failed_uncertain_and_yielded_operations_never_emit_click(result):
    activity = overlay._Activity()
    overlay.finish(activity, result, click=True)
    assert activity.stop.is_set()
    assert activity.point is None
    assert activity.click_at is None


def test_success_uses_resolved_physical_receipt_including_negative_monitor():
    activity = overlay._Activity()
    overlay.finish(activity, {"loc": [-1300, 250], "dispatch_status": DispatchStatus.ACCEPTED},
                   click=True)
    assert activity.point == (-1300, 250)
    assert activity.click_at is not None
    assert not activity.active
    assert not activity.stop.is_set()


def test_capture_acknowledgement_is_nested_and_restored_on_error():
    activity = overlay._Activity()
    activity.hidden.set()
    overlay._current = activity
    with pytest.raises(ValueError):
        with overlay.hidden_for_capture():
            assert overlay._capture_depth == 1
            with overlay.hidden_for_capture():
                assert overlay._capture_depth == 2
                raise ValueError("capture failed")
    assert overlay._capture_depth == 0
    activity.closed.set()


def test_capture_refuses_pixels_if_window_thread_cannot_hide(monkeypatch):
    activity = overlay._Activity()
    activity.hidden = Mock(wait=Mock(return_value=False))
    activity.closed = Mock(is_set=Mock(return_value=False), wait=Mock(return_value=False))
    overlay._current = activity
    with pytest.raises(RuntimeError, match="did not hide"):
        with overlay.hidden_for_capture():
            pytest.fail("capture must not run with an unhidden overlay")
    assert activity.stop.is_set()
    assert overlay._capture_depth == 0


def test_dispatch_exception_and_yield_clear_feedback(monkeypatch):
    activity = overlay._Activity()
    monkeypatch.setattr(overlay, "begin", lambda: activity)
    desktop = Desktop.__new__(Desktop)
    desktop._mutation_takeover_inner = Mock(side_effect=RuntimeError("failed"))
    with pytest.raises(RuntimeError):
        desktop._mutation_takeover(lambda: {})
    assert activity.stop.is_set()
    activity = overlay._Activity()
    desktop._mutation_takeover_inner = lambda dispatch: {"takeover": "yielded", "loc": [10, 10]}
    desktop._mutation_takeover(lambda: {}, feedback_click=True)
    assert activity.stop.is_set()
    assert activity.point is None


def test_refused_operation_does_not_start_feedback(monkeypatch):
    begin = Mock()
    monkeypatch.setattr(overlay, "begin", begin)
    desktop = Desktop.__new__(Desktop)
    desktop._takeover_terminal = "yielded"
    desktop._mutation_takeover_inner = Mock(side_effect=RuntimeError("refused"))
    with pytest.raises(RuntimeError):
        desktop._mutation_takeover(lambda: {})
    begin.assert_not_called()


def test_screenshot_capture_runs_only_inside_hidden_scope(monkeypatch):
    from PIL import Image
    from windows_mcp.desktop import service

    events = []
    monkeypatch.setattr(service.flash_overlay, "cancel_active_flash", lambda: None)
    monkeypatch.setattr(service.flash_overlay, "show_capture_flash", lambda rect: events.append("flash"))

    def capture(rect):
        assert overlay._capture_depth == 1
        events.append("capture")
        return Image.new("RGB", (10, 10)), "test"

    monkeypatch.setattr(service.screenshot_capture, "capture", capture)
    desktop = Desktop.__new__(Desktop)
    desktop.get_screenshot()
    assert events == ["capture", "flash"]
    activity = overlay._Activity()
    activity.hidden.set()
    overlay._current = activity
    desktop.get_screenshot()
    assert events == ["capture", "flash", "capture"]
    activity.closed.set()


def test_exact_window_provider_also_waits_for_hidden_overlay(monkeypatch):
    from windows_mcp.capture import CaptureService

    class Provider:
        backend = "fake"

        def capture_exact_window(self, *args, **kwargs):
            assert overlay._capture_depth == 1
            return None, "idle"

    service = CaptureService(legacy=Provider())
    monkeypatch.setenv("WINDOWS_MCP_CAPTURE_WGC", "off")
    assert service.capture_exact_window(123) == (None, "idle")
