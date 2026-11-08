"""Ocr tool — region text reading via Windows.Media.Ocr.

The accessibility tree does not always expose on-screen text the agent
needs to close the loop (CAD command-line echoes, canvas labels, some
status bars). This tool captures a region with the same screenshot
backend as Snapshot and runs the Windows OCR engine over it — no extra
runtime dependency (the engine ships with Windows; language packs
determine which scripts are recognized).
"""

from collections.abc import Callable
from typing import Any

from mcp.types import ToolAnnotations
from windows_mcp.infrastructure import with_analytics
from windows_mcp.desktop.ocr_backend import normalize_ocr_language
from fastmcp import Context


def _as_region(value: list[int] | str | None) -> list[int] | None:
    if value is None or isinstance(value, list):
        return value
    import json

    return json.loads(value)


def register(
    mcp: Any,
    *,
    get_desktop: Callable[[], Any],
    get_analytics: Callable[[], Any],
) -> None:
    @mcp.tool(
        name="Ocr",
        description=(
            "Reads text from a screen rectangle with the Windows OCR engine. "
            "region=[left, top, right, bottom] in virtual-desktop pixel coordinates "
            "(same coordinate space Snapshot reports); omit region to OCR the whole "
            "virtual screen. Use after Snapshot/Type to verify text the accessibility "
            "tree does not expose — CAD command-line echoes, canvas labels, status "
            "bars, rendered terminals. scale_up (1-4, default 2) enlarges the capture "
            "before recognition — small fonts (file dialogs, CAD prompts, minesweeper "
            "numbers) OCR badly at native size, so 2x is the default; raise to 4x only "
            "when a tiny region still comes back garbled. "
            "language (e.g. 'en-US', 'zh-CN') overrides the OCR language; default is the user's "
            "profile languages with an en-US fallback. Returns the recognized text plus "
            "the language used; engine_available=False means no OCR language pack is "
            "installed."
        ),
        annotations=ToolAnnotations(
            title="Ocr",
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "Ocr-Tool")
    def ocr_tool(
        region: list[int] | str | None = None,
        scale_up: float | int | str = 2.0,
        language: str | None = None,
        ctx: Context = None,
    ) -> dict[str, object]:
        # Validate before acquiring the desktop service.  This keeps malformed
        # language input on the pure-validation path: no capture backend, COM
        # object, or PowerShell command is touched.
        normalized_language = normalize_ocr_language(language)
        desktop = get_desktop()
        try:
            scale = float(scale_up)
        except (TypeError, ValueError) as exc:
            raise ValueError("scale_up must be a number between 1 and 4") from exc
        # Fail fast on invalid language tags before any capture or script
        # assembly happens (WCC-P0-01: the allowlisted Ocr tool must never
        # become a PowerShell injection path).
        return desktop.ocr_region(
            region=_as_region(region),
            scale_up=scale,
            language=normalized_language,
        )
