"""UI Automation Pattern backend.

The backend deliberately reports an invocation exception or false HRESULT as
``possible``. Once a provider method has been entered, it is unsafe to assume
that no action occurred and then repeat the same action through raw input.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import windows_mcp.uia as uia
from windows_mcp.runtime.backends.base import (
    BackendDispatchResult,
    BackendOutcome,
    DispatchRequest,
    SemanticAction,
)
from windows_mcp.runtime.errors import ErrorCode
from windows_mcp.runtime.target_resolver import ResolvedTarget, TargetResolutionError


_PATTERN_IDS = {
    SemanticAction.INVOKE: uia.PatternId.InvokePattern,
    SemanticAction.TOGGLE: uia.PatternId.TogglePattern,
    SemanticAction.SELECT: uia.PatternId.SelectionItemPattern,
    SemanticAction.EXPAND_COLLAPSE: uia.PatternId.ExpandCollapsePattern,
    SemanticAction.SET_VALUE: uia.PatternId.ValuePattern,
    SemanticAction.SCROLL: uia.PatternId.ScrollPattern,
}


class UiaPatternBackend:
    def __init__(
        self, control_resolver: Callable[[ResolvedTarget], Any]
    ) -> None:
        self._control_resolver = control_resolver

    def read_state(self, target: ResolvedTarget) -> dict[str, Any]:
        """Read a minimal semantic state without exposing protected values."""
        if target.element_ref is None:
            return {}
        try:
            control = self._control_resolver(target)
        except TargetResolutionError as exc:
            if exc.code in {ErrorCode.STALE_ELEMENT, ErrorCode.TARGET_NOT_FOUND}:
                return {"exists": False}
            raise
        state: dict[str, Any] = {"exists": True}
        probes = (
            (uia.PatternId.TogglePattern, "toggle_state", "ToggleState"),
            (uia.PatternId.SelectionItemPattern, "selected", "IsSelected"),
            (
                uia.PatternId.ExpandCollapsePattern,
                "expand_state",
                "ExpandCollapseState",
            ),
            (
                uia.PatternId.ScrollPattern,
                "horizontal_scroll_percent",
                "HorizontalScrollPercent",
            ),
            (
                uia.PatternId.ScrollPattern,
                "vertical_scroll_percent",
                "VerticalScrollPercent",
            ),
        )
        cached_patterns: dict[int, Any] = {}
        for pattern_id, field, attribute in probes:
            try:
                pattern = cached_patterns.get(pattern_id)
                if pattern_id not in cached_patterns:
                    pattern = control.GetPattern(pattern_id)
                    cached_patterns[pattern_id] = pattern
                if pattern is not None:
                    state[field] = getattr(pattern, attribute)
            except Exception:
                continue
        if not target.protected:
            try:
                value_pattern = control.GetPattern(uia.PatternId.ValuePattern)
                if value_pattern is not None:
                    state["value"] = value_pattern.Value
            except Exception:
                pass
        return state

    @staticmethod
    def _invoke_pattern(pattern: Any, request: DispatchRequest) -> bool:
        action = request.action
        if action is SemanticAction.INVOKE:
            return bool(pattern.Invoke(waitTime=0))
        if action is SemanticAction.TOGGLE:
            return bool(pattern.Toggle(waitTime=0))
        if action is SemanticAction.SELECT:
            return bool(pattern.Select(waitTime=0))
        if action is SemanticAction.EXPAND_COLLAPSE:
            state = pattern.ExpandCollapseState
            if state == uia.ExpandCollapseState.Expanded:
                return bool(pattern.Collapse(waitTime=0))
            if state in (
                uia.ExpandCollapseState.Collapsed,
                uia.ExpandCollapseState.PartiallyExpanded,
            ):
                return bool(pattern.Expand(waitTime=0))
            return False
        if action is SemanticAction.SET_VALUE:
            if request.value is None or pattern.IsReadOnly:
                return False
            return bool(pattern.SetValue(request.value, waitTime=0))
        if action is SemanticAction.SCROLL:
            horizontal = uia.ScrollAmount.NoAmount
            vertical = uia.ScrollAmount.NoAmount
            amount = (
                uia.ScrollAmount.SmallDecrement
                if request.direction in {"up", "left"}
                else uia.ScrollAmount.SmallIncrement
            )
            if request.scroll_type == "horizontal":
                horizontal = amount
            else:
                vertical = amount
            for _ in range(request.wheel_times):
                if not pattern.Scroll(horizontal, vertical, waitTime=0):
                    return False
            return True
        raise ValueError(f"unsupported semantic action: {action}")

    def dispatch(
        self, request: DispatchRequest, target: ResolvedTarget
    ) -> BackendDispatchResult:
        pattern_id = _PATTERN_IDS.get(request.action)
        if pattern_id is None or target.element_ref is None:
            return BackendDispatchResult(
                outcome=BackendOutcome.UNSUPPORTED,
                channel="uia_pattern",
                action=request.action,
                detail="semantic action requires a snapshot-bound UIA element",
            )
        # Reacquisition errors are target errors, not pattern unsupported; let
        # them fail closed instead of permitting a raw fallback.
        control = self._control_resolver(target)
        pattern = control.GetPattern(pattern_id)
        if pattern is None:
            return BackendDispatchResult(
                outcome=BackendOutcome.UNSUPPORTED,
                channel="uia_pattern",
                action=request.action,
                detail="live element does not expose the requested UIA pattern",
            )
        try:
            accepted = self._invoke_pattern(pattern, request)
        except Exception as exc:
            return BackendDispatchResult(
                outcome=BackendOutcome.POSSIBLE,
                channel=f"uia.{request.action.value}",
                action=request.action,
                detail=f"UIA pattern returned indeterminate: {type(exc).__name__}",
            )
        return BackendDispatchResult(
            outcome=(BackendOutcome.ACCEPTED if accepted else BackendOutcome.POSSIBLE),
            channel=f"uia.{request.action.value}",
            action=request.action,
            detail=("provider accepted the pattern call" if accepted else "pattern call outcome is indeterminate"),
        )
