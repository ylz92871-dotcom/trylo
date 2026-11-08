"""Machine-readable postcondition predicates for scoped UI verification."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from fnmatch import fnmatchcase
from typing import Any, Mapping


class PredicateOperator(StrEnum):
    CHANGED = "changed"
    EQUALS = "equals"
    CONTAINS = "contains"
    MATCHES = "matches"
    EXISTS = "exists"
    GONE = "gone"
    FRAME_CHANGED = "frame_changed"


class PredicateTruth(StrEnum):
    TRUE = "true"
    FALSE = "false"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class Predicate:
    field: str
    operator: PredicateOperator
    expected: Any = None
    scope: str = "element"

    @property
    def description(self) -> str:
        return f"{self.scope}.{self.field}_{self.operator.value}"

    def evaluate(
        self,
        baseline: Mapping[str, Any],
        current: Mapping[str, Any],
    ) -> PredicateTruth:
        if self.operator is PredicateOperator.FRAME_CHANGED:
            return self._evaluate_frame_changed(baseline, current)
        if self.operator is PredicateOperator.EXISTS:
            if self.field not in current:
                return PredicateTruth.UNKNOWN
            return PredicateTruth.TRUE if bool(current[self.field]) else PredicateTruth.FALSE
        if self.operator is PredicateOperator.GONE:
            if self.field not in current:
                return PredicateTruth.UNKNOWN
            return PredicateTruth.TRUE if not bool(current[self.field]) else PredicateTruth.FALSE
        if self.field not in current:
            return PredicateTruth.UNKNOWN
        if self.operator is PredicateOperator.EQUALS:
            return (
                PredicateTruth.TRUE
                if current[self.field] == self.expected
                else PredicateTruth.FALSE
            )
        if self.operator is PredicateOperator.CONTAINS:
            value = current[self.field]
            if value is None or self.expected is None:
                return PredicateTruth.FALSE
            return (
                PredicateTruth.TRUE
                if str(self.expected).casefold() in str(value).casefold()
                else PredicateTruth.FALSE
            )
        if self.operator is PredicateOperator.MATCHES:
            value = current[self.field]
            if value is None or self.expected is None:
                return PredicateTruth.FALSE
            return (
                PredicateTruth.TRUE
                if fnmatchcase(str(value).casefold(), str(self.expected).casefold())
                else PredicateTruth.FALSE
            )
        if self.field not in baseline:
            return PredicateTruth.UNKNOWN
        return (
            PredicateTruth.TRUE
            if current[self.field] != baseline[self.field]
            else PredicateTruth.FALSE
        )

    def _evaluate_frame_changed(
        self,
        baseline: Mapping[str, Any],
        current: Mapping[str, Any],
    ) -> PredicateTruth:
        """Pixel evidence rule (§6.8): only COMPLETE frames count. A missing
        or degraded digest on either side is UNKNOWN — a frame the provider
        could not honestly produce must never confirm an effect."""
        baseline_digest = baseline.get(self.field)
        current_digest = current.get(self.field)
        if not isinstance(baseline_digest, str) or not isinstance(current_digest, str):
            return PredicateTruth.UNKNOWN
        return (
            PredicateTruth.TRUE
            if current_digest != baseline_digest
            else PredicateTruth.FALSE
        )


def changed(field: str, *, scope: str = "element") -> Predicate:
    return Predicate(field=field, operator=PredicateOperator.CHANGED, scope=scope)


def equals(field: str, expected: Any, *, scope: str = "element") -> Predicate:
    return Predicate(
        field=field,
        operator=PredicateOperator.EQUALS,
        expected=expected,
        scope=scope,
    )


def contains(field: str, expected: Any, *, scope: str = "element") -> Predicate:
    return Predicate(
        field=field,
        operator=PredicateOperator.CONTAINS,
        expected=expected,
        scope=scope,
    )


def matches(field: str, expected: str, *, scope: str = "element") -> Predicate:
    return Predicate(
        field=field,
        operator=PredicateOperator.MATCHES,
        expected=expected,
        scope=scope,
    )


def exists(field: str = "exists", *, scope: str = "element") -> Predicate:
    return Predicate(field=field, operator=PredicateOperator.EXISTS, scope=scope)


def gone(field: str = "exists", *, scope: str = "element") -> Predicate:
    return Predicate(field=field, operator=PredicateOperator.GONE, scope=scope)


def frame_changed(*, scope: str = "frame") -> Predicate:
    """The captured frame of the target window CHANGED vs baseline.

    Only complete frames (with a digest string on both sides) can satisfy
    this; idle/degraded/unavailable frames evaluate UNKNOWN.
    """
    return Predicate(
        field="frame_digest",
        operator=PredicateOperator.FRAME_CHANGED,
        scope=scope,
    )
