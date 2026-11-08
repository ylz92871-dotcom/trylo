from dataclasses import dataclass, field

import pytest

from windows_mcp.runtime.clock import FakeClock
from windows_mcp.runtime.errors import ErrorCode
from windows_mcp.runtime.generation_registry import GenerationRegistry
from windows_mcp.runtime.identity import (
    ElementRef,
    ProcessInstanceRef,
    ReacquireLocator,
    WindowRef,
)
from windows_mcp.runtime.observations import (
    Affine2D,
    CoverageReport,
    ElementCapabilities,
    FrameRef,
    InteractionNode,
    ObservationReceipt,
    ObservationScope,
    Rect,
    WindowObservation,
)
from windows_mcp.runtime.snapshot_store import SnapshotStore
from windows_mcp.runtime.target_resolver import (
    LiveElementCandidate,
    TargetResolutionError,
    TargetResolver,
)


@dataclass
class FakeBackend:
    runtime: list[LiveElementCandidate] = field(default_factory=list)
    locator: list[LiveElementCandidate] = field(default_factory=list)
    query: list[LiveElementCandidate] = field(default_factory=list)
    hit: tuple[int, int] | None = (100, 10)
    calls: list[str] = field(default_factory=list)

    def find_by_runtime_id(self, window, runtime_id):
        self.calls.append("runtime")
        return self.runtime

    def find_by_locator(self, window, locator):
        self.calls.append("locator")
        return self.locator

    def query_by_name(self, window, query):
        self.calls.append("query")
        return self.query

    def window_at_point(self, x, y):
        self.calls.append("hit")
        return self.hit


def _candidate(**overrides) -> LiveElementCandidate:
    values = {
        "runtime_id": (1, 2, 3),
        "control_type": "ButtonControl",
        "automation_id": "save",
        "class_name": "Button",
        "framework_id": "Win32",
        "name": "Save",
        "bounds": Rect(10, 10, 110, 50),
    }
    values.update(overrides)
    return LiveElementCandidate(**values)


def _fixture(*, frame: bool = False):
    owner = ProcessInstanceRef(pid=10, started_at_100ns=500)
    registry = GenerationRegistry(
        producer_generation=2,
        process_start=lambda pid: 500,
        window_owner=lambda hwnd: 10,
        window_exists=lambda hwnd: True,
    )
    generation = registry.observe_window(100, owner)
    window = WindowRef("desktop-a", 2, 100, owner, generation)
    ref = ElementRef(
        element_id="element-1",
        snapshot_id="snapshot-1",
        window=window,
        runtime_id=(1, 2, 3),
        locator=ReacquireLocator(
            control_type="button",
            automation_id="save",
            class_name="Button",
            framework_id="Win32",
            name_hint="Save",
            spatial_hint=(60, 30),
        ),
    )
    node = InteractionNode(
        ref=ref,
        role="button",
        name="Save",
        description=None,
        value=None,
        bounds_screen=Rect(10, 10, 110, 50),
        bounds_frame=Rect(10, 10, 110, 50) if frame else None,
        enabled=True,
        offscreen=False,
        focused=False,
        protected=False,
        states={},
        capabilities=ElementCapabilities(invoke=True),
        provenance=("uia",),
        confidence=1.0,
    )
    frame_ref = None
    if frame:
        transform = Affine2D((1, 0, 100, 0, 1, 200, 0, 0, 1))
        inverse = Affine2D((1, 0, -100, 0, 1, -200, 0, 0, 1))
        frame_ref = FrameRef(
            frame_id="frame-1",
            captured_at_qpc=0,
            status="complete",
            source_scope="region",
            source_window=None,
            desktop_bounds=Rect(0, 0, 1920, 1080),
            client_bounds=None,
            content_rect=Rect(100, 200, 300, 400),
            pixel_width=200,
            pixel_height=200,
            dpi_scale_x=1,
            dpi_scale_y=1,
            image_to_screen=transform,
            screen_to_image=inverse,
            dirty_rects=(),
            backend="test",
        )
    receipt = ObservationReceipt(
        producer_id="actor-1",
        producer_generation=2,
        snapshot_id="snapshot-1",
        revision=1,
        observed_at_qpc=0,
        expires_at_monotonic=100,
        scope=ObservationScope("region" if frame else "exact_window"),
        active_window=window,
        windows=(WindowObservation(window, "Editor", Rect(0, 0, 300, 400), True),),
        elements=(node,),
        frame=frame_ref,
        coverage=CoverageReport(1, 1),
    )
    store = SnapshotStore(clock=FakeClock())
    store.put(receipt, {0: "element-1"})
    backend = FakeBackend(runtime=[_candidate()])
    resolver = TargetResolver(
        snapshots=store,
        generations=registry,
        backend=backend,
        current_desktop_session=lambda: "desktop-a",
    )
    return resolver, backend, store


def test_runtime_id_is_preferred_and_returns_live_center() -> None:
    resolver, backend, _ = _fixture()

    resolved = resolver.resolve_element("snapshot-1", label=0)

    assert resolved.source == "runtime_id"
    assert resolved.screen_point == (60, 30)
    assert resolved.receipt.element_id == "element-1"
    assert backend.calls == ["runtime"]


def test_runtime_miss_uses_unique_composite_locator() -> None:
    resolver, backend, _ = _fixture()
    backend.runtime = []
    backend.locator = [_candidate(runtime_id=(9, 9))]

    resolved = resolver.resolve_element("snapshot-1", element_id="element-1")

    assert resolved.source == "composite_locator"
    assert backend.calls == ["runtime", "locator"]


def test_multiple_locator_candidates_fail_as_ambiguous() -> None:
    resolver, backend, _ = _fixture()
    backend.runtime = []
    backend.locator = [_candidate(), _candidate(bounds=Rect(120, 10, 220, 50))]

    with pytest.raises(TargetResolutionError) as exc_info:
        resolver.resolve_element("snapshot-1", label=0)

    assert exc_info.value.code is ErrorCode.AMBIGUOUS_TARGET


def test_role_automation_id_and_bounds_are_revalidated() -> None:
    resolver, backend, _ = _fixture()
    backend.runtime = [_candidate(automation_id="delete")]
    with pytest.raises(TargetResolutionError) as exc_info:
        resolver.resolve_element("snapshot-1", label=0)
    assert exc_info.value.code is ErrorCode.STALE_ELEMENT

    backend.runtime = [_candidate(bounds=Rect(500, 500, 600, 540))]
    with pytest.raises(TargetResolutionError) as exc_info:
        resolver.resolve_element("snapshot-1", label=0)
    assert exc_info.value.code is ErrorCode.TARGET_MOVED


def test_text_query_requires_one_match_in_fresh_exact_window() -> None:
    resolver, backend, _ = _fixture()
    backend.query = [_candidate(name="Open")]

    resolved = resolver.resolve_query("snapshot-1", "Open")

    assert resolved.source == "fresh_scoped_query"
    assert resolved.screen_point == (60, 30)

    resolver, backend, _ = _fixture()
    backend.query = [_candidate(), _candidate(name="Save as")]
    with pytest.raises(TargetResolutionError) as exc_info:
        resolver.resolve_query("snapshot-1", "Save")
    assert exc_info.value.code is ErrorCode.AMBIGUOUS_TARGET


def test_frame_point_uses_bound_transform_and_verifies_hit_window() -> None:
    resolver, backend, _ = _fixture(frame=True)

    resolved = resolver.resolve_frame_point("snapshot-1", 20, 30)

    assert resolved.screen_point == (120, 230)
    assert resolved.receipt.window_handle == 100

    resolver, backend, _ = _fixture(frame=True)
    backend.hit = (999, 99)
    with pytest.raises(TargetResolutionError) as exc_info:
        resolver.resolve_frame_point("snapshot-1", 20, 30)
    assert exc_info.value.code is ErrorCode.TARGET_MOVED


def test_other_desktop_session_is_rejected_before_element_lookup() -> None:
    resolver, backend, _ = _fixture()
    resolver._current_desktop_session = lambda: "desktop-b"

    with pytest.raises(TargetResolutionError) as exc_info:
        resolver.resolve_element("snapshot-1", label=0)

    assert exc_info.value.code is ErrorCode.STALE_WINDOW
    assert backend.calls == []
