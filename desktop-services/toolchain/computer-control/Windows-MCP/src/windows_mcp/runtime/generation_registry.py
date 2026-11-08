"""Live PID/HWND generation validation for snapshot-bound identities."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from windows_mcp.runtime.errors import ErrorCode
from windows_mcp.runtime.identity import ProcessInstanceRef, WindowRef


class GenerationValidationError(RuntimeError):
    def __init__(self, code: ErrorCode, message: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass(slots=True)
class _WindowGeneration:
    owner: ProcessInstanceRef
    generation: int


def _live_process_start(pid: int) -> int:
    from psutil import Process

    return int(Process(pid).create_time() * 10_000_000)


def _live_window_owner(hwnd: int) -> int:
    import win32process

    return int(win32process.GetWindowThreadProcessId(hwnd)[1])


def _live_window_exists(hwnd: int) -> bool:
    import win32gui

    return bool(win32gui.IsWindow(hwnd))


class GenerationRegistry:
    """Assign generations and reject reused process/window identities."""

    def __init__(
        self,
        *,
        producer_generation: int,
        process_start: Callable[[int], int] = _live_process_start,
        window_owner: Callable[[int], int] = _live_window_owner,
        window_exists: Callable[[int], bool] = _live_window_exists,
    ) -> None:
        if producer_generation < 0:
            raise ValueError("producer_generation must be non-negative")
        self.producer_generation = producer_generation
        self._process_start = process_start
        self._window_owner = window_owner
        self._window_exists = window_exists
        self._windows: dict[int, _WindowGeneration] = {}

    def observe_window(self, hwnd: int, owner: ProcessInstanceRef) -> int:
        if hwnd <= 0:
            raise ValueError("window handle must be positive")
        previous = self._windows.get(hwnd)
        if previous is None:
            generation = 1
        elif previous.owner != owner:
            generation = previous.generation + 1
        else:
            generation = previous.generation
        self._windows[hwnd] = _WindowGeneration(owner, generation)
        return generation

    def validate_window(self, ref: WindowRef) -> None:
        if ref.producer_generation != self.producer_generation:
            raise GenerationValidationError(
                ErrorCode.STALE_WINDOW,
                "window belongs to an obsolete producer generation",
            )
        if not self._window_exists(ref.hwnd):
            raise GenerationValidationError(
                ErrorCode.STALE_WINDOW,
                f"window handle {ref.hwnd} no longer exists",
            )
        live_owner = self._window_owner(ref.hwnd)
        if live_owner != ref.owner.pid:
            raise GenerationValidationError(
                ErrorCode.STALE_WINDOW,
                f"window handle {ref.hwnd} is now owned by process {live_owner}",
            )
        if ref.owner.started_at_100ns:
            try:
                live_started = self._process_start(ref.owner.pid)
            except Exception as exc:
                raise GenerationValidationError(
                    ErrorCode.STALE_PROCESS,
                    f"process {ref.owner.pid} is unavailable",
                ) from exc
            if live_started != ref.owner.started_at_100ns:
                raise GenerationValidationError(
                    ErrorCode.STALE_PROCESS,
                    f"process id {ref.owner.pid} was reused",
                )
        observed = self._windows.get(ref.hwnd)
        if observed is None:
            current_generation = self.observe_window(ref.hwnd, ref.owner)
        else:
            current_generation = observed.generation
        if current_generation != ref.window_generation:
            raise GenerationValidationError(
                ErrorCode.STALE_WINDOW,
                "window generation changed after the observation",
            )
