"""Bounded scoped polling verifier with optional event wake-up.

The interface is event-ready: ``prepare`` captures the pre-dispatch baseline,
while ``observe_after_dispatch`` owns the post-dispatch wait. An
``EventWakeSource`` (fed by the broker) replaces fixed sleeps with an event
wait; the conclusion still comes only from fresh scoped reads — the event is
a hint that something changed, never proof of the effect (spec §11.1, §6.8).
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from windows_mcp.runtime.clock import Clock, SystemClock
from windows_mcp.runtime.metrics import METRICS
from windows_mcp.runtime.predicates import Predicate, PredicateTruth
from windows_mcp.runtime.results import VerificationEvidence
from windows_mcp.runtime.target_resolver import ResolvedTarget

# Reconciliation cadence when an event stream is attached: even a silent or
# lying provider cannot stall verification beyond this interval.
_RECONCILE_INTERVAL = 1.5


class EventWakeSource(Protocol):
    """Minimal contract a wake provider must satisfy.

    ``subscribe`` is called before dispatch so fast changes cannot be missed;
    ``wait`` returns True when an event fired for this target window (or any
    target when unscoped), False on timeout.
    """

    def subscribe(self, window_handle: int | None, changed_properties: tuple[str, ...]) -> None: ...

    def wait(self, timeout: float) -> bool: ...

    def unsubscribe(self) -> None: ...


class PollingWakeSource:
    """Degraded wake source: no events, just the reconciliation cadence."""

    def subscribe(self, window_handle: int | None, changed_properties: tuple[str, ...]) -> None:
        return

    def wait(self, timeout: float) -> bool:
        return False

    def unsubscribe(self) -> None:
        return


class BrokerWakeSource(EventWakeSource):
    """Thread-safe wake source fed by the broker supervisor's event stream.

    ``feed`` is called by the supervisor pump (or tests) with each drained
    event batch. Matching is scoped: a wake fires only for events on the
    subscribed window (when one was set) whose changed properties intersect
    the predicate's fields — focus churn elsewhere must not wake verification.

    One source instance is shared by the verifier and WaitFor's sleep
    replacement, so every wait arm must disarm behind itself: ``subscribe``
    clears a stale event before arming, and ``unsubscribe`` consumes any
    leftover wake — otherwise a finished verification leaves the event set
    and the next waiter wakes instantly on a change it never subscribed to.
    """

    def __init__(self) -> None:
        self._event = threading.Event()
        self._lock = threading.Lock()
        self._window_handle: int | None = None
        self._properties: frozenset[str] = frozenset()
        self._matched: bool = False

    def subscribe(self, window_handle: int | None, changed_properties: tuple[str, ...]) -> None:
        with self._lock:
            self._window_handle = window_handle
            self._properties = frozenset(changed_properties)
            self._matched = False
        self._event.clear()

    def feed(
        self,
        window_handle: int | None,
        kind: str,
        changed_properties: tuple[str, ...],
    ) -> None:
        """Deliver one broker event. ``resync_required`` flips the source to
        polling mode: a stream with gaps must not be trusted for wake-ups,
        and the verifier's reconciliation timer takes over."""
        with self._lock:
            if kind == "resync_required":
                self._properties = frozenset()
                self._event.set()
                self._matched = False
                return
            scoped = self._window_handle
            if scoped is not None and window_handle is not None and window_handle != scoped:
                return
            if self._properties and not self._properties.intersection(changed_properties):
                return
            self._matched = True
        self._event.set()

    def wait(self, timeout: float) -> bool:
        return self._event.wait(timeout)

    def unsubscribe(self) -> None:
        """Consume any pending wake and disarm: a finished verification must
        not leave its matched event set — or its window/property scope — for
        the next waiter. WaitFor waits unscoped on the shared source, so a
        leftover scope would silently narrow or suppress its wake-ups."""
        with self._lock:
            self._window_handle = None
            self._properties = frozenset()
            self._matched = False
        self._event.clear()


@dataclass(frozen=True, slots=True)
class VerificationHandle:
    target: ResolvedTarget
    baseline: Mapping[str, Any]
    prepared_at_qpc: int
    pre_revision: int
    wake: EventWakeSource | None = None


@dataclass(frozen=True, slots=True)
class VerificationResult:
    truth: PredicateTruth
    attempts: int
    elapsed_seconds: float
    evidence: VerificationEvidence | None = None


class PostconditionVerifier:
    def __init__(
        self,
        reader: Callable[[ResolvedTarget], Mapping[str, Any]],
        *,
        clock: Clock | None = None,
        sleeper: Callable[[float], None] = time.sleep,
        poll_interval: float = 0.05,
        wake_source: EventWakeSource | None = None,
        verifier_name: str = "scoped_uia_poll",
        frame_reader: Callable[[ResolvedTarget], Mapping[str, Any]] | None = None,
    ) -> None:
        self._reader = reader
        self._clock = clock or SystemClock()
        self._sleeper = sleeper
        self._poll_interval = poll_interval
        self._wake_source = wake_source
        self._verifier_name = verifier_name
        # Pixel evidence reader (WCC-P1-06 FrameRef contract): returns
        # ``{"frame_digest": <sha256>|None, "frame_status": <str>}`` for the
        # target. Only invoked when a frame-scoped predicate is present —
        # capturing a frame per verification tick is too expensive to do
        # speculatively.
        self._frame_reader = frame_reader

    def prepare(
        self,
        target: ResolvedTarget,
        *,
        pre_revision: int,
        predicates: tuple[Predicate, ...] = (),
    ) -> VerificationHandle:
        prepare_started = self._clock.monotonic()
        try:
            baseline = dict(self._reader(target))
        except Exception:
            baseline = {}
        frame_scoped = any(p.scope == "frame" for p in predicates)
        if frame_scoped and self._frame_reader is not None:
            try:
                baseline.update(self._frame_reader(target))
            except Exception:
                baseline["frame_digest"] = None
        wake = self._wake_source
        if wake is not None:
            # Subscribe before dispatch so fast post-dispatch events are not
            # missed between the wake-up arm and the first read. Scoping to
            # the predicate fields keeps unrelated churn from waking us.
            wake.subscribe(
                target.receipt.window_handle,
                _predicate_fields(predicates),
            )
        METRICS.observe_ms(
            "verify_prepare_ms", (self._clock.monotonic() - prepare_started) * 1000.0
        )
        return VerificationHandle(
            target=target,
            baseline=baseline,
            prepared_at_qpc=self._clock.qpc_ns(),
            pre_revision=pre_revision,
            wake=wake,
        )

    def observe_after_dispatch(
        self,
        handle: VerificationHandle,
        predicate: Predicate,
        *,
        earliest_qpc: int,
        timeout_seconds: float = 0.75,
    ) -> VerificationResult:
        if earliest_qpc < handle.prepared_at_qpc:
            raise ValueError("post-dispatch observation cannot precede verifier prepare")
        observe_started = self._clock.monotonic()
        try:
            return self._observe_until(
                handle,
                predicate,
                earliest_qpc=earliest_qpc,
                timeout_seconds=timeout_seconds,
            )
        finally:
            METRICS.observe_ms(
                "verify_observe_ms", (self._clock.monotonic() - observe_started) * 1000.0
            )
            wake = handle.wake
            if wake is not None:
                # Disarm behind ourselves: the shared wake source must not
                # carry this verification's matched event into WaitFor.
                wake.unsubscribe()

    def _observe_until(
        self,
        handle: VerificationHandle,
        predicate: Predicate,
        *,
        earliest_qpc: int,
        timeout_seconds: float,
    ) -> VerificationResult:
        started = self._clock.monotonic()
        deadline = started + max(0.0, timeout_seconds)
        attempts = 0
        last_truth = PredicateTruth.UNKNOWN
        pre_satisfied = (
            predicate.evaluate(handle.baseline, handle.baseline)
            is PredicateTruth.TRUE
        )
        frame_scoped = predicate.scope == "frame" and self._frame_reader is not None
        while True:
            attempts += 1
            try:
                current = dict(self._reader(handle.target))
                if frame_scoped:
                    # Pixel evidence (§6.8): fresh capture strictly after
                    # dispatch; incomplete frames degrade to digest=None and
                    # the frame predicate evaluates UNKNOWN on them.
                    current.update(self._frame_reader(handle.target))
                last_truth = predicate.evaluate(handle.baseline, current)
            except Exception:
                last_truth = PredicateTruth.UNKNOWN
            if last_truth is PredicateTruth.TRUE and not pre_satisfied:
                evidence = VerificationEvidence(
                    verifier=self._verifier_name,
                    predicate=predicate.description,
                    observed="predicate satisfied after dispatch",
                    revision=handle.pre_revision + 1,
                )
                return VerificationResult(
                    truth=last_truth,
                    attempts=attempts,
                    elapsed_seconds=self._clock.monotonic() - started,
                    evidence=evidence,
                )
            now = self._clock.monotonic()
            if now >= deadline:
                return VerificationResult(
                    truth=(
                        PredicateTruth.UNKNOWN
                        if pre_satisfied and last_truth is PredicateTruth.TRUE
                        else last_truth
                    ),
                    attempts=attempts,
                    elapsed_seconds=now - started,
                )
            remaining = deadline - now
            wake = handle.wake
            if wake is not None:
                # Event wait bounded by the remaining budget, with a periodic
                # reconciliation so a silent or lying provider cannot stall
                # verification past the deadline.
                woken = wake.wait(min(_RECONCILE_INTERVAL, remaining))
                if not woken:
                    # Reconciliation tick: fall through to the next read pass.
                    pass
            else:
                self._sleeper(min(self._poll_interval, remaining))


def _predicate_fields(predicates: tuple[Predicate, ...]) -> tuple[str, ...]:
    fields = tuple({p.field for p in predicates})
    return fields or ("toggle_state", "selected", "expand_state", "value")
