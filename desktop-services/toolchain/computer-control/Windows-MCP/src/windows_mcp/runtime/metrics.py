"""Process-local metrics registry for the §18.3 observability contract.

Two hard design rules, both from the WCC execution plan:

1. **No network.** Metrics are in-process counters/histograms with a
   snapshot export; nothing here touches PostHog or any other reporter, and
   ``ANONYMIZED_TELEMETRY=false`` changes nothing about this module (the
   Trylo packaging layout ships with telemetry off — a PostHog-coupled
   metrics path would be silently empty).

2. **Honesty over coverage.** Every metric in ``snapshot()`` is either
   ``counted`` (a real in-process measurement) or listed under ``unsourced``
   (§18.3 asks for it but no fork-internal truth exists — e.g. wrong-window
   dispatch needs the host's intent to compare against). Nothing is
   estimated, extrapolated, or synthesised.

The registry is a single module-level instance because it is written from
several threads (broker supervisor, capture, verifier, actor, tool threads);
one lock covers both counters and histograms. Only fixed metric names are
accepted — an unknown name raises so typos surface in tests instead of
silently producing an empty metric.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger(__name__)

SNAPSHOT_SCHEMA_VERSION = 1

#: Default file-sink location — the config directory itself, not a network
#: endpoint. The matrix driver and the host read §18.3 counters by polling
#: this file because the registry lives inside the server subprocess.
_METRICS_FILE_DEFAULT = Path.home() / ".windows-mcp" / "metrics.json"


def _metrics_file_path() -> Path | None:
    """Resolve the env-gated file sink target, or ``None`` when disabled.

    ``WINDOWS_MCP_METRICS_FILE`` accepts:

    - unset/empty → sink disabled (logging export remains the only channel);
    - ``1``/``true``/``on``/``yes``/``enabled`` → ``~/.windows-mcp/metrics.json``
      (resolved here instead of importing ``CONFIG_DIR`` to keep this module
      stdlib-only — see the cycle-free note on ``METRICS``);
    - any other non-empty value → used verbatim as the target file path
      (tests and the matrix driver redirect it to a scratch location).

    Local file only, regardless of value: this is never a network endpoint.
    """
    raw = os.getenv("WINDOWS_MCP_METRICS_FILE")
    if raw is None or not raw.strip():
        return None
    value = raw.strip()
    if value.lower() in {"1", "true", "on", "yes", "enabled"}:
        return _METRICS_FILE_DEFAULT
    return Path(value)

#: Counter names — the fixed vocabulary of ``inc``.
COUNTER_NAMES = frozenset(
    {
        "unknown_outcome_count",
        "stale_target_refusal_count",
        "focus_theft_count",
        "capture_degraded_count",
        "broker_restart_count",
        # Event-stream gap signal (supervisor-internal flag): counted on the
        # set transition so the external file sink can observe stream health
        # without a handle into the supervisor object.
        "resync_required_count",
        # confirmed_task_success_rate, v1 mutation-granularity proxy:
        # "task" does not exist inside the fork, so the honest unit is the
        # mutation and task-level aggregation belongs to the host.
        "mutation_total",
        "mutation_confirmed_success_total",
    }
)

#: Histogram names — the fixed vocabulary of ``observe_ms``.
HISTOGRAM_NAMES = frozenset(
    {
        "user_takeover_latency_ms",
        "observe_ms",
        "action_ms",
        "verify_prepare_ms",
        "verify_observe_ms",
    }
)

#: Upper bounds of histogram buckets in ms; the final bucket is unbounded.
_BUCKET_UPPER_EDGES_MS = (1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000)

#: §18.3 metrics the fork cannot measure itself. Declared — never faked.
_UNSOURCED_METRICS: dict[str, str] = {
    "wrong_window_dispatch_count": (
        "requires the host's intended-window truth to compare against the "
        "dispatched receipt; host-collected (foreground digest reconciliation)"
    ),
    "wrong_element_dispatch_count": (
        "requires the host's intended-element truth; the fork only knows what "
        "it resolved"
    ),
    "unsafe_duplicate_count": (
        "non-idempotent repeat semantics live in the task/intent layer; the "
        "fork cannot self-certify a duplicate as unsafe"
    ),
    "full_snapshot_count_per_task": (
        "'task' is not a fork concept; host aggregates per task"
    ),
    "changed_pixels_or_tokens_per_task": (
        "needs a task-level baseline to diff against; host-collected"
    ),
}


class MetricsRegistry:
    """Thread-safe counter + bucketed-histogram store with a snapshot export."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counters: dict[str, int] = {name: 0 for name in COUNTER_NAMES}
        self._histograms: dict[str, _Histogram] = {
            name: _Histogram() for name in HISTOGRAM_NAMES
        }

    # -- writes ----------------------------------------------------------

    def inc(self, name: str) -> None:
        if name not in COUNTER_NAMES:
            raise ValueError(f"unknown metrics counter: {name!r}")
        with self._lock:
            self._counters[name] += 1

    def observe_ms(self, name: str, value_ms: float) -> None:
        if name not in HISTOGRAM_NAMES:
            raise ValueError(f"unknown metrics histogram: {name!r}")
        with self._lock:
            self._histograms[name].observe(value_ms)

    # -- reads -----------------------------------------------------------

    def snapshot(self) -> dict[str, Any]:
        """JSON-able §18.3 snapshot: ``counted`` + ``unsourced`` declaration."""
        with self._lock:
            counters = dict(self._counters)
            histograms = {name: h.snapshot() for name, h in self._histograms.items()}
        mutation_total = counters["mutation_total"]
        confirmed = counters["mutation_confirmed_success_total"]
        return {
            "schema_version": SNAPSHOT_SCHEMA_VERSION,
            "counted": {
                "unknown_outcome_count": counters["unknown_outcome_count"],
                "stale_target_refusal_count": counters["stale_target_refusal_count"],
                "focus_theft_count": counters["focus_theft_count"],
                "capture_degraded_count": counters["capture_degraded_count"],
                "broker_restart_count": counters["broker_restart_count"],
                "resync_required_count": counters["resync_required_count"],
                "confirmed_task_success_rate": {
                    # v1 honest downgrade (execution plan §2.A): mutation
                    # granularity inside the fork; task-level aggregation is
                    # the host's job.
                    "granularity": "mutation",
                    "mutation_total": mutation_total,
                    "mutation_confirmed_success_total": confirmed,
                    "rate": (confirmed / mutation_total) if mutation_total else None,
                },
                "user_takeover_latency_ms": histograms["user_takeover_latency_ms"],
                "observe_ms": histograms["observe_ms"],
                "action_ms": histograms["action_ms"],
                "verify_prepare_ms": histograms["verify_prepare_ms"],
                "verify_observe_ms": histograms["verify_observe_ms"],
            },
            "unsourced": dict(_UNSOURCED_METRICS),
        }

    def reset_for_tests(self) -> None:
        with self._lock:
            for name in self._counters:
                self._counters[name] = 0
            for histogram in self._histograms.values():
                histogram.reset()


class _Histogram:
    """Cumulative bucketed latency histogram (ms).

    Buckets keep exact totals for every sample ever observed; quantiles are
    interpolated within the covering bucket (the unbounded last bucket
    reports its lower edge — coarse, never invented).
    """

    def __init__(self) -> None:
        self._edges = _BUCKET_UPPER_EDGES_MS
        self._counts = [0] * (len(self._edges) + 1)
        self._total = 0
        self._sum = 0.0

    def observe(self, value_ms: float) -> None:
        if value_ms < 0:
            value_ms = 0.0
        self._total += 1
        self._sum += value_ms
        for index, edge in enumerate(self._edges):
            if value_ms <= edge:
                self._counts[index] += 1
                return
        self._counts[-1] += 1

    def snapshot(self) -> dict[str, Any]:
        return {
            "count": self._total,
            "sum_ms": round(self._sum, 3),
            "p50_ms": self._quantile(0.50),
            "p95_ms": self._quantile(0.95),
        }

    def reset(self) -> None:
        self._counts = [0] * (len(self._edges) + 1)
        self._total = 0
        self._sum = 0.0

    def _quantile(self, q: float) -> float | None:
        if self._total == 0:
            return None
        target = q * self._total
        cumulative = 0.0
        lower = 0.0
        for index, count in enumerate(self._counts):
            upper = self._edges[index] if index < len(self._edges) else None
            if cumulative + count >= target:
                if count == 0:
                    return float(upper) if upper is not None else lower
                position = (target - cumulative) / count
                if upper is None:
                    # Unbounded last bucket: report its lower edge rather
                    # than inventing an interpolation width.
                    return lower
                return lower + position * (upper - lower)
            cumulative += count
            lower = float(upper) if upper is not None else lower
        return None


#: Process-wide registry. Import sites must stay cycle-free: this module
#: depends only on the stdlib.
METRICS = MetricsRegistry()


def export_now(registry: MetricsRegistry = METRICS) -> None:
    """Emit one snapshot through the logging channel (stderr; never stdout,
    which carries the stdio MCP protocol) and, when ``WINDOWS_MCP_METRICS_FILE``
    is set, through the atomic local-file sink.

    File-sink failures are swallowed (debug log only): metrics must never
    disturb the serving path, and the logging line still goes out.
    """
    snapshot = registry.snapshot()
    logger.info("windows-mcp metrics snapshot: %s", json.dumps(snapshot, sort_keys=True))
    _write_metrics_file(snapshot)


def _write_metrics_file(snapshot: dict[str, Any]) -> None:
    """Atomic write of ``snapshot`` JSON to the configured local file.

    ``os.replace`` over a temp file in the same directory so a reader never
    sees a half-written JSON document.
    """
    path = _metrics_file_path()
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(snapshot, sort_keys=True), encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        logger.debug("metrics file sink failed for %s", path, exc_info=True)


def start_periodic_export(
    interval_seconds: float,
    *,
    registry: MetricsRegistry = METRICS,
    clock_wait: Callable[[float], bool] | None = None,
) -> threading.Event | None:
    """Start the periodic snapshot logger; returns the stop event (or None
    for a non-positive interval). Daemon thread — shutdown is a plain
    ``stop_periodic_export`` plus one final ``export_now``."""
    if interval_seconds <= 0:
        return None
    stop = threading.Event()

    def _loop() -> None:
        wait = clock_wait if clock_wait is not None else stop.wait
        while not wait(interval_seconds):
            try:
                export_now(registry)
            except Exception:
                logger.debug("metrics export failed", exc_info=True)

    threading.Thread(
        target=_loop, name="metrics-export", daemon=True
    ).start()
    return stop


def stop_periodic_export(stop: threading.Event | None) -> None:
    if stop is not None:
        stop.set()
