"""WCC-P0-01: OCR injection surface and sensitive Type output.

The Ocr tool is allowlisted and its ``language`` parameter used to be
interpolated straight into a PowerShell template — any model-authored string
could inject script syntax. These tests pin the fail-closed behavior:

- ``normalize_ocr_language`` accepts only bounded BCP-47-style tags.
- The assembled script never contains raw caller input (validated or not).
- The backend seam (``OcrBackend.recognize``) is what ``Desktop.ocr_region``
  calls, and a native-helper backend can replace it without touching the
  tool layer.
"""

import pytest
from unittest.mock import MagicMock

from windows_mcp.desktop.ocr_backend import (
    OcrBackend,
    WindowsOcrPowerShellBackend,
    normalize_ocr_language,
)
from windows_mcp.desktop.service import Desktop
from windows_mcp.tools.ocr import register as register_ocr


class FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, *, name, **kwargs):
        def decorator(func):
            self.tools[name] = func
            return func

        return decorator


def run(tool, **kwargs):
    import asyncio

    return asyncio.run(tool(**kwargs))


# ---- normalize_ocr_language: legal tags ---------------------------------------


@pytest.mark.parametrize("tag", ["en-US", "zh-Hans-CN", "pt-BR", "en", "zh-Hans", "de-DE"])
def test_normalize_ocr_language_accepts_valid_tags(tag):
    assert normalize_ocr_language(tag) == tag


@pytest.mark.parametrize("tag", ["  en-US  ", "\ten-US\n"])
def test_normalize_ocr_language_strips_surrounding_whitespace(tag):
    assert normalize_ocr_language(tag) == "en-US"


@pytest.mark.parametrize("value", [None, "", "   "])
def test_normalize_ocr_language_none_for_absent_override(value):
    assert normalize_ocr_language(value) is None


# ---- normalize_ocr_language: injection attempts --------------------------------


@pytest.mark.parametrize(
    "tag",
    [
        "en'; calc",  # single quote breakout
        'en-US"; whoami',  # double quote
        "en; Remove-Item",  # statement separator
        "en\nUS",  # newline
        "en\rUS",  # carriage return
        "en`u",  # backtick escape
        "en$(calc)US",  # subexpression
        "en(1)US",  # parentheses
        "en$US",  # dollar
        "e",  # too short a subtag
        "toolonglanguagepref-",  # oversized subtag / trailing dash
        "en US",  # space inside
        "en-US;exit",  # trailing statement
        " languages-with-64+chars" + "x" * 64,  # overlong
        42,  # non-string
        ["en-US"],  # non-string
        {"en-US": True},  # non-string
    ],
)
def test_normalize_ocr_language_rejects_injection_attempts(tag):
    with pytest.raises(ValueError):
        normalize_ocr_language(tag)


# ---- backend: script assembly can never contain raw caller input ---------------


class _CapturingExecutor:
    captured_script = ""
    captured_shell = None

    @staticmethod
    def execute_command(command, timeout=10, shell=None):
        _CapturingExecutor.captured_script = command
        _CapturingExecutor.captured_shell = shell
        return "__OCR_TEXT__\nrecognized text", 0


@pytest.fixture()
def capture_executor(monkeypatch):
    monkeypatch.setattr(
        "windows_mcp.desktop.ocr_backend.PowerShellExecutor", _CapturingExecutor
    )
    return _CapturingExecutor


@pytest.mark.parametrize(
    "malicious",
    [
        "en'; Write-Output PWNED",
        "en\nWrite-Output PWNED",
        "en$(Write-Output PWNED)",
        "en`nWrite-Output PWNED",
        "en; exit",
    ],
)
def test_backend_rejects_malicious_language_before_script_assembly(malicious):
    from PIL import Image

    backend = WindowsOcrPowerShellBackend()
    with pytest.raises(ValueError):
        backend.recognize(Image.new("RGB", (4, 4)), malicious)


def test_tool_rejects_language_before_acquiring_desktop():
    mcp = FakeMCP()
    get_desktop = MagicMock()
    register_ocr(mcp, get_desktop=get_desktop, get_analytics=lambda: None)

    with pytest.raises(ValueError):
        run(mcp.tools["Ocr"], language="en-US; whoami")

    get_desktop.assert_not_called()


def test_backend_script_contains_no_quoting_from_language(capture_executor):
    """Even a *valid* tag must appear verbatim inside the template's own
    quotes — a tag that carried its own quoting would change the quote count
    (template has exactly 3 embedded occurrences of the tag literal: the
    emptiness check and the two TryCreateFromLanguage calls)."""
    from PIL import Image

    backend = WindowsOcrPowerShellBackend()
    result = backend.recognize(Image.new("RGB", (4, 4)), "en-US")
    script = capture_executor.captured_script
    assert "'en-US'" in script
    assert result["text"] == "recognized text"
    assert result["engine_available"] is True
    assert capture_executor.captured_shell == "powershell"
    assert script.count("'en-US'") == 3


def test_backend_none_language_uses_profile_default(capture_executor):
    from PIL import Image

    backend = WindowsOcrPowerShellBackend()
    backend.recognize(Image.new("RGB", (4, 4)), None)
    assert "if ('' -ne '')" in capture_executor.captured_script


def test_backend_cleans_up_temp_image(capture_executor, monkeypatch):
    import os
    from PIL import Image

    created = []
    real_named = __import__("tempfile").NamedTemporaryFile

    def tracking_named(*args, **kwargs):
        handle = real_named(*args, **kwargs)
        created.append(handle.name)
        return handle

    monkeypatch.setattr(
        "windows_mcp.desktop.ocr_backend.tempfile.NamedTemporaryFile", tracking_named
    )

    backend = WindowsOcrPowerShellBackend()
    backend.recognize(Image.new("RGB", (4, 4)), "en-US")

    assert len(created) == 1
    assert not os.path.exists(created[0])


def test_backend_reports_engine_unavailable(monkeypatch):
    from PIL import Image

    def unavailable(command, timeout=10, shell=None):
        return "__OCR_UNAVAILABLE__\n", 0

    monkeypatch.setattr(
        "windows_mcp.desktop.ocr_backend.PowerShellExecutor",
        type("E", (), {"execute_command": staticmethod(unavailable)}),
    )

    backend = WindowsOcrPowerShellBackend()
    result = backend.recognize(Image.new("RGB", (4, 4)), None)
    assert result == {"text": "", "engine_available": False, "language": None}


def test_backend_raises_on_nonzero_exit(capture_executor, monkeypatch):
    from PIL import Image

    def failing(command, timeout=10, shell=None):
        return "boom", 1

    monkeypatch.setattr(
        "windows_mcp.desktop.ocr_backend.PowerShellExecutor",
        type("E", (), {"execute_command": staticmethod(failing)}),
    )

    backend = WindowsOcrPowerShellBackend()
    with pytest.raises(RuntimeError, match="OCR command failed"):
        backend.recognize(Image.new("RGB", (4, 4)), None)


# ---- Desktop.ocr_region delegates to the backend seam --------------------------


class RecordingBackend(OcrBackend):
    def __init__(self, result=None):
        self.result = result or {
            "text": "canvas text",
            "engine_available": True,
            "language": "en-US",
        }
        self.calls = []

    def recognize(self, image, language):
        self.calls.append((image.size, language))
        return self.result


@pytest.fixture()
def tiny_image(monkeypatch):
    from PIL import Image

    image = Image.new("RGB", (40, 20), color="white")
    monkeypatch.setattr(
        Desktop, "get_screenshot", lambda self, capture_rect=None: image.copy()
    )
    return image


def test_ocr_region_routes_through_backend(tiny_image):
    backend = RecordingBackend()
    Desktop.set_ocr_backend(backend)
    try:
        result = Desktop.ocr_region(Desktop.__new__(Desktop), region=[0, 0, 10, 10])
    finally:
        Desktop.set_ocr_backend(None)

    assert result["text"] == "canvas text"
    assert result["region"] == [0, 0, 10, 10]
    assert result["image_size"] == [80, 40]  # default 2x upscale applied
    assert backend.calls[0][1] is None


def test_ocr_region_passes_validated_language(tiny_image):
    backend = RecordingBackend()
    Desktop.set_ocr_backend(backend)
    try:
        Desktop.ocr_region(Desktop.__new__(Desktop), language="zh-Hans-CN")
    finally:
        Desktop.set_ocr_backend(None)

    assert backend.calls[0][1] == "zh-Hans-CN"


def test_ocr_region_still_validates_scale_up():
    with pytest.raises(ValueError, match="scale_up"):
        Desktop.ocr_region(Desktop.__new__(Desktop), scale_up=9)


def test_default_backend_is_power_shell_backend(tiny_image):
    Desktop.set_ocr_backend(None)
    try:
        assert isinstance(Desktop._get_ocr_backend(), WindowsOcrPowerShellBackend)
    finally:
        Desktop.set_ocr_backend(None)


# ---- tool surface: Ocr fails fast on bad language ------------------------------


def test_ocr_tool_rejects_injection_language_before_desktop_access():
    mcp = FakeMCP()
    desktop = MagicMock()
    register_ocr(mcp, get_desktop=lambda: desktop, get_analytics=lambda: None)

    with pytest.raises(ValueError):
        run(mcp.tools["Ocr"], region=[0, 0, 10, 10], language="en'; Write-Output PWNED")

    desktop.ocr_region.assert_not_called()


def test_ocr_tool_passes_language_through_when_valid():
    mcp = FakeMCP()
    desktop = MagicMock()
    desktop.ocr_region.return_value = {"text": "x"}
    register_ocr(mcp, get_desktop=lambda: desktop, get_analytics=lambda: None)

    run(mcp.tools["Ocr"], region=[0, 0, 10, 10], language="en-US")

    desktop.ocr_region.assert_called_once_with(
        region=[0, 0, 10, 10], scale_up=2.0, language="en-US"
    )


# ---- I-07: OCR results must carry the protected-content limitation ------------


def test_ocr_region_result_carries_protected_content_warning(tiny_image):
    backend = RecordingBackend()
    Desktop.set_ocr_backend(backend)
    try:
        result = Desktop.ocr_region(Desktop.__new__(Desktop), region=[0, 0, 10, 10])
    finally:
        Desktop.set_ocr_backend(None)

    warnings = result.get("warnings")
    assert isinstance(warnings, list) and len(warnings) == 1
    assert "protected" in warnings[0]
    assert "IsPassword" in warnings[0]
