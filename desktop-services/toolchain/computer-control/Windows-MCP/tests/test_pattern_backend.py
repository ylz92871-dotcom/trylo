from dataclasses import replace
from unittest.mock import MagicMock

import windows_mcp.uia as uia
from windows_mcp.runtime.backends.base import (
    BackendOutcome,
    DispatchRequest,
    SemanticAction,
)
from windows_mcp.runtime.backends.uia_patterns import UiaPatternBackend
from windows_mcp.runtime.identity import (
    ElementRef,
    ProcessInstanceRef,
    ReacquireLocator,
    WindowRef,
)
from windows_mcp.runtime.results import TargetReceipt
from windows_mcp.runtime.target_resolver import ResolvedTarget


def _target() -> ResolvedTarget:
    process = ProcessInstanceRef(pid=22, started_at_100ns=33)
    window = WindowRef(
        desktop_session_id="desktop",
        producer_generation=1,
        hwnd=11,
        owner=process,
        window_generation=1,
    )
    element = ElementRef(
        element_id="element-1",
        snapshot_id="snapshot-1",
        window=window,
        runtime_id=(1, 2),
        locator=ReacquireLocator(control_type="Button"),
    )
    return ResolvedTarget(
        receipt=TargetReceipt(target_kind="element", description="target"),
        screen_point=(10, 20),
        source="test",
        element_ref=element,
    )


def test_pattern_backend_reports_unsupported_before_any_provider_call() -> None:
    control = MagicMock()
    control.GetPattern.return_value = None
    backend = UiaPatternBackend(lambda target: control)

    result = backend.dispatch(
        DispatchRequest(action=SemanticAction.INVOKE), _target()
    )

    assert result.outcome is BackendOutcome.UNSUPPORTED
    control.GetPattern.assert_called_once_with(uia.PatternId.InvokePattern)


def test_pattern_backend_reports_accepted_invoke() -> None:
    pattern = MagicMock()
    pattern.Invoke.return_value = True
    control = MagicMock()
    control.GetPattern.return_value = pattern
    backend = UiaPatternBackend(lambda target: control)

    result = backend.dispatch(
        DispatchRequest(action=SemanticAction.INVOKE), _target()
    )

    assert result.outcome is BackendOutcome.ACCEPTED
    assert result.channel == "uia.invoke"
    pattern.Invoke.assert_called_once_with(waitTime=0)


def test_pattern_exception_is_possible_and_not_unsupported() -> None:
    pattern = MagicMock()
    pattern.Invoke.side_effect = TimeoutError("provider stalled")
    control = MagicMock()
    control.GetPattern.return_value = pattern
    backend = UiaPatternBackend(lambda target: control)

    result = backend.dispatch(
        DispatchRequest(action=SemanticAction.INVOKE), _target()
    )

    assert result.outcome is BackendOutcome.POSSIBLE
    assert "TimeoutError" in result.detail


def test_scroll_pattern_maps_direction_and_repeats_requested_amount() -> None:
    pattern = MagicMock()
    pattern.Scroll.return_value = True
    control = MagicMock()
    control.GetPattern.return_value = pattern
    backend = UiaPatternBackend(lambda target: control)

    result = backend.dispatch(
        DispatchRequest(
            action=SemanticAction.SCROLL,
            scroll_type="vertical",
            direction="up",
            wheel_times=2,
        ),
        _target(),
    )

    assert result.outcome is BackendOutcome.ACCEPTED
    assert pattern.Scroll.call_count == 2
    pattern.Scroll.assert_called_with(
        uia.ScrollAmount.NoAmount,
        uia.ScrollAmount.SmallDecrement,
        waitTime=0,
    )


def test_semantic_state_reader_omits_protected_value() -> None:
    value_pattern = MagicMock()
    value_pattern.Value = "must-not-be-read"
    control = MagicMock()
    control.GetPattern.side_effect = lambda pattern_id: (
        value_pattern if pattern_id == uia.PatternId.ValuePattern else None
    )
    backend = UiaPatternBackend(lambda target: control)

    state = backend.read_state(replace(_target(), protected=True))

    assert "value" not in state
    assert uia.PatternId.ValuePattern not in [
        call.args[0] for call in control.GetPattern.call_args_list
    ]
