from unittest.mock import MagicMock

from windows_mcp.desktop.service import Desktop
from windows_mcp.runtime.clock import FakeClock
from windows_mcp.runtime.action_router import ActionRouter
from windows_mcp.runtime.backends.base import (
    BackendDispatchResult,
    BackendOutcome,
    SemanticAction,
)
from windows_mcp.runtime.observations import ElementCapabilities
from windows_mcp.runtime.predicates import frame_changed
from windows_mcp.runtime.results import TargetReceipt, VerificationEvidence
from windows_mcp.runtime.target_resolver import ResolvedTarget


def _target(*, role: str = "Button", **capabilities: bool) -> ResolvedTarget:
    return ResolvedTarget(
        receipt=TargetReceipt(target_kind="element", description="target"),
        screen_point=(10, 20),
        source="test",
        role=role,
        capabilities=ElementCapabilities(**capabilities),
    )


def _result(
    outcome: BackendOutcome, action: SemanticAction
) -> BackendDispatchResult:
    return BackendDispatchResult(
        outcome=outcome,
        channel=f"uia.{action.value}",
        action=action,
    )


def test_click_uses_invoke_without_raw_input_when_pattern_accepts() -> None:
    patterns = MagicMock()
    patterns.dispatch.return_value = _result(
        BackendOutcome.ACCEPTED, SemanticAction.INVOKE
    )
    raw = MagicMock()
    router = ActionRouter(patterns=patterns)

    result = router.click(_target(invoke=True), raw, semantic_eligible=True)

    assert result.action is SemanticAction.INVOKE
    raw.assert_not_called()


def test_checkbox_prefers_toggle_over_invoke() -> None:
    patterns = MagicMock()
    patterns.dispatch.return_value = _result(
        BackendOutcome.ACCEPTED, SemanticAction.TOGGLE
    )
    router = ActionRouter(patterns=patterns)

    router.click(
        _target(role="CheckBox", toggle=True, invoke=True),
        MagicMock(),
        semantic_eligible=True,
    )

    request = patterns.dispatch.call_args.args[0]
    assert request.action is SemanticAction.TOGGLE


def test_tree_item_prefers_expand_collapse_over_selection() -> None:
    patterns = MagicMock()
    patterns.dispatch.return_value = _result(
        BackendOutcome.ACCEPTED, SemanticAction.EXPAND_COLLAPSE
    )
    router = ActionRouter(patterns=patterns)

    router.click(
        _target(role="TreeItemControl", select=True, expand_collapse=True),
        MagicMock(),
        semantic_eligible=True,
    )

    request = patterns.dispatch.call_args.args[0]
    assert request.action is SemanticAction.EXPAND_COLLAPSE


def test_unsupported_pattern_falls_back_to_raw_only_when_no_call_may_have_run() -> None:
    patterns = MagicMock()
    patterns.dispatch.return_value = _result(
        BackendOutcome.UNSUPPORTED, SemanticAction.INVOKE
    )
    raw = MagicMock()
    router = ActionRouter(patterns=patterns)

    result = router.click(_target(invoke=True), raw, semantic_eligible=True)

    assert result.action is SemanticAction.RAW_CLICK
    raw.assert_called_once_with()


def test_possible_pattern_dispatch_never_repeats_through_raw_input() -> None:
    patterns = MagicMock()
    patterns.dispatch.return_value = _result(
        BackendOutcome.POSSIBLE, SemanticAction.INVOKE
    )
    raw = MagicMock()
    router = ActionRouter(patterns=patterns)

    result = router.click(_target(invoke=True), raw, semantic_eligible=True)

    assert result.outcome is BackendOutcome.POSSIBLE
    raw.assert_not_called()


def test_set_value_uses_pattern_only_for_semantically_eligible_request() -> None:
    patterns = MagicMock()
    patterns.dispatch.return_value = _result(
        BackendOutcome.ACCEPTED, SemanticAction.SET_VALUE
    )
    raw = MagicMock()
    router = ActionRouter(patterns=patterns)

    result = router.set_value(
        _target(role="Edit", set_value=True),
        "secret",
        raw,
        semantic_eligible=True,
    )

    request = patterns.dispatch.call_args.args[0]
    assert request.action is SemanticAction.SET_VALUE
    assert request.value == "secret"
    assert result.channel == "uia.set_value"
    raw.assert_not_called()


def test_desktop_click_dispatch_does_not_focus_or_move_mouse_for_invoke() -> None:
    patterns = MagicMock()
    patterns.dispatch.return_value = _result(
        BackendOutcome.ACCEPTED, SemanticAction.INVOKE
    )
    target = _target(invoke=True)
    desktop = Desktop.__new__(Desktop)
    desktop._action_router = ActionRouter(patterns=patterns)
    desktop.resolve_action_point = MagicMock(return_value=target)
    desktop.focus_window = MagicMock()
    desktop._focus_resolved_target = MagicMock()
    desktop.click = MagicMock()
    desktop.click_hit_note = MagicMock()
    desktop._finish_target_mutation = MagicMock()

    result = desktop.dispatch_click_target(
        loc=None,
        label=0,
        element=None,
        snapshot_id="snapshot-1",
        element_id=None,
        coordinate_space="screen",
        window=None,
        button="left",
        clicks=1,
        modifiers=None,
        action="click",
        hold_seconds=None,
    )

    assert result["execution_channel"] == "uia.invoke"
    desktop.focus_window.assert_not_called()
    desktop._focus_resolved_target.assert_not_called()
    desktop.click.assert_not_called()


def test_desktop_click_possible_pattern_dispatch_never_calls_raw_actuator() -> None:
    patterns = MagicMock()
    patterns.dispatch.return_value = _result(
        BackendOutcome.POSSIBLE, SemanticAction.INVOKE
    )
    desktop = Desktop.__new__(Desktop)
    desktop._action_router = ActionRouter(patterns=patterns)
    desktop.resolve_action_point = MagicMock(return_value=_target(invoke=True))
    desktop.click = MagicMock()
    desktop._finish_target_mutation = MagicMock()

    result = desktop.dispatch_click_target(
        loc=None,
        label=0,
        element=None,
        snapshot_id="snapshot-1",
        element_id=None,
        coordinate_space="screen",
        window=None,
        button="left",
        clicks=1,
        modifiers=None,
        action="click",
        hold_seconds=None,
    )

    assert result["dispatch_status"].value == "possible"
    desktop.click.assert_not_called()


def test_router_derives_verifiable_postconditions_without_value_leakage() -> None:
    router = ActionRouter(patterns=MagicMock())

    toggle = router.click_postcondition(
        _target(role="CheckBox", toggle=True), semantic_eligible=True
    )
    value = router.set_value_postcondition(
        _target(role="Edit", set_value=True),
        "typed-value",
        semantic_eligible=True,
    )

    assert toggle is not None and toggle.description == "element.toggle_state_changed"
    assert value is not None and value.description == "element.value_equals"


def test_desktop_prepares_verifier_before_pattern_dispatch() -> None:
    order: list[str] = []
    evidence = VerificationEvidence(
        verifier="test",
        predicate="element.toggle_state_changed",
        observed="changed",
        revision=2,
    )

    class Verifier:
        def prepare(self, target, *, pre_revision, predicates=()):
            order.append("prepare")
            return MagicMock(pre_revision=pre_revision)

        def observe_after_dispatch(self, handle, predicate, **kwargs):
            order.append("verify")
            return MagicMock(evidence=evidence)

    patterns = MagicMock()

    def dispatch(request, target):
        order.append("dispatch")
        return _result(BackendOutcome.ACCEPTED, SemanticAction.TOGGLE)

    patterns.dispatch.side_effect = dispatch
    desktop = Desktop.__new__(Desktop)
    desktop._runtime_clock = FakeClock()
    desktop._observation_revision = 1
    desktop._verifier = Verifier()
    desktop._action_router = ActionRouter(patterns=patterns)
    desktop.resolve_action_point = MagicMock(
        return_value=_target(role="CheckBox", toggle=True)
    )
    desktop.click = MagicMock()
    desktop._finish_target_mutation = MagicMock()

    result = desktop.dispatch_click_target(
        loc=None,
        label=0,
        element=None,
        snapshot_id="snapshot-1",
        element_id=None,
        coordinate_space="screen",
        window=None,
        button="left",
        clicks=1,
        modifiers=None,
        action="click",
        hold_seconds=None,
    )

    assert order == ["prepare", "dispatch", "verify"]
    assert result["verification"] is evidence
    desktop.click.assert_not_called()


# ── §13.2 expected_postconditions (v1: parameterless predicate names) ────


def _evidence(predicate: str) -> VerificationEvidence:
    return VerificationEvidence(
        verifier="test", predicate=predicate, observed="changed", revision=2
    )


class ScriptedVerifier:
    """prepare/observe with per-call outcomes: evidence objects or None."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.prepared_predicates = None
        self.observed_predicates = []

    def prepare(self, target, *, pre_revision, predicates=()):
        self.prepared_predicates = tuple(predicates)
        return MagicMock(pre_revision=pre_revision)

    def observe_after_dispatch(self, handle, predicate, **kwargs):
        self.observed_predicates.append(predicate)
        outcome = self.outcomes.pop(0) if self.outcomes else None
        return MagicMock(evidence=outcome)


def _click_desktop(verifier) -> Desktop:
    desktop = Desktop.__new__(Desktop)
    desktop._runtime_clock = FakeClock()
    desktop._observation_revision = 1
    desktop._verifier = verifier
    patterns = MagicMock()
    patterns.dispatch.return_value = _result(BackendOutcome.ACCEPTED, SemanticAction.INVOKE)
    desktop._action_router = ActionRouter(patterns=patterns)
    desktop.resolve_action_point = MagicMock(
        return_value=_target(role="Button", invoke=True)
    )
    desktop.click = MagicMock()
    desktop._finish_target_mutation = MagicMock()
    return desktop


def test_click_with_unconfirmed_postcondition_degrades_to_unknown() -> None:
    verifier = ScriptedVerifier(outcomes=[_evidence("element.toggle_state_changed")])
    desktop = _click_desktop(verifier)
    desktop.resolve_action_point = MagicMock(
        return_value=_target(role="CheckBox", toggle=True)
    )

    result = desktop.dispatch_click_target(
        loc=None,
        label=0,
        element=None,
        snapshot_id="snapshot-1",
        element_id=None,
        coordinate_space="screen",
        window=None,
        button="left",
        clicks=1,
        modifiers=None,
        action="click",
        hold_seconds=None,
        expected_postconditions=(frame_changed(),),
    )

    # Router predicate satisfied, caller predicate not → NO evidence at all.
    assert result["verification"] is None
    assert result["postconditions_unconfirmed"] == ["frame.frame_digest_frame_changed"]
    desktop.click.assert_not_called()


def test_click_with_all_postconditions_confirmed_still_confirms() -> None:
    verifier = ScriptedVerifier(
        outcomes=[
            _evidence("element.toggle_state_changed"),
            _evidence("frame.frame_digest_frame_changed"),
        ]
    )
    desktop = _click_desktop(verifier)
    desktop.resolve_action_point = MagicMock(
        return_value=_target(role="CheckBox", toggle=True)
    )

    result = desktop.dispatch_click_target(
        loc=None,
        label=0,
        element=None,
        snapshot_id="snapshot-1",
        element_id=None,
        coordinate_space="screen",
        window=None,
        button="left",
        clicks=1,
        modifiers=None,
        action="click",
        hold_seconds=None,
        expected_postconditions=(frame_changed(),),
    )

    assert result["verification"] is not None
    assert result["postconditions_unconfirmed"] == []
    assert "frame.frame_digest_frame_changed" in result["verification"].predicate


def test_no_expected_postconditions_leaves_dispatch_shape_unchanged() -> None:
    verifier = ScriptedVerifier(outcomes=[_evidence("element.toggle_state_changed")])
    desktop = _click_desktop(verifier)
    desktop.resolve_action_point = MagicMock(
        return_value=_target(role="CheckBox", toggle=True)
    )

    result = desktop.dispatch_click_target(
        loc=None,
        label=0,
        element=None,
        snapshot_id="snapshot-1",
        element_id=None,
        coordinate_space="screen",
        window=None,
        button="left",
        clicks=1,
        modifiers=None,
        action="click",
        hold_seconds=None,
    )

    assert result["verification"] is not None
    assert result["postconditions_unconfirmed"] == []


def test_parse_expected_postconditions_vocabulary() -> None:
    from windows_mcp.tools.input import _parse_expected_postconditions

    assert _parse_expected_postconditions(None) is None
    assert _parse_expected_postconditions("") is None
    parsed = _parse_expected_postconditions(["frame_changed", "element_exists"])
    assert len(parsed) == 2
    assert parsed[0].description == "frame.frame_digest_frame_changed"
    assert parsed[1].description == "element.exists_exists"
    # Single string and JSON-stringified list forms (Claude Desktop style).
    assert len(_parse_expected_postconditions("frame_changed")) == 1
    assert len(_parse_expected_postconditions('["frame_changed"]')) == 1
    # Duplicates collapse.
    assert len(_parse_expected_postconditions(["frame_changed", "frame_changed"])) == 1
    # Unknown / parameterized names are refused with the v1 vocabulary named.
    for bad in (["value_equals"], ["text_exists:hello"], "frame_changed,text_exists"):
        try:
            _parse_expected_postconditions(bad)
        except ValueError as exc:
            assert "frame_changed" in str(exc)
        else:
            raise AssertionError(f"expected ValueError for {bad!r}")
