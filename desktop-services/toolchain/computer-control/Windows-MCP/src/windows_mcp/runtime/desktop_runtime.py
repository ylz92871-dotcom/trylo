"""Actor-owned boundary around the legacy Desktop implementation."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


class DesktopRuntime:
    """Keep the legacy Desktop and all UIA objects private to one actor.

    Public methods are delegated only while executing on the actor thread.
    Mutable implementation objects cannot be read as attributes through the
    compatibility proxy; commands may return observation/result DTOs.
    """

    _FORBIDDEN_ATTRIBUTES = frozenset(
        {"desktop_state", "encoding", "ocr_backend", "snapshot_store", "tree"}
    )

    def __init__(self, desktop_factory: Callable[[], Any]) -> None:
        self._desktop: Any | None = desktop_factory()

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_") or name in self._FORBIDDEN_ATTRIBUTES:
            raise AttributeError(f"{name!r} is private actor-owned state")
        desktop = self._desktop
        if desktop is None:
            raise RuntimeError("desktop runtime is closed")
        return getattr(desktop, name)

    def safe_release_input(self) -> None:
        desktop = self._desktop
        if desktop is None:
            return
        release = getattr(desktop, "safe_release_input", None)
        if callable(release):
            release()

    def close(self) -> None:
        desktop = self._desktop
        self._desktop = None
        if desktop is not None:
            close = getattr(desktop, "close", None)
            if callable(close):
                close()
        # Import lazily on the owner thread.  This drops the global COM
        # singleton before the actor apartment is uninitialized.
        from windows_mcp import uia

        uia.DisposeAutomationClientInCurrentThread()
