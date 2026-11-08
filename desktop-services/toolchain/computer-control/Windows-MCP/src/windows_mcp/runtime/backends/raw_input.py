"""Explicit raw-input fallback adapter used by ActionRouter."""

from __future__ import annotations

from collections.abc import Callable

from windows_mcp.runtime.backends.base import (
    BackendDispatchResult,
    BackendOutcome,
    SemanticAction,
)


class RawInputBackend:
    """Runs a caller-provided, already focus-verified mutation callback."""

    def dispatch(
        self,
        action: SemanticAction,
        callback: Callable[[], None],
        *,
        channel: str = "send_input",
    ) -> BackendDispatchResult:
        callback()
        return BackendDispatchResult(
            outcome=BackendOutcome.ACCEPTED,
            channel=channel,
            action=action,
        )

