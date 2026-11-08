import pytest

from windows_mcp.runtime.errors import ErrorCode
from windows_mcp.runtime.generation_registry import (
    GenerationRegistry,
    GenerationValidationError,
)
from windows_mcp.runtime.identity import ProcessInstanceRef, WindowRef


def _window() -> WindowRef:
    return WindowRef(
        desktop_session_id="desktop-a",
        producer_generation=2,
        hwnd=100,
        owner=ProcessInstanceRef(pid=10, started_at_100ns=500),
        window_generation=1,
    )


def test_reused_window_handle_is_rejected() -> None:
    registry = GenerationRegistry(
        producer_generation=2,
        process_start=lambda pid: 500,
        window_owner=lambda hwnd: 99,
        window_exists=lambda hwnd: True,
    )

    with pytest.raises(GenerationValidationError) as exc_info:
        registry.validate_window(_window())

    assert exc_info.value.code is ErrorCode.STALE_WINDOW


def test_reused_process_id_is_rejected() -> None:
    registry = GenerationRegistry(
        producer_generation=2,
        process_start=lambda pid: 999,
        window_owner=lambda hwnd: 10,
        window_exists=lambda hwnd: True,
    )

    with pytest.raises(GenerationValidationError) as exc_info:
        registry.validate_window(_window())

    assert exc_info.value.code is ErrorCode.STALE_PROCESS


def test_obsolete_producer_generation_is_rejected() -> None:
    registry = GenerationRegistry(
        producer_generation=3,
        process_start=lambda pid: 500,
        window_owner=lambda hwnd: 10,
        window_exists=lambda hwnd: True,
    )

    with pytest.raises(GenerationValidationError) as exc_info:
        registry.validate_window(_window())

    assert exc_info.value.code is ErrorCode.STALE_WINDOW
