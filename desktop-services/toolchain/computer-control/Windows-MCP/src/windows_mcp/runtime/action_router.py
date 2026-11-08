"""Pattern-first semantic action routing with conservative fallback rules."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from enum import StrEnum

from windows_mcp.runtime.backends.base import (
    BackendDispatchResult,
    BackendOutcome,
    DispatchRequest,
    PatternBackend,
    SemanticAction,
)
from windows_mcp.runtime.backends.raw_input import RawInputBackend
from windows_mcp.runtime.predicates import Predicate, changed, equals
from windows_mcp.runtime.target_resolver import ResolvedTarget


class FallbackPolicy(StrEnum):
    ALLOW_RAW = "allow_raw"
    PATTERN_ONLY = "pattern_only"
    RAW_ONLY = "raw_only"


class ActionRoutingError(RuntimeError):
    pass


class ActionRouter:
    def __init__(
        self,
        *,
        patterns: PatternBackend,
        raw_input: RawInputBackend | None = None,
    ) -> None:
        self._patterns = patterns
        self._raw = raw_input or RawInputBackend()

    @staticmethod
    def _click_candidates(target: ResolvedTarget) -> tuple[SemanticAction, ...]:
        capabilities = target.capabilities
        if capabilities is None:
            return ()
        role = (
            target.role.casefold().replace(" ", "").removesuffix("control")
            if target.role
            else ""
        )
        candidates: list[SemanticAction] = []
        if capabilities.toggle and role in {"checkbox", "switch", "radiobutton"}:
            candidates.append(SemanticAction.TOGGLE)
        if capabilities.expand_collapse and role in {
            "combobox",
            "tree",
            "treeitem",
        }:
            candidates.append(SemanticAction.EXPAND_COLLAPSE)
        if capabilities.select and role in {
            "dataitem",
            "listitem",
            "menuitem",
            "radiobutton",
            "tabitem",
            "treeitem",
        }:
            candidates.append(SemanticAction.SELECT)
        if capabilities.invoke:
            candidates.append(SemanticAction.INVOKE)
        if capabilities.expand_collapse:
            candidates.append(SemanticAction.EXPAND_COLLAPSE)
        return tuple(dict.fromkeys(candidates))

    def click_postcondition(
        self, target: ResolvedTarget | None, *, semantic_eligible: bool
    ) -> Predicate | None:
        if not semantic_eligible or target is None:
            return None
        candidates = self._click_candidates(target)
        if not candidates:
            return None
        return {
            SemanticAction.TOGGLE: changed("toggle_state"),
            SemanticAction.SELECT: equals("selected", True),
            SemanticAction.EXPAND_COLLAPSE: changed("expand_state"),
        }.get(candidates[0])

    @staticmethod
    def set_value_postcondition(
        target: ResolvedTarget | None,
        value: str,
        *,
        semantic_eligible: bool,
    ) -> Predicate | None:
        if (
            not semantic_eligible
            or target is None
            or target.protected
            or target.capabilities is None
            or not target.capabilities.set_value
        ):
            return None
        return equals("value", value)

    @staticmethod
    def scroll_postcondition(
        target: ResolvedTarget | None,
        *,
        scroll_type: str,
        semantic_eligible: bool,
    ) -> Predicate | None:
        if (
            not semantic_eligible
            or target is None
            or target.capabilities is None
            or not target.capabilities.scroll
        ):
            return None
        field = (
            "horizontal_scroll_percent"
            if scroll_type == "horizontal"
            else "vertical_scroll_percent"
        )
        return changed(field)

    def _route(
        self,
        target: ResolvedTarget | None,
        requests: Sequence[DispatchRequest],
        raw_action: SemanticAction,
        raw_dispatch: Callable[[], None],
        *,
        raw_channel: str,
        fallback_policy: FallbackPolicy,
    ) -> BackendDispatchResult:
        if fallback_policy is not FallbackPolicy.RAW_ONLY and target is not None:
            for request in requests:
                result = self._patterns.dispatch(request, target)
                if result.outcome is BackendOutcome.ACCEPTED:
                    return result
                if result.outcome is BackendOutcome.POSSIBLE:
                    # The provider might have acted. Never repeat through raw
                    # input after this boundary.
                    return result
        if fallback_policy is FallbackPolicy.PATTERN_ONLY:
            raise ActionRoutingError("no supported UIA pattern for pattern-only action")
        return self._raw.dispatch(
            raw_action,
            raw_dispatch,
            channel=raw_channel,
        )

    def click(
        self,
        target: ResolvedTarget | None,
        raw_dispatch: Callable[[], None],
        *,
        semantic_eligible: bool,
        fallback_policy: FallbackPolicy = FallbackPolicy.ALLOW_RAW,
    ) -> BackendDispatchResult:
        requests = (
            [DispatchRequest(action=action) for action in self._click_candidates(target)]
            if semantic_eligible and target is not None
            else []
        )
        return self._route(
            target,
            requests,
            SemanticAction.RAW_CLICK,
            raw_dispatch,
            raw_channel="send_input",
            fallback_policy=fallback_policy,
        )

    def set_value(
        self,
        target: ResolvedTarget | None,
        value: str,
        raw_dispatch: Callable[[], None],
        *,
        semantic_eligible: bool,
        fallback_policy: FallbackPolicy = FallbackPolicy.ALLOW_RAW,
    ) -> BackendDispatchResult:
        requests = []
        if (
            semantic_eligible
            and target is not None
            and target.capabilities is not None
            and target.capabilities.set_value
        ):
            requests.append(DispatchRequest(action=SemanticAction.SET_VALUE, value=value))
        return self._route(
            target,
            requests,
            SemanticAction.RAW_TYPE,
            raw_dispatch,
            raw_channel="send_keys_or_clipboard",
            fallback_policy=fallback_policy,
        )

    def scroll(
        self,
        target: ResolvedTarget | None,
        raw_dispatch: Callable[[], None],
        *,
        scroll_type: str,
        direction: str,
        wheel_times: int,
        semantic_eligible: bool,
        fallback_policy: FallbackPolicy = FallbackPolicy.ALLOW_RAW,
    ) -> BackendDispatchResult:
        requests = []
        if (
            semantic_eligible
            and target is not None
            and target.capabilities is not None
            and target.capabilities.scroll
        ):
            requests.append(
                DispatchRequest(
                    action=SemanticAction.SCROLL,
                    scroll_type=scroll_type,
                    direction=direction,
                    wheel_times=wheel_times,
                )
            )
        return self._route(
            target,
            requests,
            SemanticAction.RAW_SCROLL,
            raw_dispatch,
            raw_channel="send_input",
            fallback_policy=fallback_policy,
        )
