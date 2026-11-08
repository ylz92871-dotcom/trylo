"""OCR recognition backend seam and language validation (WCC-P0-01).

`normalize_ocr_language` is the single gate every OCR language override must
pass before it can reach a script template: only bounded BCP-47-style tags
survive, so no caller-controlled string is ever interpolated into PowerShell.
`OcrBackend.recognize(image, language)` is the seam a native helper backend
will implement later; the PowerShell implementation below is a temporary
carrier and must keep failing closed on any non-validating input.
"""

import os
import re
import tempfile

from PIL import Image

from windows_mcp.powershell import PowerShellExecutor

# BCP-47-style structural tag. Windows OCR consumes language tags like
# en-US or zh-Hans-CN; bounding every subtag (and the whole tag at 64
# chars) means no shell metacharacter can survive validation.
_LANGUAGE_TAG_RE = re.compile(r"^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$")
_MAX_LANGUAGE_LENGTH = 64

# Characters that must never reach the PowerShell template. The tag regex
# already excludes all of them; recognize() re-checks as defense in depth.
_TEMPLATE_FORBIDDEN_CHARS = "'\";`\n\r$()"

__all__ = [
    "OcrBackend",
    "WindowsOcrPowerShellBackend",
    "normalize_ocr_language",
]


def normalize_ocr_language(value: object) -> str | None:
    """Validate an OCR language override.

    Returns the canonical tag, or None when the caller omitted / emptied the
    override (meaning: use the user's profile languages). Raises ValueError
    for anything that is not a string or not a bounded BCP-47-style tag — a
    value is never interpolated into a script unless it passes this gate.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("language must be a BCP-47 tag string such as 'en-US'")
    tag = value.strip()
    if not tag:
        return None
    if len(tag) > _MAX_LANGUAGE_LENGTH:
        raise ValueError(
            f"language tag must be at most {_MAX_LANGUAGE_LENGTH} characters"
        )
    if not _LANGUAGE_TAG_RE.fullmatch(tag):
        raise ValueError(
            "language must be a BCP-47 tag such as 'en-US' or 'zh-Hans-CN'"
        )
    if any(ch in tag for ch in _TEMPLATE_FORBIDDEN_CHARS):
        raise ValueError("language contains forbidden characters")
    return tag


class OcrBackend:
    """Recognition seam.

    Implementations receive an already-captured (and optionally upscaled)
    PIL image plus a *validated* language tag (or None for the profile
    default) and return ``{"text", "engine_available", "language"}``.
    Raw caller input must never reach an implementation unvalidated.
    """

    def recognize(self, image: Image.Image, language: str | None) -> dict[str, object]:
        raise NotImplementedError


class WindowsOcrPowerShellBackend(OcrBackend):
    """Windows.Media.Ocr via Windows PowerShell 5.1 (the WinRT projection does
    not work in pwsh 7). Temporary implementation: the script is assembled
    only from a system temp path and a regex-validated language tag — caller
    strings can never change the script's syntax."""

    _TEMPLATE = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($WinRtTask, $ResultType) {
    $netTask = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
    $null = $netTask.Wait(10000)
    $netTask.Result
}
$engine = $null
if ('__OCR_LANG_VALUE__' -ne '') {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('__OCR_LANG_VALUE__'))
}
if ($null -eq $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if ($null -eq $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US'))
}
if ($null -eq $engine) {
    Write-Output '__OCR_UNAVAILABLE__'
    exit 0
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('__OCR_PATH__')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
Write-Output ('__OCR_LANG_TAG__=' + $engine.RecognizerLanguage.LanguageTag)
Write-Output '__OCR_TEXT__'
Write-Output $result.Text
"""

    def recognize(self, image: Image.Image, language: str | None) -> dict[str, object]:
        language = normalize_ocr_language(language)
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as handle:
                temp_path = handle.name
                image.save(handle, format="PNG")
            if any(ch in temp_path for ch in _TEMPLATE_FORBIDDEN_CHARS):
                raise ValueError("temporary OCR image path contains forbidden characters")
            script = self._TEMPLATE.replace("__OCR_PATH__", temp_path).replace(
                "__OCR_LANG_VALUE__", language or ""
            )
            # shell="powershell": WinRT projections need Windows PowerShell 5.1.
            output, status = PowerShellExecutor.execute_command(
                script, timeout=30, shell="powershell"
            )
        finally:
            if temp_path:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass

        if status != 0:
            raise RuntimeError(f"OCR command failed: {output.strip()[:400]}")
        return self._parse_output(output, requested_language=language)

    @staticmethod
    def _parse_output(output: str, requested_language: str | None) -> dict[str, object]:
        if "__OCR_UNAVAILABLE__" in output:
            return {"text": "", "engine_available": False, "language": None}
        text = ""
        recognizer_language = requested_language
        if "__OCR_TEXT__" in output:
            before, after = output.split("__OCR_TEXT__", 1)
            text = after.strip()
            for line in before.splitlines():
                line = line.strip()
                if line.startswith("__OCR_LANG_TAG__="):
                    recognizer_language = line.split("=", 1)[1].strip() or recognizer_language
        return {"text": text, "engine_available": True, "language": recognizer_language}
