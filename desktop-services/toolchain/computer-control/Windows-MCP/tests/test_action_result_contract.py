import json

import pytest

from windows_mcp.runtime.errors import ErrorCode, StructuredError
from windows_mcp.runtime.results import (
    ACTION_RESULT_SCHEMA_VERSION,
    ActionResult,
    DispatchStatus,
    EffectStatus,
    TargetReceipt,
    VerificationEvidence,
    accepted_unknown_result,
    dispatched_unknown_result,
    legacy_action_text,
)
from windows_mcp.runtime.serialization import to_json_value


def _target() -> TargetReceipt:
    return TargetReceipt(target_kind="element", description="Save button")


def _result(**overrides) -> ActionResult:
    values = {
        "action_id": "act-1",
        "target_receipt": _target(),
        "dispatch": DispatchStatus.ACCEPTED,
        "effect": EffectStatus.UNKNOWN_OUTCOME,
        "retry_safe": False,
        "requires_fresh_observation": True,
        "pre_revision": 7,
    }
    values.update(overrides)
    return ActionResult(**values)


def test_confirmed_success_requires_verification() -> None:
    with pytest.raises(ValueError, match="requires verification"):
        _result(effect=EffectStatus.CONFIRMED_SUCCESS)

    result = _result(
        effect=EffectStatus.CONFIRMED_SUCCESS,
        verification=VerificationEvidence(
            verifier="uia_event", predicate="dialog closed", observed="window removed"
        ),
        requires_fresh_observation=False,
    )
    assert result.effect is EffectStatus.CONFIRMED_SUCCESS


@pytest.mark.parametrize(
    "effect",
    [
        EffectStatus.STALE_TARGET,
        EffectStatus.AMBIGUOUS_TARGET,
        EffectStatus.UNSUPPORTED,
        EffectStatus.PERMISSION_DENIED,
        EffectStatus.REFUSED,
    ],
)
def test_pre_dispatch_effects_require_not_sent(effect: EffectStatus) -> None:
    with pytest.raises(ValueError, match="requires dispatch=not_sent"):
        _result(effect=effect)


@pytest.mark.parametrize(
    "dispatch",
    [DispatchStatus.ACCEPTED, DispatchStatus.POSSIBLE, DispatchStatus.INDETERMINATE],
)
def test_dispatched_result_defaults_to_not_retry_safe(dispatch: DispatchStatus) -> None:
    with pytest.raises(ValueError, match="cannot be retry_safe"):
        _result(dispatch=dispatch, retry_safe=True)


def test_unknown_outcome_requires_fresh_observation() -> None:
    with pytest.raises(ValueError, match="fresh observation"):
        _result(requires_fresh_observation=False)


def test_error_code_and_schema_field_names_are_stable() -> None:
    result = _result(
        dispatch=DispatchStatus.NOT_SENT,
        effect=EffectStatus.REFUSED,
        retry_safe=True,
        requires_fresh_observation=False,
        error=StructuredError(ErrorCode.SECURE_DESKTOP, "secure desktop is active"),
    )
    payload = to_json_value(result)

    assert payload["schema_version"] == ACTION_RESULT_SCHEMA_VERSION
    assert payload["dispatch"] == "not_sent"
    assert payload["effect"] == "refused"
    assert payload["error"]["code"] == "secure_desktop"
    assert set(payload) == {
        "action_id",
        "target_receipt",
        "dispatch",
        "effect",
        "retry_safe",
        "requires_fresh_observation",
        "pre_revision",
        "schema_version",
        "execution_channel",
        "post_revision",
        "observed_event_ids",
        "verification",
        "warnings",
        "error",
        "metadata",
    }


def test_legacy_text_never_claims_success_without_verification() -> None:
    text = legacy_action_text(_result())
    assert "success" not in text.casefold()
    assert "unknown" in text.casefold()
    assert "fresh observation" in text.casefold()


def test_legacy_compatibility_text_is_projected_from_unknown_result() -> None:
    result = accepted_unknown_result(
        target_receipt=_target(),
        execution_channel="send_input",
        legacy_text="Single left clicked at (1,2).",
    )

    assert result.dispatch is DispatchStatus.ACCEPTED
    assert result.effect is EffectStatus.UNKNOWN_OUTCOME
    assert result.retry_safe is False
    assert result.requires_fresh_observation is True
    assert result.execution_channel == "send_input"
    assert legacy_action_text(result) == "Single left clicked at (1,2)."


def test_possible_dispatch_remains_unknown_and_never_retry_safe() -> None:
    result = dispatched_unknown_result(
        target_receipt=_target(),
        execution_channel="uia.invoke",
        dispatch=DispatchStatus.POSSIBLE,
        legacy_text="UIA invoke outcome is indeterminate.",
    )

    assert result.dispatch is DispatchStatus.POSSIBLE
    assert result.effect is EffectStatus.UNKNOWN_OUTCOME
    assert result.retry_safe is False
    assert result.requires_fresh_observation is True
    with pytest.raises(TypeError):
        result.metadata["mutate"] = True  # type: ignore[index]


# ── WCC-P2-02: host-facing target facts ─────────────────────────────────


def test_window_receipt_digest_changes_when_process_restarts() -> None:
    """PID reuse must produce a different digest so an old lease cannot ride
    across an app restart."""
    from windows_mcp.tools._action_helpers import window_receipt_digest

    first = window_receipt_digest(42, 1000, 133000000000000000)
    restarted = window_receipt_digest(42, 1000, 134000000000000000)
    assert first != restarted
    assert first == window_receipt_digest(42, 1000, 133000000000000000)


def test_project_dispatched_action_appends_target_facts(monkeypatch) -> None:
    """The projected text carries a trylo-target block with identity fields,
    dispatch/effect/channel, and the foreground digest — and no user content."""
    from windows_mcp.tools import _action_helpers as helpers

    class Owner:
        def record_action_result(self, result):
            self.result = result

        def mark_snapshot_mutated(self, snapshot_id):
            pass

    monkeypatch.setattr(helpers, "_live_process_start_100ns", lambda pid: 1330)
    monkeypatch.setattr(helpers, "_foreground_window_identity", lambda: (7, 700))
    owner = Owner()
    text = helpers.project_dispatched_action(
        owner,
        "Confirmed UIA invoke effect for (1,2).",
        target_kind="element",
        target_description="click on snapshot element elm_x",
        execution_channel="uia.invoke",
        window_handle=7,
        process_id=700,
        window_title="记事本",
        verification=VerificationEvidence(
            verifier="scoped_uia_poll",
            predicate="element.invoked",
            observed="ok",
        ),
    )
    marker = text.index(helpers.TARGET_RESULT_PREFIX)
    facts = json.loads(text[marker + len(helpers.TARGET_RESULT_PREFIX):])
    assert facts["window"]["hwnd"] == 7
    assert facts["window"]["pid"] == 700
    assert facts["window"]["title"] == "记事本"
    assert facts["window"]["digest"]
    assert facts["dispatch"] == "accepted"
    assert facts["effect"] == "confirmed_success"
    assert facts["channel"] == "uia.invoke"
    assert facts["foregroundDigest"] == helpers.window_receipt_digest(7, 700, 1330)
    # The digest the host scopes leases to is deterministic across processes.
    assert facts["window"]["digest"] == facts["foregroundDigest"]


def test_project_dispatched_action_without_window_omits_facts() -> None:
    from windows_mcp.tools import _action_helpers as helpers

    class Owner:
        pass

    text = helpers.project_dispatched_action(
        Owner(),
        "Action not sent.",
        target_kind="screen_point",
        target_description="point",
        execution_channel="send_input",
    )
    assert helpers.TARGET_RESULT_PREFIX not in text
