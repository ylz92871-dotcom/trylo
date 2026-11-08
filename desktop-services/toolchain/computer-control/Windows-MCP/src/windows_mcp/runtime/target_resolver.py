"""Fresh, unique target resolution before any desktop mutation."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

from windows_mcp.runtime.errors import ErrorCode
from windows_mcp.runtime.generation_registry import (
    GenerationRegistry,
    GenerationValidationError,
)
from windows_mcp.runtime.identity import ElementRef, ReacquireLocator, WindowRef
from windows_mcp.runtime.metrics import METRICS
from windows_mcp.runtime.observations import ElementCapabilities, InteractionNode, Rect
from windows_mcp.runtime.results import TargetReceipt
from windows_mcp.runtime.snapshot_store import SnapshotStore, SnapshotStoreError

# Dispatch-front refusals that §18.3 counts as "stale target": every code
# meaning the requested target no longer exists as observed.
_STALE_REFUSAL_CODES = frozenset(
    {
        ErrorCode.STALE_SNAPSHOT,
        ErrorCode.STALE_PROCESS,
        ErrorCode.STALE_WINDOW,
        ErrorCode.STALE_ELEMENT,
        ErrorCode.TARGET_MOVED,
    }
)


class TargetResolutionError(RuntimeError):
    def __init__(self, code: ErrorCode, message: str) -> None:
        self.code = code
        super().__init__(message)
        # §18.3 stale_target_refusal_count: every dispatch-front refusal in
        # the stale family passes through this single construction point
        # (resolver, generation registry, snapshot store all raise here).
        # Metrics must never mask the refusal itself.
        try:
            if code in _STALE_REFUSAL_CODES:
                METRICS.inc("stale_target_refusal_count")
        except Exception:
            pass


@dataclass(frozen=True, slots=True)
class LiveElementCandidate:
    runtime_id: tuple[int, ...] | None
    control_type: str
    automation_id: str | None
    class_name: str | None
    framework_id: str | None
    name: str | None
    bounds: Rect | None

    @property
    def center(self) -> tuple[int, int] | None:
        if self.bounds is None:
            return None
        return (
            self.bounds.left + (self.bounds.right - self.bounds.left) // 2,
            self.bounds.top + (self.bounds.bottom - self.bounds.top) // 2,
        )


class TargetBackend(Protocol):
    def find_by_runtime_id(
        self, window: WindowRef, runtime_id: tuple[int, ...]
    ) -> Sequence[LiveElementCandidate]: ...

    def find_by_locator(
        self, window: WindowRef, locator: ReacquireLocator
    ) -> Sequence[LiveElementCandidate]: ...

    def query_by_name(
        self, window: WindowRef, query: str
    ) -> Sequence[LiveElementCandidate]: ...

    def window_at_point(self, x: int, y: int) -> tuple[int, int] | None: ...


@dataclass(frozen=True, slots=True)
class ResolvedTarget:
    receipt: TargetReceipt
    screen_point: tuple[int, int] | None
    source: str
    element_ref: ElementRef | None = None
    live_element: LiveElementCandidate | None = None
    role: str | None = None
    capabilities: ElementCapabilities | None = None
    protected: bool | None = None


def _normalized_role(value: str) -> str:
    return value.casefold().replace(" ", "").removesuffix("control")


def _bounds_compatible(observed: Rect | None, live: Rect | None) -> bool:
    if observed is None or live is None:
        return observed is live
    intersection_width = max(0, min(observed.right, live.right) - max(observed.left, live.left))
    intersection_height = max(0, min(observed.bottom, live.bottom) - max(observed.top, live.top))
    intersection = intersection_width * intersection_height
    observed_area = max(1, (observed.right - observed.left) * (observed.bottom - observed.top))
    live_area = max(1, (live.right - live.left) * (live.bottom - live.top))
    union = observed_area + live_area - intersection
    return intersection / max(1, union) >= 0.2


class TargetResolver:
    def __init__(
        self,
        *,
        snapshots: SnapshotStore,
        generations: GenerationRegistry,
        backend: TargetBackend,
        current_desktop_session: Callable[[], str],
    ) -> None:
        self._snapshots = snapshots
        self._generations = generations
        self._backend = backend
        self._current_desktop_session = current_desktop_session

    def _store(self, method, /, *args, **kwargs):
        """Snapshot-store failures are stale-family refusals; convert them at
        the resolver boundary so every dispatch-front refusal genuinely flows
        through TargetResolutionError's single §18.3 counting point. Live
        matrix batch 1 found the raw SnapshotStoreError bypassing the counter
        (stale_target_refusal_count read 0 after a claimed-snapshot refusal)."""
        try:
            return method(*args, **kwargs)
        except SnapshotStoreError as exc:
            raise TargetResolutionError(exc.code, str(exc)) from exc

    def _validate_window(self, window: WindowRef) -> None:
        if window.desktop_session_id != self._current_desktop_session():
            raise TargetResolutionError(
                ErrorCode.STALE_WINDOW,
                "target belongs to a different desktop session",
            )
        try:
            self._generations.validate_window(window)
        except GenerationValidationError as exc:
            raise TargetResolutionError(exc.code, str(exc)) from exc

    @staticmethod
    def _one(
        candidates: Sequence[LiveElementCandidate],
        *,
        missing_code: ErrorCode = ErrorCode.STALE_ELEMENT,
    ) -> LiveElementCandidate:
        if not candidates:
            raise TargetResolutionError(missing_code, "target was not found in the live window")
        if len(candidates) > 1:
            summary = [
                {
                    "name": candidate.name,
                    "control_type": candidate.control_type,
                    "automation_id": candidate.automation_id,
                    "bounds": candidate.bounds,
                }
                for candidate in candidates[:5]
            ]
            raise TargetResolutionError(
                ErrorCode.AMBIGUOUS_TARGET,
                f"target query matched {len(candidates)} live elements: {summary}",
            )
        return candidates[0]

    @staticmethod
    def _validate_element(node: InteractionNode, live: LiveElementCandidate) -> None:
        locator = node.ref.locator
        if _normalized_role(live.control_type) != _normalized_role(locator.control_type):
            raise TargetResolutionError(
                ErrorCode.STALE_ELEMENT,
                "live element role conflicts with the observation",
            )
        if locator.automation_id and live.automation_id != locator.automation_id:
            raise TargetResolutionError(
                ErrorCode.STALE_ELEMENT,
                "live element AutomationId conflicts with the observation",
            )
        if not _bounds_compatible(node.bounds_screen, live.bounds):
            raise TargetResolutionError(
                ErrorCode.TARGET_MOVED,
                "live element bounds moved outside the observed target",
            )

    def resolve_element(
        self,
        snapshot_id: str,
        *,
        label: int | None = None,
        element_id: str | None = None,
        claim: bool = True,
    ) -> ResolvedTarget:
        node = self._store(self._snapshots.resolve_node,
            snapshot_id,
            label=label,
            element_id=element_id,
            producer_generation=self._generations.producer_generation,
            for_mutation=True,
        )
        self._validate_window(node.ref.window)
        candidates: Sequence[LiveElementCandidate] = ()
        source = "composite_locator"
        if node.ref.runtime_id is not None:
            candidates = self._backend.find_by_runtime_id(
                node.ref.window, node.ref.runtime_id
            )
            source = "runtime_id"
        if not candidates:
            candidates = self._backend.find_by_locator(node.ref.window, node.ref.locator)
            source = "composite_locator"
        live = self._one(candidates)
        self._validate_element(node, live)
        point = live.center
        if point is None:
            raise TargetResolutionError(
                ErrorCode.TARGET_NOT_FOUND,
                "resolved element has no actionable bounds",
            )
        if claim:
            self._store(self._snapshots.claim_for_mutation,
                snapshot_id, self._generations.producer_generation
            )
        return ResolvedTarget(
            receipt=TargetReceipt(
                target_kind="element",
                description=f"{node.role} {node.name!r}",
                snapshot_id=snapshot_id,
                element_id=node.ref.element_id,
                window_handle=node.ref.window.hwnd,
                process_id=node.ref.window.owner.pid,
            ),
            screen_point=point,
            source=source,
            element_ref=node.ref,
            live_element=live,
            role=node.role,
            capabilities=node.capabilities,
            protected=node.protected,
        )

    def resolve_query(
        self,
        snapshot_id: str,
        query: str,
        *,
        window: WindowRef | None = None,
        claim: bool = True,
    ) -> ResolvedTarget:
        record = self._store(self._snapshots.require_fresh,
            snapshot_id,
            self._generations.producer_generation,
            for_mutation=True,
        )
        target_window = window or record.receipt.active_window
        if target_window is None:
            raise TargetResolutionError(
                ErrorCode.TARGET_NOT_FOUND,
                "a fresh exact target window is required for element queries",
            )
        self._validate_window(target_window)
        live = self._one(
            self._backend.query_by_name(target_window, query),
            missing_code=ErrorCode.TARGET_NOT_FOUND,
        )
        if live.center is None:
            raise TargetResolutionError(
                ErrorCode.TARGET_NOT_FOUND,
                "resolved element has no actionable bounds",
            )
        if claim:
            self._store(self._snapshots.claim_for_mutation,
                snapshot_id, self._generations.producer_generation
            )
        return ResolvedTarget(
            receipt=TargetReceipt(
                target_kind="element_query",
                description=f"unique live element {live.name!r}",
                snapshot_id=snapshot_id,
                window_handle=target_window.hwnd,
                process_id=target_window.owner.pid,
            ),
            screen_point=live.center,
            source="fresh_scoped_query",
            live_element=live,
            role=live.control_type,
        )

    def resolve_frame_point(
        self, snapshot_id: str, x: int, y: int, *, claim: bool = True
    ) -> ResolvedTarget:
        record = self._store(self._snapshots.require_fresh,
            snapshot_id,
            self._generations.producer_generation,
            for_mutation=True,
        )
        frame = record.receipt.frame
        if frame is None:
            raise TargetResolutionError(
                ErrorCode.STALE_SNAPSHOT,
                "snapshot has no image frame",
            )
        if not 0 <= x < frame.pixel_width or not 0 <= y < frame.pixel_height:
            raise TargetResolutionError(
                ErrorCode.TARGET_NOT_FOUND,
                f"image point ({x}, {y}) lies outside the snapshot frame",
            )
        screen_x, screen_y = frame.image_to_screen.apply(x, y)
        point = (int(round(screen_x)), int(round(screen_y)))
        return self._resolve_screen_point(
            record.receipt,
            point,
            source="fresh_frame",
            claim=claim,
        )

    def resolve_screen_point(
        self, snapshot_id: str, x: int, y: int, *, claim: bool = True
    ) -> ResolvedTarget:
        record = self._store(self._snapshots.require_fresh,
            snapshot_id,
            self._generations.producer_generation,
            for_mutation=True,
        )
        return self._resolve_screen_point(
            record.receipt,
            (x, y),
            source="fresh_screen_point",
            claim=claim,
        )

    def resolve_additional_point(
        self,
        snapshot_id: str,
        x: int,
        y: int,
        *,
        coordinate_space: str = "screen",
    ) -> ResolvedTarget:
        """Verify another point inside an already-claimed compound mutation."""
        record = self._store(self._snapshots.require_fresh,
            snapshot_id,
            self._generations.producer_generation,
        )
        point = (x, y)
        if coordinate_space == "screenshot":
            frame = record.receipt.frame
            if frame is None:
                raise TargetResolutionError(
                    ErrorCode.STALE_SNAPSHOT,
                    "snapshot has no image frame",
                )
            if not 0 <= x < frame.pixel_width or not 0 <= y < frame.pixel_height:
                raise TargetResolutionError(
                    ErrorCode.TARGET_NOT_FOUND,
                    f"image point ({x}, {y}) lies outside the snapshot frame",
                )
            mapped_x, mapped_y = frame.image_to_screen.apply(x, y)
            point = (int(round(mapped_x)), int(round(mapped_y)))
        return self._resolve_screen_point(
            record.receipt,
            point,
            source="compound_point",
            claim=False,
        )

    def _resolve_screen_point(
        self,
        observation,
        point: tuple[int, int],
        *,
        source: str,
        claim: bool,
    ) -> ResolvedTarget:
        hit = self._backend.window_at_point(*point)
        if hit is None:
            raise TargetResolutionError(
                ErrorCode.TARGET_NOT_FOUND,
                "no live window exists under the requested point",
            )
        hwnd, pid = hit
        expected_windows = {window.ref.hwnd: window.ref for window in observation.windows}
        expected = expected_windows.get(hwnd)
        if expected is None:
            raise TargetResolutionError(
                ErrorCode.TARGET_MOVED,
                "the point now lands on a window outside the observed snapshot",
            )
        self._validate_window(expected)
        if expected.owner.pid != pid:
            raise TargetResolutionError(
                ErrorCode.STALE_WINDOW,
                "the window under the point changed owner",
            )
        if claim:
            self._store(self._snapshots.claim_for_mutation,
                observation.snapshot_id,
                self._generations.producer_generation,
            )
        return ResolvedTarget(
            receipt=TargetReceipt(
                target_kind="frame_point",
                description=f"verified screen point ({point[0]},{point[1]})",
                snapshot_id=observation.snapshot_id,
                window_handle=hwnd,
                process_id=pid,
            ),
            screen_point=point,
            source=source,
        )
