"""§18.3 metrics registry: thread safety, honesty contract, export shape."""

from __future__ import annotations

import io
import json
import threading
import time
from collections import deque
from types import SimpleNamespace

import pytest

from windows_mcp.broker.protocol import BrokerHello, encode
from windows_mcp.broker.supervisor import EventBrokerSupervisor
from windows_mcp.runtime import metrics as metrics_module
from windows_mcp.runtime.metrics import (
    COUNTER_NAMES,
    HISTOGRAM_NAMES,
    SNAPSHOT_SCHEMA_VERSION,
    MetricsRegistry,
    _UNSOURCED_METRICS,
)
from windows_mcp.runtime.results import (
    DispatchStatus,
    EffectStatus,
    TargetReceipt,
    dispatched_unknown_result,
)


@pytest.fixture()
def registry():
    return MetricsRegistry()


def test_snapshot_schema_and_unsourced_declaration(registry):
    snap = registry.snapshot()
    assert snap["schema_version"] == SNAPSHOT_SCHEMA_VERSION
    # All §18.3 unsourced metrics are declared, never counted.
    assert set(snap["unsourced"]) == set(_UNSOURCED_METRICS)
    assert set(_UNSOURCED_METRICS) == {
        "wrong_window_dispatch_count",
        "wrong_element_dispatch_count",
        "unsafe_duplicate_count",
        "full_snapshot_count_per_task",
        "changed_pixels_or_tokens_per_task",
    }
    json.dumps(snap)  # export must be JSON-able


def test_unknown_counter_name_raises(registry):
    with pytest.raises(ValueError):
        registry.inc("made_up_metric")
    with pytest.raises(ValueError):
        registry.observe_ms("made_up_metric", 1.0)


def test_counter_and_rate(registry):
    registry.inc("mutation_total")
    registry.inc("mutation_total")
    registry.inc("mutation_confirmed_success_total")
    counted = registry.snapshot()["counted"]
    rate = counted["confirmed_task_success_rate"]
    assert rate["mutation_total"] == 2
    assert rate["mutation_confirmed_success_total"] == 1
    assert rate["rate"] == 0.5
    assert rate["granularity"] == "mutation"


def test_empty_rate_is_none_not_zero(registry):
    rate = registry.snapshot()["counted"]["confirmed_task_success_rate"]
    assert rate["rate"] is None


def test_histogram_quantiles_exact_buckets(registry):
    registry.observe_ms("verify_prepare_ms", 5.0)
    registry.observe_ms("verify_prepare_ms", 15.0)
    hist = registry.snapshot()["counted"]["verify_prepare_ms"]
    assert hist["count"] == 2
    assert hist["sum_ms"] == 20.0
    assert 5.0 <= hist["p50_ms"] <= 15.0
    assert 10.0 <= hist["p95_ms"] <= 25.0


def test_histogram_empty_is_none(registry):
    hist = registry.snapshot()["counted"]["action_ms"]
    assert hist["count"] == 0
    assert hist["p50_ms"] is None
    assert hist["p95_ms"] is None


def test_histogram_last_bucket_is_lower_edge_not_invented(registry):
    registry.observe_ms("user_takeover_latency_ms", 40000.0)
    hist = registry.snapshot()["counted"]["user_takeover_latency_ms"]
    # Unbounded last bucket: report its lower edge, never an interpolation.
    assert hist["p50_ms"] == 30000.0
    assert hist["p95_ms"] == 30000.0


def test_negative_observation_clamped(registry):
    registry.observe_ms("action_ms", -5.0)
    hist = registry.snapshot()["counted"]["action_ms"]
    assert hist["count"] == 1
    assert hist["sum_ms"] == 0.0


def test_thread_safety_under_concurrency(registry):
    def hammer():
        for _ in range(500):
            registry.inc("unknown_outcome_count")
            registry.observe_ms("verify_observe_ms", 10.0)

    threads = [threading.Thread(target=hammer) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    counted = registry.snapshot()["counted"]
    assert counted["unknown_outcome_count"] == 4000
    assert counted["verify_observe_ms"]["count"] == 4000


def test_reset_for_tests(registry):
    registry.inc("mutation_total")
    registry.observe_ms("action_ms", 3.0)
    registry.reset_for_tests()
    counted = registry.snapshot()["counted"]
    assert counted["confirmed_task_success_rate"]["mutation_total"] == 0
    assert counted["action_ms"]["count"] == 0


def test_dispatched_unknown_result_counts_in_journal_classification():
    """The Desktop journal classifies every ActionResult; unknown outcomes
    must be counted there (the single journal entry point)."""
    receipt = TargetReceipt(target_kind="window", description="d")
    result = dispatched_unknown_result(
        target_receipt=receipt, execution_channel="uia"
    )
    assert result.effect is EffectStatus.UNKNOWN_OUTCOME
    assert result.dispatch is DispatchStatus.ACCEPTED


def test_periodic_export_disabled_on_nonpositive_interval():
    assert metrics_module.start_periodic_export(0) is None
    assert metrics_module.start_periodic_export(-1) is None


def test_fixed_vocabularies_align_with_snapshot_structure():
    assert COUNTER_NAMES == {
        "unknown_outcome_count",
        "stale_target_refusal_count",
        "focus_theft_count",
        "capture_degraded_count",
        "broker_restart_count",
        "resync_required_count",
        "mutation_total",
        "mutation_confirmed_success_total",
    }
    assert HISTOGRAM_NAMES == {
        "user_takeover_latency_ms",
        "observe_ms",
        "action_ms",
        "verify_prepare_ms",
        "verify_observe_ms",
    }


# ── wiring: stale refusals ───────────────────────────────────────────────


def test_stale_target_refusal_counted_at_error_construction(registry, monkeypatch):
    """Every dispatch-front refusal in the stale family passes through
    TargetResolutionError; each construction is one metric sample."""
    from windows_mcp.runtime.errors import ErrorCode
    from windows_mcp.runtime.target_resolver import TargetResolutionError

    monkeypatch.setattr(metrics_module, "METRICS", registry)
    # target_resolver imported METRICS by name at module import; patch there too.
    import windows_mcp.runtime.target_resolver as resolver_module

    monkeypatch.setattr(resolver_module, "METRICS", registry)

    with pytest.raises(TargetResolutionError):
        raise TargetResolutionError(ErrorCode.STALE_WINDOW, "gone")
    with pytest.raises(TargetResolutionError):
        raise TargetResolutionError(ErrorCode.STALE_ELEMENT, "gone")
    with pytest.raises(TargetResolutionError):
        # Non-stale refusal codes are not stale_target samples.
        raise TargetResolutionError(ErrorCode.SECURE_DESKTOP, "no")

    counted = registry.snapshot()["counted"]
    assert counted["stale_target_refusal_count"] == 2


# ── wiring: capture degradation ──────────────────────────────────────────


def test_capture_degraded_counted_on_legacy_frame(monkeypatch):
    import windows_mcp.capture.service as capture_service_module
    from windows_mcp.capture import CaptureService
    from windows_mcp.capture.providers.base import CaptureProvider

    registry = MetricsRegistry()
    monkeypatch.setattr(capture_service_module, "METRICS", registry)

    class DegradedProvider(CaptureProvider):
        backend = "fake_degraded"

        def available(self):
            return True

        def capture_exact_window(self, hwnd, *, max_frames=1, interval_ms=200, deadline_seconds=15.0):
            return _degraded_frame(), "captured"

    def _degraded_frame():
        from windows_mcp.capture.providers.base import CapturedFrame

        return CapturedFrame(
            png_bytes=b"png",
            pixel_width=10,
            pixel_height=10,
            status="degraded",
            backend="legacy:mss",
            window_rect=(0, 0, 10, 10),
            client_size=(10, 10),
            warnings=("legacy capture",),
        )

    service = CaptureService(wgc=DegradedProvider())
    monkeypatch.setenv("WINDOWS_MCP_CAPTURE_WGC", "on")
    ref, outcome = service.capture_exact_window(1234)
    assert outcome == "captured"
    assert ref is not None
    assert registry.snapshot()["counted"]["capture_degraded_count"] == 1

    # A complete frame must NOT count as degraded.
    class CompleteProvider(DegradedProvider):
        backend = "fake_complete"

        def capture_exact_window(self, hwnd, *, max_frames=1, interval_ms=200, deadline_seconds=15.0):
            from windows_mcp.capture.providers.base import CapturedFrame

            return (
                CapturedFrame(
                    png_bytes=b"png",
                    pixel_width=10,
                    pixel_height=10,
                    status="complete",
                    backend="wgc",
                    window_rect=(0, 0, 10, 10),
                    client_size=(10, 10),
                ),
                "captured",
            )

    service2 = CaptureService(wgc=CompleteProvider())
    monkeypatch.setenv("WINDOWS_MCP_CAPTURE_WGC", "on")
    service2.capture_exact_window(1234)
    assert registry.snapshot()["counted"]["capture_degraded_count"] == 1


# ── wiring: verifier timing histograms ───────────────────────────────────


def test_verifier_prepare_and_observe_recorded(monkeypatch):
    import windows_mcp.runtime.verifier as verifier_module
    from windows_mcp.runtime.clock import FakeClock
    from windows_mcp.runtime.predicates import changed
    from windows_mcp.runtime.verifier import PostconditionVerifier

    registry = MetricsRegistry()
    monkeypatch.setattr(verifier_module, "METRICS", registry)
    clock = FakeClock()
    verifier = PostconditionVerifier(
        lambda target: {"toggle_state": 0},
        clock=clock,
        sleeper=clock.advance,
        poll_interval=0.05,
    )
    handle = verifier.prepare(_v2_target(), pre_revision=1)
    verifier.observe_after_dispatch(
        handle, changed("toggle_state"), earliest_qpc=clock.qpc_ns(), timeout_seconds=0.1
    )
    counted = registry.snapshot()["counted"]
    assert counted["verify_prepare_ms"]["count"] == 1
    assert counted["verify_observe_ms"]["count"] == 1
    # FakeClock: prepare took 0 ms; observe spanned the 0.1 s deadline wait.
    assert counted["verify_prepare_ms"]["sum_ms"] == 0.0
    assert counted["verify_observe_ms"]["sum_ms"] == 100.0


def _v2_target():
    from windows_mcp.runtime.results import TargetReceipt
    from windows_mcp.runtime.target_resolver import ResolvedTarget

    return ResolvedTarget(
        receipt=TargetReceipt(target_kind="element", description="t"),
        screen_point=(0, 0),
        source="test",
    )


# ── wiring: broker restart counter ───────────────────────────────────────


class _CrashingProcess:
    """Hello once, then EOF — one dead broker, one restart (see
    test_broker_protocol for the full scripted variant)."""

    def __init__(self, generation: int):
        self._hello = encode(BrokerHello(generation=generation))
        self._served = False
        self._buffer = b""
        self.stdin = io.BytesIO()

    @property
    def stdout(self):
        return self

    def read(self, n: int):
        if not self._served:
            self._served = True
            self._buffer = self._hello
        if not self._buffer:
            return b""
        chunk, self._buffer = self._buffer[:n], self._buffer[n:]
        return chunk

    def write(self, data: bytes) -> int:
        return len(data)

    def flush(self) -> None:
        return

    def close(self) -> None:
        return

    def wait(self, timeout=None) -> int:
        return 1

    def kill(self) -> None:
        return


def test_broker_restart_counted_on_real_restart_path(monkeypatch):
    import windows_mcp.broker.supervisor as supervisor_module

    registry = MetricsRegistry()
    monkeypatch.setattr(supervisor_module, "METRICS", registry)
    supervisor = EventBrokerSupervisor(launcher=lambda _gen: _CrashingProcess(1))
    supervisor.start()
    try:
        deadline = time.monotonic() + 5.0
        while supervisor.restarts < 1 and time.monotonic() < deadline:
            time.sleep(0.02)
        assert supervisor.restarts >= 1
        assert registry.snapshot()["counted"]["broker_restart_count"] >= 1
    finally:
        supervisor.stop()


# ── wiring: Desktop journal classification ───────────────────────────────


def test_desktop_journal_classifies_mutation_effects(monkeypatch):
    import windows_mcp.desktop.service as service_module
    from windows_mcp.runtime.results import (
        VerificationEvidence,
        confirmed_success_result,
        dispatched_unknown_result,
    )

    registry = MetricsRegistry()
    monkeypatch.setattr(service_module, "METRICS", registry)
    journal = SimpleNamespace(_action_results=deque(maxlen=32))
    receipt = TargetReceipt(target_kind="window", description="d")

    def record(result):
        service_module.Desktop.record_action_result(journal, result)

    record(dispatched_unknown_result(target_receipt=receipt, execution_channel="uia"))
    record(
        confirmed_success_result(
            target_receipt=receipt,
            execution_channel="uia",
            dispatch=DispatchStatus.ACCEPTED,
            pre_revision=0,
            post_revision=1,
            verification=VerificationEvidence(
                verifier="v", predicate="p", observed="o"
            ),
        )
    )
    record(
        confirmed_success_result(
            target_receipt=receipt,
            execution_channel="uia",
            dispatch=DispatchStatus.ACCEPTED,
            pre_revision=1,
            post_revision=2,
            verification=VerificationEvidence(
                verifier="v", predicate="p", observed="o"
            ),
        )
    )
    counted = registry.snapshot()["counted"]
    rate = counted["confirmed_task_success_rate"]
    assert rate["mutation_total"] == 3
    assert rate["mutation_confirmed_success_total"] == 2
    assert counted["unknown_outcome_count"] == 1
    assert rate["rate"] == pytest.approx(2 / 3)


# ── wiring: focus theft consumption point ────────────────────────────────


def test_feed_desktop_event_counts_foreground_changes(monkeypatch):
    import windows_mcp.desktop.service as service_module
    from windows_mcp.runtime.verifier import BrokerWakeSource

    registry = MetricsRegistry()
    monkeypatch.setattr(service_module, "METRICS", registry)
    desktop_like = SimpleNamespace(_wake_source=BrokerWakeSource())

    def feed(window_handle, kind, changed_properties=()):
        service_module.Desktop.feed_desktop_event(
            desktop_like, window_handle, kind, changed_properties
        )

    feed(11, "foreground_changed", ())
    feed(11, "focus_changed", ("value",))
    feed(11, "foreground_changed", ())
    feed(11, "property_changed", ("toggle_state",))
    assert registry.snapshot()["counted"]["focus_theft_count"] == 2


# ── file sink: WINDOWS_MCP_METRICS_FILE ──────────────────────────────────


def _read_sink(path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_file_sink_disabled_by_default(monkeypatch, tmp_path):
    monkeypatch.delenv("WINDOWS_MCP_METRICS_FILE", raising=False)
    sink = tmp_path / "metrics.json"
    metrics_module._METRICS_FILE_DEFAULT = sink  # would be written if enabled
    try:
        metrics_module.export_now(MetricsRegistry())
    finally:
        metrics_module._METRICS_FILE_DEFAULT = metrics_module.Path(
            "~/.windows-mcp/metrics.json"
        ).expanduser()
    assert not sink.exists()


def test_file_sink_flag_writes_default_location(monkeypatch, tmp_path):
    sink = tmp_path / "metrics.json"
    monkeypatch.setenv("WINDOWS_MCP_METRICS_FILE", "1")
    monkeypatch.setattr(metrics_module, "_METRICS_FILE_DEFAULT", sink)
    registry = MetricsRegistry()
    registry.inc("stale_target_refusal_count")
    metrics_module.export_now(registry)
    snap = _read_sink(sink)
    assert snap["schema_version"] == SNAPSHOT_SCHEMA_VERSION
    assert snap["counted"]["stale_target_refusal_count"] == 1
    assert "unsourced" in snap


def test_file_sink_explicit_path_and_atomic_replace(monkeypatch, tmp_path):
    sink = tmp_path / "nested" / "dir" / "metrics.json"
    monkeypatch.setenv("WINDOWS_MCP_METRICS_FILE", str(sink))
    registry = MetricsRegistry()
    registry.observe_ms("observe_ms", 12.5)
    metrics_module.export_now(registry)
    assert sink.exists()
    snap = _read_sink(sink)
    assert snap["counted"]["observe_ms"]["count"] == 1
    # No temp litter left behind (os.replace consumed it).
    assert [p.name for p in sink.parent.iterdir()] == ["metrics.json"]
    # Second export overwrites atomically — file stays parseable.
    registry.inc("unknown_outcome_count")
    metrics_module.export_now(registry)
    assert _read_sink(sink)["counted"]["unknown_outcome_count"] == 1


def test_file_sink_failure_never_raises(monkeypatch, tmp_path):
    # A directory in place of the target file makes write_text fail; export
    # must swallow it (metrics never disturb the serving path).
    sink = tmp_path / "metrics.json"
    sink.mkdir()
    monkeypatch.setenv("WINDOWS_MCP_METRICS_FILE", str(sink))
    metrics_module.export_now(MetricsRegistry())  # must not raise


def test_file_sink_empty_value_disables(monkeypatch, tmp_path):
    sink = tmp_path / "metrics.json"
    monkeypatch.setenv("WINDOWS_MCP_METRICS_FILE", "  ")
    monkeypatch.setattr(metrics_module, "_METRICS_FILE_DEFAULT", sink)
    metrics_module.export_now(MetricsRegistry())
    assert not sink.exists()


# ── wiring: observe_ms sampling in Desktop.get_state ─────────────────────


def _stub_desktop_for_get_state(monkeypatch):
    """Build a minimal Desktop-like object so get_state's full body runs
    without UIA/COM: stub the window enumeration + tree stages."""
    import windows_mcp.desktop.service as service_module
    from windows_mcp.desktop.service import Desktop
    from windows_mcp.desktop.views import Status, Window
    from windows_mcp.runtime.clock import SystemClock
    from windows_mcp.tree.views import BoundingBox, TreeState

    registry = MetricsRegistry()
    monkeypatch.setattr(service_module, "METRICS", registry)

    def make_window(name, handle):
        box = BoundingBox(left=0, top=0, right=100, bottom=80, width=100, height=80)
        return Window(
            name=name,
            is_browser=False,
            depth=0,
            status=Status.NORMAL,
            bounding_box=box,
            handle=handle,
            process_id=0,
        )

    desktop = Desktop.__new__(Desktop)
    desktop.encoding = "utf-8"
    desktop.desktop_state = None
    desktop._runtime_clock = SystemClock()
    desktop.get_displays = lambda: []
    desktop._display_to_view = staticmethod(lambda display: display)
    desktop.parse_region_selection = lambda region: None
    desktop.get_display_union_rect = lambda indices, displays=None: None
    desktop._rect_to_bounding_box = lambda rect: None
    desktop.get_controls_handles = lambda: set()
    desktop.get_windows = lambda controls_handles: ([], set())
    desktop.get_active_window = lambda windows: make_window("Stub", 111)
    desktop.get_cursor_location = lambda: (0, 0)
    monkeypatch.setattr(
        service_module, "get_current_desktop",
        lambda: {"id": "0", "name": "Default Desktop"},
    )
    monkeypatch.setattr(
        service_module, "get_all_desktops",
        lambda: [{"id": "0", "name": "Default Desktop"}],
    )
    desktop.tree = SimpleNamespace(
        get_state=lambda *a, **k: TreeState(status=True),
        screen_box=SimpleNamespace(left=0, top=0, right=100, bottom=100),
    )
    return desktop, registry


def test_get_state_records_observe_ms(monkeypatch):
    desktop, registry = _stub_desktop_for_get_state(monkeypatch)
    state = desktop.get_state(publish_state=False)
    assert state.active_window is not None
    hist = registry.snapshot()["counted"]["observe_ms"]
    assert hist["count"] == 1
    assert hist["sum_ms"] >= 0.0


def test_get_state_refresh_via_find_window_also_counts(monkeypatch):
    """observe_ms covers every observation build, including the refresh
    inside _find_window_by_name (the stated granularity, per the sampling
    comment)."""
    desktop, registry = _stub_desktop_for_get_state(monkeypatch)
    found, error = desktop._find_window_by_name("Stub", refresh_state=True)
    assert found is not None and error == ""
    hist = registry.snapshot()["counted"]["observe_ms"]
    assert hist["count"] == 1



def test_snapshot_store_error_counts_as_stale_refusal(monkeypatch):
    """Live matrix batch-1 finding: a claimed/expired snapshot refusal used to
    surface as a raw SnapshotStoreError, bypassing TargetResolutionError's
    §18.3 counting point. The resolver boundary must convert store failures
    so stale_target_refusal_count counts EVERY stale-family refusal."""
    import windows_mcp.runtime.target_resolver as resolver_module
    from windows_mcp.runtime.errors import ErrorCode
    from windows_mcp.runtime.snapshot_store import SnapshotStoreError

    registry = MetricsRegistry()
    monkeypatch.setattr(resolver_module, "METRICS", registry)

    def _boom(*_a, **_k):
        raise SnapshotStoreError(
            ErrorCode.STALE_SNAPSHOT,
            "snapshot is already claimed or superseded by a mutation",
        )

    class _FakeResolver(resolver_module.TargetResolver):
        def __init__(self):  # bypass the normal constructor deps
            self._snapshots = SimpleNamespace(require_fresh=_boom)
            self._generations = None
            self._backend = None
            self._current_desktop_session = lambda: "s"

    fake = _FakeResolver()
    with pytest.raises(resolver_module.TargetResolutionError) as exc_info:
        fake._store(fake._snapshots.require_fresh, "snap-1")
    assert exc_info.value.code is ErrorCode.STALE_SNAPSHOT
    assert registry.snapshot()["counted"]["stale_target_refusal_count"] == 1
