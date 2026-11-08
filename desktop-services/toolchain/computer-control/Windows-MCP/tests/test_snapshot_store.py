import pytest

from windows_mcp.runtime.clock import FakeClock
from windows_mcp.runtime.errors import ErrorCode
from windows_mcp.runtime.identity import (
    ElementRef,
    ProcessInstanceRef,
    ReacquireLocator,
    WindowRef,
)
from windows_mcp.runtime.observations import (
    CoverageReport,
    ElementCapabilities,
    InteractionNode,
    ObservationReceipt,
    ObservationScope,
)
from windows_mcp.runtime.snapshot_store import SnapshotStore, SnapshotStoreError


def _receipt(snapshot_id: str, expires: float, generation: int = 1) -> ObservationReceipt:
    owner = ProcessInstanceRef(pid=10, started_at_100ns=20)
    window = WindowRef("session", generation, 100, owner, 1)
    ref = ElementRef(
        element_id=f"element-{snapshot_id}",
        snapshot_id=snapshot_id,
        window=window,
        runtime_id=(1, 2, 3),
        locator=ReacquireLocator(control_type="Button", automation_id="save"),
    )
    node = InteractionNode(
        ref=ref,
        role="button",
        name="Save",
        description=None,
        value=None,
        bounds_screen=None,
        bounds_frame=None,
        enabled=True,
        offscreen=False,
        focused=False,
        protected=False,
        states={},
        capabilities=ElementCapabilities(invoke=True),
        provenance=("uia",),
        confidence=1.0,
    )
    return ObservationReceipt(
        producer_id="actor-1",
        producer_generation=generation,
        snapshot_id=snapshot_id,
        revision=1,
        observed_at_qpc=0,
        expires_at_monotonic=expires,
        scope=ObservationScope("exact_window", "100"),
        active_window=window,
        windows=(),
        elements=(node,),
        frame=None,
        coverage=CoverageReport(requested_windows=1, observed_windows=1),
    )


def test_expired_snapshot_fails_closed_with_stable_code() -> None:
    clock = FakeClock()
    store = SnapshotStore(clock=clock)
    store.put(_receipt("snap-1", expires=5), {0: "element-snap-1"})
    clock.advance(5)

    with pytest.raises(SnapshotStoreError) as exc_info:
        store.require_fresh("snap-1")

    assert exc_info.value.code is ErrorCode.STALE_SNAPSHOT
    assert len(store) == 0


def test_capacity_evicts_least_recently_used_snapshot() -> None:
    clock = FakeClock()
    store = SnapshotStore(capacity=2, clock=clock)
    store.put(_receipt("one", 10))
    store.put(_receipt("two", 10))
    store.require_fresh("one")
    store.put(_receipt("three", 10))

    assert store.require_fresh("one").receipt.snapshot_id == "one"
    with pytest.raises(SnapshotStoreError):
        store.require_fresh("two")


def test_labels_are_snapshot_bound_and_negative_labels_fail() -> None:
    store = SnapshotStore(clock=FakeClock())
    store.put(_receipt("one", 10), {0: "element-one"})
    store.put(_receipt("two", 10), {0: "element-two"})

    assert store.resolve_element("one", label=0).element_id == "element-one"
    with pytest.raises(ValueError, match="non-negative"):
        store.resolve_element("one", label=-1)
    with pytest.raises(SnapshotStoreError) as exc_info:
        store.resolve_element("one", element_id="element-two")
    assert exc_info.value.code is ErrorCode.STALE_ELEMENT


def test_generation_mismatch_and_invalidation_fail_closed() -> None:
    store = SnapshotStore(clock=FakeClock())
    store.put(_receipt("one", 10, generation=3))

    with pytest.raises(SnapshotStoreError):
        store.require_fresh("one", producer_generation=4)
    assert store.invalidate_generation(3) == 1
    with pytest.raises(SnapshotStoreError):
        store.require_fresh("one")


def test_dispatched_mutation_supersedes_snapshot_for_future_mutations() -> None:
    store = SnapshotStore(clock=FakeClock())
    store.put(_receipt("one", 10), {0: "element-one"})

    store.mark_superseded_for_mutation("one")

    # Observation/debug reads remain available, but a second mutation cannot
    # be authorized from pre-mutation state.
    assert store.require_fresh("one").receipt.snapshot_id == "one"
    with pytest.raises(SnapshotStoreError, match="superseded") as exc_info:
        store.resolve_node("one", label=0, for_mutation=True)
    assert exc_info.value.code is ErrorCode.STALE_SNAPSHOT


def test_mutation_claim_prevents_two_callers_from_using_same_snapshot() -> None:
    store = SnapshotStore(clock=FakeClock())
    store.put(_receipt("one", 10), {0: "element-one"})

    store.claim_for_mutation("one")

    with pytest.raises(SnapshotStoreError, match="claimed"):
        store.claim_for_mutation("one")
    # Finalization converts the claim into a permanent mutation supersession.
    store.mark_superseded_for_mutation("one")
    with pytest.raises(SnapshotStoreError, match="superseded"):
        store.require_fresh("one", for_mutation=True)
