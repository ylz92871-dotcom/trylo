"""Backend-neutral dispatch contracts for semantic desktop actions."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Mapping, Protocol

from windows_mcp.runtime.target_resolver import ResolvedTarget


class SemanticAction(StrEnum):
    INVOKE = "invoke"
    TOGGLE = "toggle"
    SELECT = "select"
    EXPAND_COLLAPSE = "expand_collapse"
    SET_VALUE = "set_value"
    SCROLL = "scroll"
    RAW_CLICK = "raw_click"
    RAW_TYPE = "raw_type"
    RAW_SCROLL = "raw_scroll"


class BackendOutcome(StrEnum):
    """Whether a backend definitely did not send, accepted, or may have sent."""

    UNSUPPORTED = "unsupported"
    ACCEPTED = "accepted"
    POSSIBLE = "possible"


@dataclass(frozen=True, slots=True)
class DispatchRequest:
    action: SemanticAction
    value: str | None = None
    scroll_type: str | None = None
    direction: str | None = None
    wheel_times: int = 1


@dataclass(frozen=True, slots=True)
class BackendDispatchResult:
    outcome: BackendOutcome
    channel: str
    action: SemanticAction
    detail: str = ""
    metadata: Mapping[str, Any] = field(default_factory=dict)


class PatternBackend(Protocol):
    def dispatch(
        self, request: DispatchRequest, target: ResolvedTarget
    ) -> BackendDispatchResult: ...

