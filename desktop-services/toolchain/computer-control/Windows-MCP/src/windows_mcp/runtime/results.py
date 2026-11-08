"""Action dispatch/effect result contract.

The central invariant is epistemic: an API accepting an action is not proof
that the requested UI state changed.  ``confirmed_success`` therefore cannot
be constructed without explicit verification evidence.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from enum import StrEnum
from types import MappingProxyType
from typing import Any, Mapping

from windows_mcp.runtime.errors import StructuredError

ACTION_RESULT_SCHEMA_VERSION = 2
_LEGACY_TEXT_KEY = "legacy_text"


class DispatchStatus(StrEnum):
    NOT_SENT = "not_sent"
    ACCEPTED = "accepted"
    POSSIBLE = "possible"
    INDETERMINATE = "indeterminate"


class EffectStatus(StrEnum):
    CONFIRMED_SUCCESS = "confirmed_success"
    CONFIRMED_NO_EFFECT = "confirmed_no_effect"
    UNKNOWN_OUTCOME = "unknown_outcome"
    STALE_TARGET = "stale_target"
    AMBIGUOUS_TARGET = "ambiguous_target"
    UNSUPPORTED = "unsupported"
    PERMISSION_DENIED = "permission_denied"
    REFUSED = "refused"


_NOT_SENT_EFFECTS = frozenset(
    {
        EffectStatus.STALE_TARGET,
        EffectStatus.AMBIGUOUS_TARGET,
        EffectStatus.UNSUPPORTED,
        EffectStatus.PERMISSION_DENIED,
        EffectStatus.REFUSED,
    }
)


@dataclass(frozen=True, slots=True)
class TargetReceipt:
    target_kind: str
    description: str
    snapshot_id: str | None = None
    element_id: str | None = None
    window_handle: int | None = None
    process_id: int | None = None


@dataclass(frozen=True, slots=True)
class VerificationEvidence:
    verifier: str
    predicate: str
    observed: str
    revision: int | None = None
    event_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not self.verifier or not self.predicate or not self.observed:
            raise ValueError("verification evidence fields must not be empty")


@dataclass(frozen=True, slots=True)
class RuntimeWarning:
    code: str
    message: str


@dataclass(frozen=True, slots=True)
class ActionResult:
    action_id: str
    target_receipt: TargetReceipt
    dispatch: DispatchStatus
    effect: EffectStatus
    retry_safe: bool
    requires_fresh_observation: bool
    pre_revision: int
    schema_version: int = ACTION_RESULT_SCHEMA_VERSION
    execution_channel: str | None = None
    post_revision: int | None = None
    observed_event_ids: tuple[str, ...] = ()
    verification: VerificationEvidence | None = None
    warnings: tuple[RuntimeWarning, ...] = ()
    error: StructuredError | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.schema_version != ACTION_RESULT_SCHEMA_VERSION:
            raise ValueError(
                f"schema_version must be {ACTION_RESULT_SCHEMA_VERSION}"
            )
        if not self.action_id.strip():
            raise ValueError("action_id must not be empty")
        if self.pre_revision < 0 or (
            self.post_revision is not None and self.post_revision < self.pre_revision
        ):
            raise ValueError("result revisions are invalid")
        if self.effect is EffectStatus.CONFIRMED_SUCCESS and self.verification is None:
            raise ValueError("confirmed_success requires verification evidence")
        if self.effect in _NOT_SENT_EFFECTS and self.dispatch is not DispatchStatus.NOT_SENT:
            raise ValueError(f"{self.effect.value} requires dispatch=not_sent")
        if self.dispatch is not DispatchStatus.NOT_SENT and self.retry_safe:
            raise ValueError(
                "a dispatched action cannot be retry_safe without a higher-level "
                "verified idempotency decision"
            )
        if self.effect is EffectStatus.UNKNOWN_OUTCOME:
            if not self.requires_fresh_observation:
                raise ValueError("unknown_outcome requires a fresh observation")
            if self.retry_safe:
                raise ValueError("unknown_outcome cannot be retry_safe")
        object.__setattr__(self, "metadata", MappingProxyType(dict(self.metadata)))


def dispatched_unknown_result(
    *,
    target_receipt: TargetReceipt,
    execution_channel: str,
    dispatch: DispatchStatus = DispatchStatus.ACCEPTED,
    pre_revision: int = 0,
    legacy_text: str | None = None,
    warnings: tuple[RuntimeWarning, ...] = (),
) -> ActionResult:
    """Build the honest result for an actuator with no post-read.

    Returning from SendInput/UIA/app launch proves only that dispatch was
    accepted or may have occurred. It does not prove the requested UI or
    business effect.
    """
    if dispatch not in {DispatchStatus.ACCEPTED, DispatchStatus.POSSIBLE}:
        raise ValueError("unknown dispatched result must be accepted or possible")
    metadata: dict[str, Any] = {}
    if legacy_text is not None:
        metadata[_LEGACY_TEXT_KEY] = legacy_text
    return ActionResult(
        action_id=f"action_{secrets.token_hex(16)}",
        target_receipt=target_receipt,
        dispatch=dispatch,
        effect=EffectStatus.UNKNOWN_OUTCOME,
        retry_safe=False,
        requires_fresh_observation=True,
        pre_revision=pre_revision,
        execution_channel=execution_channel,
        warnings=warnings,
        metadata=metadata,
    )


def accepted_unknown_result(
    *,
    target_receipt: TargetReceipt,
    execution_channel: str,
    pre_revision: int = 0,
    legacy_text: str | None = None,
    warnings: tuple[RuntimeWarning, ...] = (),
) -> ActionResult:
    return dispatched_unknown_result(
        target_receipt=target_receipt,
        execution_channel=execution_channel,
        dispatch=DispatchStatus.ACCEPTED,
        pre_revision=pre_revision,
        legacy_text=legacy_text,
        warnings=warnings,
    )


def confirmed_success_result(
    *,
    target_receipt: TargetReceipt,
    execution_channel: str,
    dispatch: DispatchStatus,
    pre_revision: int,
    post_revision: int,
    verification: VerificationEvidence,
    legacy_text: str | None = None,
    warnings: tuple[RuntimeWarning, ...] = (),
) -> ActionResult:
    if dispatch not in {DispatchStatus.ACCEPTED, DispatchStatus.POSSIBLE}:
        raise ValueError("confirmed dispatched result must be accepted or possible")
    metadata: dict[str, Any] = {}
    if legacy_text is not None:
        metadata[_LEGACY_TEXT_KEY] = legacy_text
    return ActionResult(
        action_id=f"action_{secrets.token_hex(16)}",
        target_receipt=target_receipt,
        dispatch=dispatch,
        effect=EffectStatus.CONFIRMED_SUCCESS,
        retry_safe=False,
        requires_fresh_observation=False,
        pre_revision=pre_revision,
        execution_channel=execution_channel,
        post_revision=post_revision,
        verification=verification,
        warnings=warnings,
        metadata=metadata,
    )


def legacy_action_text(result: ActionResult) -> str:
    """Project the V2 result into conservative legacy text."""
    compatibility_text = result.metadata.get(_LEGACY_TEXT_KEY)
    if isinstance(compatibility_text, str):
        return compatibility_text
    target = result.target_receipt.description or result.target_receipt.target_kind
    if result.effect is EffectStatus.CONFIRMED_SUCCESS:
        return f"Confirmed action effect on {target}."
    if result.effect is EffectStatus.CONFIRMED_NO_EFFECT:
        return f"Action produced no observed effect on {target}."
    if result.effect is EffectStatus.UNKNOWN_OUTCOME:
        return (
            f"Action dispatch outcome on {target} is unknown; obtain a fresh "
            "observation before deciding whether another action is safe."
        )
    if result.error is not None:
        return f"Action not sent ({result.error.code.value}): {result.error.message}"
    return f"Action not sent: {result.effect.value.replace('_', ' ')} for {target}."
