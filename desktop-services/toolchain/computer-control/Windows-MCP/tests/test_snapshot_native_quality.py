import io
import hashlib
from pathlib import Path
from unittest.mock import MagicMock

from PIL import Image
import pytest

from windows_mcp.desktop.views import DesktopState
from windows_mcp.tree.views import TreeState
from windows_mcp.tools._snapshot_helpers import capture_desktop_state


@pytest.mark.parametrize("native", [False, True])
def test_native_preview_preserves_capture_size_and_png(native, monkeypatch):
    monkeypatch.setenv("WINDOWS_MCP_SCREENSHOT_NATIVE", "1" if native else "0")
    monkeypatch.setenv("WINDOWS_MCP_SCREENSHOT_SCALE", "0.5")
    desktop = MagicMock()
    desktop.get_state.return_value = DesktopState(
        active_desktop={}, all_desktops=[], active_window=None, windows=[],
        screenshot=Image.new("RGB", (2560, 1600)), tree_state=TreeState(),
    )
    result = capture_desktop_state(
        desktop, use_vision=True, use_dom=False, use_annotation=False,
        use_ui_tree=False, width_reference_line=None, height_reference_line=None,
        display=None, region=None, tool_name="Screenshot",
    )
    args = desktop.get_state.call_args.kwargs
    assert args["scale"] == (1.0 if native else 0.5)
    assert (args["max_image_size"] is None) == native
    with Image.open(io.BytesIO(result["screenshot_bytes"])) as image:
        assert image.format == "PNG"
        assert image.size == (2560, 1600)


def test_workbench_cache_keeps_original_while_model_image_fits_limit(monkeypatch, tmp_path):
    monkeypatch.setenv("WINDOWS_MCP_SCREENSHOT_NATIVE", "1")
    monkeypatch.setenv("WINDOWS_MCP_PREVIEW_CACHE", str(tmp_path))
    desktop = MagicMock()
    desktop.get_state.return_value = DesktopState(
        active_desktop={}, all_desktops=[], active_window=None, windows=[],
        screenshot=Image.new("RGB", (2560, 1600)), tree_state=TreeState(),
    )
    result = capture_desktop_state(
        desktop, use_vision=True, use_dom=False, use_annotation=False,
        use_ui_tree=False, width_reference_line=None, height_reference_line=None,
        display=None, region=None, tool_name="Screenshot",
    )
    ref = result["preview_ref"]
    original = Path(ref["path"]).read_bytes()
    assert hashlib.sha256(original).hexdigest() == ref["sha256"]
    with Image.open(io.BytesIO(original)) as image:
        assert image.size == (2560, 1600)
    with Image.open(io.BytesIO(result["screenshot_bytes"])) as image:
        assert image.size == (1728, 1080)
    assert result["desktop_state"].screenshot_scale == 0.675


def test_repeated_capture_reuses_immutable_original(monkeypatch, tmp_path):
    monkeypatch.setenv("WINDOWS_MCP_SCREENSHOT_NATIVE", "1")
    monkeypatch.setenv("WINDOWS_MCP_PREVIEW_CACHE", str(tmp_path))
    desktop = MagicMock()
    args = dict(
        use_vision=True, use_dom=False, use_annotation=False, use_ui_tree=False,
        width_reference_line=None, height_reference_line=None,
        display=None, region=None, tool_name="Screenshot",
    )
    def state():
        return DesktopState(
            active_desktop={}, all_desktops=[], active_window=None, windows=[],
            screenshot=Image.new("RGB", (2560, 1600)), tree_state=TreeState(),
        )
    desktop.get_state.side_effect = [state(), state()]
    first = capture_desktop_state(desktop, **args)
    preview_path = Path(first["preview_ref"]["path"])
    first_modified = preview_path.stat().st_mtime_ns
    second = capture_desktop_state(desktop, **args)
    assert second["preview_ref"] == first["preview_ref"]
    assert preview_path.stat().st_mtime_ns == first_modified


def test_repeated_capture_handles_windows_readonly_create_denial(monkeypatch, tmp_path):
    monkeypatch.setenv("WINDOWS_MCP_SCREENSHOT_NATIVE", "1")
    monkeypatch.setenv("WINDOWS_MCP_PREVIEW_CACHE", str(tmp_path))
    desktop = MagicMock()
    def state():
        return DesktopState(
            active_desktop={}, all_desktops=[], active_window=None, windows=[],
            screenshot=Image.new("RGB", (64, 64)), tree_state=TreeState(),
        )
    desktop.get_state.side_effect = [state(), state()]
    args = dict(use_vision=True, use_dom=False, use_annotation=False, use_ui_tree=False,
                width_reference_line=None, height_reference_line=None,
                display=None, region=None, tool_name="Screenshot")
    first = capture_desktop_state(desktop, **args)
    cached = Path(first["preview_ref"]["path"])
    original_open = Path.open
    def windows_open(path, mode="r", *positional, **kwargs):
        if path == cached and mode == "xb":
            raise PermissionError(13, "Permission denied", str(path))
        return original_open(path, mode, *positional, **kwargs)
    monkeypatch.setattr(Path, "open", windows_open)
    second = capture_desktop_state(desktop, **args)
    assert second["preview_ref"] == first["preview_ref"]


def test_preview_cache_permission_failure_keeps_inline_screenshot(monkeypatch, tmp_path):
    import windows_mcp.tools._snapshot_helpers as helpers
    monkeypatch.setenv("WINDOWS_MCP_SCREENSHOT_NATIVE", "1")
    monkeypatch.setenv("WINDOWS_MCP_PREVIEW_CACHE", str(tmp_path))
    def denied(*args):
        raise PermissionError(13, "Permission denied")
    monkeypatch.setattr(helpers, "_cache_original_preview", denied)
    desktop = MagicMock()
    desktop.get_state.return_value = DesktopState(
        active_desktop={}, all_desktops=[], active_window=None, windows=[],
        screenshot=Image.new("RGB", (64, 64)), tree_state=TreeState(),
    )
    result = capture_desktop_state(
        desktop, use_vision=True, use_dom=False, use_annotation=False, use_ui_tree=False,
        width_reference_line=None, height_reference_line=None,
        display=None, region=None, tool_name="Screenshot",
    )
    assert result["screenshot_bytes"]
    assert result["preview_ref"] is None
    assert "still attached" in result["preview_warning"]


def test_preview_cache_corruption_is_not_reused(tmp_path):
    from windows_mcp.tools._snapshot_helpers import _cache_original_preview
    cached = _cache_original_preview(str(tmp_path), b"original")
    Path(cached["path"]).write_bytes(b"corrupted")
    with pytest.raises(ValueError, match="checksum mismatch"):
        _cache_original_preview(str(tmp_path), b"original")
