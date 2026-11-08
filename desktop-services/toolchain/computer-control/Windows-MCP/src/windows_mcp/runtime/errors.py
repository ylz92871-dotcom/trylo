"""Stable error taxonomy for computer-control protocol responses."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Mapping


class ErrorCode(StrEnum):
    STALE_SNAPSHOT = "stale_snapshot"
    STALE_PROCESS = "stale_process"
    STALE_WINDOW = "stale_window"
    STALE_ELEMENT = "stale_element"
    TARGET_NOT_FOUND = "target_not_found"
    AMBIGUOUS_TARGET = "ambiguous_target"
    TARGET_MOVED = "target_moved"
    TARGET_NOT_FOREGROUND = "target_not_foreground"
    NO_INTERACTIVE_DESKTOP = "no_interactive_desktop"
    SECURE_DESKTOP = "secure_desktop"
    INTEGRITY_BOUNDARY = "integrity_boundary"
    PATTERN_UNSUPPORTED = "pattern_unsupported"
    PROVIDER_UNRESPONSIVE = "provider_unresponsive"
    DISPATCH_FAILED = "dispatch_failed"
    DISPATCH_UNKNOWN = "dispatch_unknown"
    VERIFICATION_UNSATISFIED = "verification_unsatisfied"
    VERIFICATION_UNKNOWN = "verification_unknown"
    CAPTURE_UNAVAILABLE = "capture_unavailable"
    CAPTURE_DEGRADED = "capture_degraded"
    PROTECTED_CONTENT = "protected_content"
    EVENT_STREAM_RESYNC_REQUIRED = "event_stream_resync_required"
    DEADLINE_EXCEEDED = "deadline_exceeded"
    CANCELLED_BY_USER_INPUT = "cancelled_by_user_input"


@dataclass(frozen=True, slots=True)
class StructuredError:
    code: ErrorCode
    message: str
    retryable: bool = False
    details: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.message.strip():
            raise ValueError("StructuredError.message must not be empty")


class ComputerControlError(RuntimeError):
    """Exception form used at MCP boundaries so failures set ``isError``."""

    def __init__(self, error: StructuredError) -> None:
        self.error = error
        super().__init__(f"[{error.code.value}] {error.message}")
