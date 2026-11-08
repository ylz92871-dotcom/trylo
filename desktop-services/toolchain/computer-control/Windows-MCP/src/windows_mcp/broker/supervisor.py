"""Server-side EventBroker supervisor.

Owns the broker child process lifecycle: spawn, handshake, heartbeat
monitoring, exponential-backoff restart, and generation bumping. A broker
crash must never take the MCP server down — the supervisor degrades to
"no incremental events", consumers keep their polling fallback, and every
identity leased from a dead broker generation is invalidated.
"""

from __future__ import annotations

import logging
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass

from windows_mcp.broker.protocol import (
    DEFAULT_PROPERTY_IDS,
    BrokerHello,
    DesktopEvent,
    Heartbeat,
    Message,
    ProtocolError,
    SubscribeRequest,
    decode,
    encode,
    read_frame,
)
from windows_mcp.runtime.metrics import METRICS

logger = logging.getLogger(__name__)

# A broker that dies within this window is treated as a broken environment:
# backoff keeps growing instead of hot-restarting (mirrors watchdog policy).
HEALTHY_RUN_SECONDS = 60.0
INITIAL_BACKOFF = 0.5
MAX_BACKOFF = 15.0

# Heartbeats arrive every ~1s; two missed heartbeats means the pipe is dead.
HEARTBEAT_TIMEOUT = 2.5

_HANDSHAKE_TIMEOUT = 10.0


@dataclass(slots=True)
class BrokerState:
    generation: int
    restarts: int


class EventBrokerSupervisor:
    """Manage one broker child process and expose its normalized event stream.

    The real supervisor spawns ``python -m windows_mcp.broker``; tests inject
    ``launcher``/``reader`` fakes. ``events()`` yields decoded messages from
    the *current* generation only; late events from an older generation are
    dropped here so consumers never see them.
    """

    def __init__(
        self,
        *,
        launcher: Callable[[int], subprocess.Popen] | None = None,
        on_generation_retired: Callable[[int], None] | None = None,
    ) -> None:
        self._launcher = launcher or _default_launcher
        self._on_generation_retired = on_generation_retired
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._process: subprocess.Popen | None = None
        self._hello: BrokerHello | None = None
        self._generation = 0
        self._restarts = 0
        self._latest_events: list[DesktopEvent] = []
        self._resync_required = threading.Event()

    # ------------------------------------------------------------------ #
    # lifecycle                                                           #
    # ------------------------------------------------------------------ #

    def start(self) -> BrokerHello:
        """Spawn the first broker and wait for its hello."""
        hello = self._spawn_and_handshake()
        self._thread = threading.Thread(
            target=self._monitor_loop, name="event-broker-supervisor", daemon=True
        )
        self._thread.start()
        return hello

    def stop(self) -> None:
        self._stop.set()
        self._terminate_process()
        if self._thread is not None:
            self._thread.join(timeout=5.0)

    @property
    def generation(self) -> int:
        return self._generation

    @property
    def restarts(self) -> int:
        return self._restarts

    @property
    def resync_required(self) -> bool:
        """True while the increment stream has a gap; consumers must poll."""
        return self._resync_required.is_set()

    def subscribe(self, request: SubscribeRequest) -> None:
        """Best-effort subscription forward; failures degrade to polling."""
        process = self._process
        if process is None or process.stdin is None:
            return
        try:
            process.stdin.write(encode(request))
            process.stdin.flush()
        except (BrokenPipeError, OSError):
            logger.warning("broker subscription failed; relying on polling")

    def subscribe_default(self) -> None:
        """(Re)send the default property subscription to the current broker."""
        self.subscribe(SubscribeRequest(properties=DEFAULT_PROPERTY_IDS))

    def events(self) -> tuple[DesktopEvent, ...]:
        """Snapshot of events drained since the last call (current gen only)."""
        with self._lock:
            drained = tuple(self._latest_events)
            self._latest_events = []
        return drained

    # ------------------------------------------------------------------ #
    # internals                                                           #
    # ------------------------------------------------------------------ #

    def _spawn_and_handshake(self) -> BrokerHello:
        process = self._launcher(self._generation + 1)
        self._process = process
        hello = self._read_hello(process)
        with self._lock:
            self._generation = hello.generation
            self._hello = hello
        # Arm the default event stream right after the handshake. Without
        # this the broker would idle on heartbeats only — every consumer
        # (WaitFor, verifier) silently degraded to polling despite the
        # broker being alive. Property/name-only scope: no per-window
        # subscribe yet, wake-source scoping happens server-side.
        self.subscribe(
            SubscribeRequest(properties=DEFAULT_PROPERTY_IDS)
        )
        return hello

    @staticmethod
    def _read_hello(process: subprocess.Popen) -> BrokerHello:
        stdout = process.stdout
        if stdout is None:
            raise RuntimeError("broker process has no stdout pipe")
        deadline = time.monotonic() + _HANDSHAKE_TIMEOUT
        while time.monotonic() < deadline:
            frame = read_frame(stdout.read)
            if frame is None:
                raise RuntimeError("broker exited before hello")
            try:
                message = decode(frame)
            except ProtocolError as exc:
                raise RuntimeError(f"broker sent an invalid hello: {exc}") from exc
            if isinstance(message, BrokerHello):
                if message.protocol_version != 1:
                    raise RuntimeError("broker protocol version mismatch")
                return message
        raise TimeoutError("broker handshake timed out")

    def _monitor_loop(self) -> None:
        backoff = INITIAL_BACKOFF
        while not self._stop.is_set():
            process = self._process
            if process is None:
                break
            run_started = time.monotonic()
            try:
                self._read_events_until_exit(process)
            except (ProtocolError, OSError, ValueError) as exc:
                logger.warning("event broker stream failed: %s", exc)
            dead = self._reap_process()
            if self._stop.is_set():
                break
            # Whatever this generation proved is now untrusted.
            self._retire_generation()
            if time.monotonic() - run_started < HEALTHY_RUN_SECONDS:
                backoff = min(backoff * 2, MAX_BACKOFF)
            else:
                backoff = INITIAL_BACKOFF
            if dead:
                self._restarts += 1
                try:
                    METRICS.inc("broker_restart_count")
                except Exception:
                    pass
                logger.warning(
                    "event broker exited; restarting (restarts=%d, backoff=%.1fs)",
                    self._restarts,
                    backoff,
                )
                self._stop.wait(backoff)
                if self._stop.is_set():
                    break
                try:
                    self._spawn_and_handshake()
                except (RuntimeError, TimeoutError, OSError) as exc:
                    logger.error("event broker restart failed: %s", exc)
                    backoff = min(backoff * 2, MAX_BACKOFF)
                    self._stop.wait(backoff)
                    continue
            else:
                break

    def _read_events_until_exit(self, process: subprocess.Popen) -> None:
        stdout = process.stdout
        if stdout is None:
            return
        while not self._stop.is_set():
            frame = read_frame(stdout.read)
            if frame is None:
                return
            message = decode(frame)
            if isinstance(message, Heartbeat):
                if message.generation != self._generation:
                    return  # stale stream from a retired broker
                continue
            if isinstance(message, DesktopEvent):
                if message.generation != self._generation:
                    # Late event from a dead generation: a wake-up from it
                    # could alias a current element; discard unconditionally.
                    continue
                if message.kind == "resync_required":
                    self._mark_resync_required()
                with self._lock:
                    self._latest_events.append(message)

    def _reap_process(self) -> bool:
        process = self._process
        if process is None:
            return False
        try:
            code = process.wait(timeout=HEARTBEAT_TIMEOUT)
        except subprocess.TimeoutExpired:
            self._terminate_process()
            return True
        self._process = None
        return code != 0

    def _mark_resync_required(self) -> None:
        """Flag the stream gap and export it through §18.3: the flag is
        supervisor-internal state, so the metrics counter (external file-sink
        readback) is the only outside observation channel for it."""
        was_set = self._resync_required.is_set()
        self._resync_required.set()
        if not was_set:
            try:
                METRICS.inc("resync_required_count")
            except Exception:
                pass

    def _retire_generation(self) -> None:
        with self._lock:
            self._latest_events.clear()
        self._mark_resync_required()
        callback = self._on_generation_retired
        if callback is not None:
            callback(self._generation)

    def _terminate_process(self) -> None:
        process = self._process
        if process is None:
            return
        try:
            if process.stdin is not None:
                process.stdin.close()
        except OSError:
            pass
        try:
            process.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            process.kill()
            try:
                process.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                pass
        self._process = None


def _default_launcher(generation: int) -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, "-m", "windows_mcp.broker", str(generation + 1)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def drain_frames(reader: Iterator[bytes]) -> list[Message]:
    """Helper for tests/tools that already hold decoded frames."""
    return [decode(frame) for frame in reader]
