from windows_mcp.runtime.results import (
    DispatchStatus,
    EffectStatus,
    TargetReceipt,
    VerificationEvidence,
    confirmed_success_result,
    dispatched_unknown_result,
)
from windows_mcp.tools._action_helpers import project_dispatched_action


def _receipt() -> TargetReceipt:
    return TargetReceipt(target_kind="element", description="test target")


def test_hresult_or_sendinput_acceptance_alone_remains_unknown() -> None:
    result = dispatched_unknown_result(
        target_receipt=_receipt(),
        execution_channel="uia.invoke",
        dispatch=DispatchStatus.ACCEPTED,
    )

    assert result.effect is EffectStatus.UNKNOWN_OUTCOME
    assert result.verification is None
    assert result.requires_fresh_observation is True


def test_confirmed_success_requires_scoped_machine_readable_evidence() -> None:
    evidence = VerificationEvidence(
        verifier="scoped_uia_poll",
        predicate="element.toggle_state_changed",
        observed="predicate satisfied after dispatch",
        revision=8,
    )
    result = confirmed_success_result(
        target_receipt=_receipt(),
        execution_channel="uia.toggle",
        dispatch=DispatchStatus.POSSIBLE,
        pre_revision=7,
        post_revision=8,
        verification=evidence,
    )

    assert result.dispatch is DispatchStatus.POSSIBLE
    assert result.effect is EffectStatus.CONFIRMED_SUCCESS
    assert result.requires_fresh_observation is False
    assert result.verification is evidence


def test_compatibility_projection_records_backend_and_verification() -> None:
    class Owner:
        result = None

        def record_action_result(self, result):
            self.result = result

    owner = Owner()
    evidence = VerificationEvidence(
        verifier="scoped_uia_poll",
        predicate="element.selected_equals",
        observed="predicate satisfied after dispatch",
        revision=2,
    )

    text = project_dispatched_action(
        owner,
        "Confirmed selection.",
        target_kind="element",
        target_description="selected item",
        execution_channel="uia.select",
        pre_revision=1,
        post_revision=2,
        verification=evidence,
    )

    assert text == "Confirmed selection."
    assert owner.result.execution_channel == "uia.select"
    assert owner.result.effect is EffectStatus.CONFIRMED_SUCCESS
