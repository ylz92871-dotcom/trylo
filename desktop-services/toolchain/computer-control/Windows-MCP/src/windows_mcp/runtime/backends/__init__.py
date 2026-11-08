"""Action execution backends."""

from windows_mcp.runtime.backends.base import (
    BackendDispatchResult,
    BackendOutcome,
    DispatchRequest,
    SemanticAction,
)
from windows_mcp.runtime.backends.raw_input import RawInputBackend
from windows_mcp.runtime.backends.uia_patterns import UiaPatternBackend

__all__ = [
    "BackendDispatchResult",
    "BackendOutcome",
    "DispatchRequest",
    "RawInputBackend",
    "SemanticAction",
    "UiaPatternBackend",
]

