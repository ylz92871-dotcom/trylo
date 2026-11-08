from collections import deque

import pytest

from windows_mcp.runtime.clock import FakeClock
from windows_mcp.runtime.predicates import (
    PredicateTruth,
    changed,
    contains,
    equals,
    exists,
    gone,
    matches,
)
from windows_mcp.runtime.results import TargetReceipt
from windows_mcp.runtime.target_resolver import ResolvedTarget
from windows_mcp.runtime.verifier import PostconditionVerifier


def _target() -> ResolvedTarget:
    return ResolvedTarget(
        receipt=TargetReceipt(target_kind="element", description="target"),
        screen_point=(10, 20),
        source="test",
    )


def test_prepare_reads_baseline_before_post_dispatch_polling() -> None:
    clock = FakeClock()
    states = deque([{"toggle_state": 0}, {"toggle_state": 0}, {"toggle_state": 1}])
    calls: list[float] = []

    def reader(target):
        calls.append(clock.now)
        return states.popleft()

    verifier = PostconditionVerifier(
        reader,
        clock=clock,
        sleeper=clock.advance,
        poll_interval=0.05,
    )
    handle = verifier.prepare(_target(), pre_revision=7)
    result = verifier.observe_after_dispatch(
        handle,
        changed("toggle_state"),
        earliest_qpc=clock.qpc_ns(),
        timeout_seconds=0.2,
    )

    assert calls[0] == 0.0
    assert result.truth is PredicateTruth.TRUE
    assert result.attempts == 2
    assert result.evidence is not None
    assert result.evidence.revision == 8
    assert result.evidence.observed == "predicate satisfied after dispatch"


def test_unsatisfied_complete_reads_do_not_claim_success() -> None:
    clock = FakeClock()
    verifier = PostconditionVerifier(
        lambda target: {"selected": False},
        clock=clock,
        sleeper=clock.advance,
        poll_interval=0.05,
    )
    handle = verifier.prepare(_target(), pre_revision=1)

    result = verifier.observe_after_dispatch(
        handle,
        equals("selected", True),
        earliest_qpc=clock.qpc_ns(),
        timeout_seconds=0.1,
    )

    assert result.truth is PredicateTruth.FALSE
    assert result.evidence is None


def test_incomplete_reader_is_unknown_not_success() -> None:
    clock = FakeClock()
    verifier = PostconditionVerifier(
        lambda target: {},
        clock=clock,
        sleeper=clock.advance,
        poll_interval=0.05,
    )
    handle = verifier.prepare(_target(), pre_revision=1)

    result = verifier.observe_after_dispatch(
        handle,
        changed("expand_state"),
        earliest_qpc=clock.qpc_ns(),
        timeout_seconds=0.05,
    )

    assert result.truth is PredicateTruth.UNKNOWN
    assert result.evidence is None


def test_observation_timestamp_cannot_precede_prepare() -> None:
    clock = FakeClock(now=1.0)
    verifier = PostconditionVerifier(lambda target: {}, clock=clock)
    handle = verifier.prepare(_target(), pre_revision=1)

    with pytest.raises(ValueError, match="cannot precede"):
        verifier.observe_after_dispatch(
            handle,
            changed("toggle_state"),
            earliest_qpc=handle.prepared_at_qpc - 1,
        )


def test_preexisting_expected_state_is_not_misattributed_to_action() -> None:
    clock = FakeClock()
    verifier = PostconditionVerifier(
        lambda target: {"selected": True},
        clock=clock,
        sleeper=clock.advance,
    )
    handle = verifier.prepare(_target(), pre_revision=1)

    result = verifier.observe_after_dispatch(
        handle,
        equals("selected", True),
        earliest_qpc=clock.qpc_ns(),
        timeout_seconds=0,
    )

    assert result.truth is PredicateTruth.UNKNOWN
    assert result.evidence is None


def test_predicate_vocabulary_covers_element_window_frame_and_process_state() -> None:
    baseline = {"exists": True, "title": "Draft - Notepad", "pixels": "a"}
    current = {"exists": False, "title": "Saved - Notepad", "pixels": "b"}

    assert gone().evaluate(baseline, current) is PredicateTruth.TRUE
    assert exists().evaluate(baseline, current) is PredicateTruth.FALSE
    assert contains("title", "notepad", scope="window").evaluate(
        baseline, current
    ) is PredicateTruth.TRUE
    assert matches("title", "Saved*", scope="window").evaluate(
        baseline, current
    ) is PredicateTruth.TRUE
    assert changed("pixels", scope="frame").evaluate(
        baseline, current
    ) is PredicateTruth.TRUE
    assert equals("exists", False, scope="application").evaluate(
        baseline, current
    ) is PredicateTruth.TRUE
