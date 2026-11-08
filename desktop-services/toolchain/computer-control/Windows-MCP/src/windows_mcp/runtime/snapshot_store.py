"""Bounded, TTL-aware store for immutable observation receipts."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping

from windows_mcp.runtime.clock import Clock, SystemClock
from windows_mcp.runtime.errors import ErrorCode
from windows_mcp.runtime.identity import ElementRef
from windows_mcp.runtime.observations import ObservationReceipt
from windows_mcp.runtime.observations import InteractionNode


class SnapshotStoreError(LookupError):
    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class SnapshotRecord:
    receipt: ObservationReceipt
    label_to_element_id: Mapping[int, str]

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "label_to_element_id",
            MappingProxyType(dict(self.label_to_element_id)),
        )


class SnapshotStore:
    def __init__(self, capacity: int = 8, clock: Clock | None = None) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._capacity = capacity
        self._clock = clock or SystemClock()
        self._records: OrderedDict[str, SnapshotRecord] = OrderedDict()
        self._superseded_for_mutation: set[str] = set()
        self._mutation_claims: set[str] = set()

    def put(
        self,
        receipt: ObservationReceipt,
        label_to_element_id: Mapping[int, str] | None = None,
    ) -> SnapshotRecord:
        if receipt.expires_at_monotonic <= self._clock.monotonic():
            raise SnapshotStoreError(
                ErrorCode.STALE_SNAPSHOT, "cannot store an already-expired snapshot"
            )
        ids = {element.ref.element_id for element in receipt.elements}
        labels = dict(label_to_element_id or {})
        for label, element_id in labels.items():
            if type(label) is not int or label < 0:
                raise ValueError("snapshot labels must be non-negative integers")
            if element_id not in ids:
                raise ValueError(f"label {label} references an element outside the snapshot")
        record = SnapshotRecord(receipt=receipt, label_to_element_id=labels)
        self._records[receipt.snapshot_id] = record
        self._superseded_for_mutation.discard(receipt.snapshot_id)
        self._mutation_claims.discard(receipt.snapshot_id)
        self._records.move_to_end(receipt.snapshot_id)
        while len(self._records) > self._capacity:
            evicted_id, _ = self._records.popitem(last=False)
            self._superseded_for_mutation.discard(evicted_id)
            self._mutation_claims.discard(evicted_id)
        return record

    def require_fresh(
        self,
        snapshot_id: str,
        producer_generation: int | None = None,
        *,
        for_mutation: bool = False,
    ) -> SnapshotRecord:
        record = self._records.get(snapshot_id)
        if record is None:
            raise SnapshotStoreError(
                ErrorCode.STALE_SNAPSHOT, f"snapshot {snapshot_id!r} is unavailable"
            )
        if record.receipt.expires_at_monotonic <= self._clock.monotonic():
            self._records.pop(snapshot_id, None)
            self._superseded_for_mutation.discard(snapshot_id)
            self._mutation_claims.discard(snapshot_id)
            raise SnapshotStoreError(
                ErrorCode.STALE_SNAPSHOT,
                f"snapshot {snapshot_id!r} has expired; capture a fresh Snapshot "
                "and use its target references before retrying. No input was sent.",
            )
        if (
            producer_generation is not None
            and record.receipt.producer_generation != producer_generation
        ):
            raise SnapshotStoreError(
                ErrorCode.STALE_SNAPSHOT,
                "snapshot belongs to an obsolete producer generation",
            )
        if for_mutation and (
            snapshot_id in self._superseded_for_mutation
            or snapshot_id in self._mutation_claims
        ):
            raise SnapshotStoreError(
                ErrorCode.STALE_SNAPSHOT,
                "snapshot is already claimed or superseded by a mutation; capture a fresh snapshot",
            )
        self._records.move_to_end(snapshot_id)
        return record

    def resolve_element(
        self,
        snapshot_id: str,
        *,
        label: int | None = None,
        element_id: str | None = None,
        producer_generation: int | None = None,
        for_mutation: bool = False,
    ) -> ElementRef:
        return self.resolve_node(
            snapshot_id,
            label=label,
            element_id=element_id,
            producer_generation=producer_generation,
            for_mutation=for_mutation,
        ).ref

    def resolve_node(
        self,
        snapshot_id: str,
        *,
        label: int | None = None,
        element_id: str | None = None,
        producer_generation: int | None = None,
        for_mutation: bool = False,
    ) -> InteractionNode:
        record = self.require_fresh(
            snapshot_id,
            producer_generation,
            for_mutation=for_mutation,
        )
        if (label is None) == (element_id is None):
            raise ValueError("provide exactly one of label or element_id")
        if label is not None:
            if type(label) is not int or label < 0:
                raise ValueError("label must be a non-negative integer")
            element_id = record.label_to_element_id.get(label)
            if element_id is None:
                raise SnapshotStoreError(
                    ErrorCode.STALE_ELEMENT,
                    f"label {label} is not present in snapshot {snapshot_id!r}",
                )
        for element in record.receipt.elements:
            if element.ref.element_id == element_id:
                return element
        raise SnapshotStoreError(
            ErrorCode.STALE_ELEMENT,
            f"element {element_id!r} is not present in snapshot {snapshot_id!r}",
        )

    def mark_superseded_for_mutation(
        self,
        snapshot_id: str,
        producer_generation: int | None = None,
    ) -> None:
        """Prevent another mutation from being authorized by the same receipt."""
        self.require_fresh(snapshot_id, producer_generation)
        self._mutation_claims.discard(snapshot_id)
        self._superseded_for_mutation.add(snapshot_id)

    def claim_for_mutation(
        self,
        snapshot_id: str,
        producer_generation: int | None = None,
    ) -> None:
        """Atomically reserve one fresh observation for exactly one mutation."""
        self.require_fresh(
            snapshot_id,
            producer_generation,
            for_mutation=True,
        )
        self._mutation_claims.add(snapshot_id)

    def invalidate_generation(self, producer_generation: int) -> int:
        stale_ids = [
            snapshot_id
            for snapshot_id, record in self._records.items()
            if record.receipt.producer_generation == producer_generation
        ]
        for snapshot_id in stale_ids:
            self._records.pop(snapshot_id, None)
            self._superseded_for_mutation.discard(snapshot_id)
            self._mutation_claims.discard(snapshot_id)
        return len(stale_ids)

    def __len__(self) -> int:
        return len(self._records)
