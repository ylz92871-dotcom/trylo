"""EventBroker: a crash-isolated UIA/WinEvent event pump process.

The MCP server must survive native/COM-level failures in the UIA event stack,
so the pump runs in its own process (spec §6.3). The broker:

- subscribes to UIA focus/property/structure events and publishes primitive
  identity frames over a length-prefixed pipe,
- enqueues into a bounded queue; overflow emits ``resync_required`` instead of
  silently dropping,
- never traverses trees, calls patterns, or performs model logic inside a
  callback.

Run with ``python -m windows_mcp.broker`` for the real process. The
``BrokerCore`` class is the testable process body; ``run_broker`` wires it to
``sys.stdin.buffer``/``sys.stdout.buffer``.
"""

from __future__ import annotations

import io
import queue
import sys
import threading
import time
from collections.abc import Callable

from windows_mcp.broker.protocol import (
    DesktopEvent,
    ProtocolError,
    SubscribeRequest,
    decode,
    encode,
    read_frame,
)

# Bounded queue: overflow means the server is not consuming fast enough, so
# the increment stream can no longer be trusted and a resync is required.
QUEUE_LIMIT = 512

# Heartbeat cadence. The supervisor treats ~2 missed heartbeats as a dead pipe.
HEARTBEAT_INTERVAL = 1.0

_KIND_FOCUS = "focus_changed"
_KIND_PROPERTY = "property_changed"
_KIND_STRUCTURE = "structure_changed"

# Property ids monitored by default (same set the legacy watchdog used):
# 30005 Name, 30045 Value, 30093 LegacyIAccessibleValue, 30128 ToggleState.
DEFAULT_PROPERTY_IDS = (30005, 30045, 30093, 30128)


class _SequenceClock:
    """Monotonic per-broker sequence numbering shared across event sources."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._value = 0

    def next(self) -> int:
        with self._lock:
            self._value += 1
            return self._value


def _qpc_now() -> int:
    return time.perf_counter_ns()


def _pump_com_events() -> None:
    """Drain the COM STA message queue so UIA callbacks can fire.

    UIA event handlers are delivered through the subscribing thread's COM
    apartment; without a message pump they never arrive (the watchdog's
    event loop pumps for the same reason). Publishing keeps its own queue
    get() timeout as the loop cadence — the pump runs alongside it. Any
    failure here must not kill the publisher: without pumping the broker
    degrades to heartbeats and the server keeps its polling fallback.
    """
    if not _pump_com_events.enabled:
        return
    try:
        import comtypes.client

        comtypes.client.PumpEvents(0.0)
    except Exception:
        _pump_com_events.enabled = False


# Toggled off in non-COM contexts (tests, fake pumps) so the publisher loop
# never imports comtypes for them.
_pump_com_events.enabled = True


class BrokerCore:
    """The broker process body, testable without spawning a process.

    ``event_pump`` is an injectable callable that registers primitive-only
    callbacks on a real UIA stack; tests inject fakes that emit directly.

    Threading contract: UIA subscriptions and their callbacks live on ONE
    STA — the publisher thread (``_publish_loop``). Server-subscribe requests
    arrive on the stdin thread, which only stashes them; the publisher thread
    picks them up and applies them while pumping COM messages, because a UIA
    subscription made on a thread that never pumps delivers nothing.
    """

    def __init__(
        self,
        generation: int,
        output: io.BufferedWriter,
        *,
        event_pump: Callable[[dict], None] | None = None,
        clock: Callable[[], int] = _qpc_now,
    ) -> None:
        if generation <= 0:
            raise ValueError("broker generation must be positive")
        self._generation = generation
        self._output = output
        self._events: queue.Queue[DesktopEvent] = queue.Queue(maxsize=QUEUE_LIMIT)
        self._sequence = _SequenceClock()
        self._clock = clock
        self._stopped = threading.Event()
        self._overflowed = False
        self._event_pump = event_pump
        self._pending_subscriptions: queue.Queue[SubscribeRequest] = queue.Queue()
        # Applied on the publisher thread; read-only after that thread starts.
        self._event_pump_configured = False

    # ------------------------------------------------------------------ #
    # producer side (called from UIA callback threads inside the broker)  #
    # ------------------------------------------------------------------ #

    def emit(
        self,
        kind: str,
        *,
        window_hwnd: int | None = None,
        window_pid: int | None = None,
        runtime_id: tuple[int, ...] | None = None,
        name_hint: str | None = None,
        changed_properties: tuple[str, ...] = (),
        meta: dict | None = None,
    ) -> bool:
        """Enqueue one normalized event. Returns False when the queue is full
        (the event is dropped and the stream flips to resync-required)."""
        event = DesktopEvent(
            generation=self._generation,
            sequence=self._sequence.next(),
            kind=kind,
            observed_at_qpc=self._clock(),
            window_hwnd=window_hwnd,
            window_pid=window_pid,
            runtime_id=runtime_id,
            name_hint=name_hint,
            changed_properties=changed_properties,
            meta=meta or {},
        )
        try:
            self._events.put_nowait(event)
        except queue.Full:
            self._overflowed = True
            return False
        return True

    # ------------------------------------------------------------------ #
    # consumer side (server → broker commands)                            #
    # ------------------------------------------------------------------ #

    def handle_subscribe(self, request: SubscribeRequest) -> None:
        """Queue a subscription for the publisher thread to apply.

        The real pump re-registers UIA handlers — and must do so on the same
        STA that later pumps the messages, which is the publisher thread.
        Fakes may treat this as an immediate synchronous hook by overriding
        ``_subscriptions_synchronous`` (tests do exactly that)."""
        if getattr(self, "_subscriptions_synchronous", False):
            if self._event_pump is not None:
                self._event_pump(
                    {
                        "window_hwnd": request.window_hwnd,
                        "properties": request.properties or DEFAULT_PROPERTY_IDS,
                        "events": request.events,
                    }
                )
            return
        self._pending_subscriptions.put(request)

    # ------------------------------------------------------------------ #
    # main loops                                                          #
    # ------------------------------------------------------------------ #

    def run(self, stdin: io.BufferedReader) -> None:
        """Serve requests from ``stdin`` until EOF, forwarding events and
        heartbeats to ``output``. Runs until the input pipe closes."""
        self._write(self._hello())
        publisher = threading.Thread(
            target=self._publish_loop, name="broker-publisher", daemon=True
        )
        publisher.start()
        try:
            while not self._stopped.is_set():
                frame = read_frame(stdin.read)
                if frame is None:
                    # Only stop when the pipe is genuinely closed: an empty
                    # read on a live pipe means no request is pending yet.
                    if self._stopped.is_set() or not self._stdin_alive(stdin):
                        break
                    # Subscription and delivery share this STA; without a
                    # message pump UIA callbacks never fire on it.
                    _pump_com_events()
                    time.sleep(0.05)
                    continue
                try:
                    message = decode(frame)
                except ProtocolError:
                    break  # poisoned stream: the supervisor will restart us
                if isinstance(message, SubscribeRequest):
                    self.handle_subscribe(message)
                # heartbeats are server-optional; nothing else is defined yet
        finally:
            self._stopped.set()
            publisher.join(timeout=2.0)

    @staticmethod
    def _stdin_alive(stdin) -> bool:
        """Best-effort liveness probe: tests use BytesIO (always 'open'), the
        real broker uses a pipe whose read side returns b'' only at EOF."""
        probe = getattr(stdin, "closed", None)
        if probe is True:
            return False
        # A real pipe at EOF keeps returning b''; distinguish by attempting a
        # non-blocking peek where available, else stay alive (supervisor
        # terminates us by process teardown anyway).
        return True

    def _hello(self) -> dict:
        from windows_mcp.broker.protocol import BrokerHello

        return BrokerHello(
            generation=self._generation,
            capabilities=("focus", "property", "structure", "winevent"),
        ).to_dict()

    def _publish_loop(self) -> None:
        next_heartbeat = time.monotonic() + HEARTBEAT_INTERVAL
        while not self._stopped.is_set():
            # Apply pending subscriptions on THIS thread: the STA that pumps
            # is the only one whose subscriptions ever deliver.
            while True:
                try:
                    request = self._pending_subscriptions.get_nowait()
                except queue.Empty:
                    break
                if self._event_pump is not None:
                    try:
                        self._event_pump(
                            {
                                "window_hwnd": request.window_hwnd,
                                "properties": request.properties or DEFAULT_PROPERTY_IDS,
                                "events": request.events,
                            }
                        )
                    except Exception:
                        # A broken provider degrades to polling; the broker
                        # itself must survive (supervisor restarts on crash).
                        pass
                    self._event_pump_configured = True
            if self._overflowed:
                self._overflowed = False
                self.emit("resync_required")
            try:
                event = self._events.get(timeout=0.05)
            except queue.Empty:
                if time.monotonic() >= next_heartbeat:
                    self._write_heartbeat()
                    next_heartbeat = time.monotonic() + HEARTBEAT_INTERVAL
                _pump_com_events()
                continue
            self._write(event.to_dict())

    def _write_heartbeat(self) -> None:
        from windows_mcp.broker.protocol import Heartbeat

        self._write(
            Heartbeat(generation=self._generation, sequence=self._sequence.next()).to_dict()
        )

    def _write(self, message: dict) -> None:
        try:
            self._output.write(encode(_to_message(message)))
            self._output.flush()
        except (BrokenPipeError, OSError):
            self._stopped.set()


def _to_message(data: dict):
    from windows_mcp.broker.protocol import (
        BrokerHello,
        DesktopEvent as Event,
        Heartbeat as Beat,
    )

    kind = data["type"]
    if kind == "hello":
        return BrokerHello(
            generation=data["generation"],
            capabilities=tuple(data.get("capabilities", ())),
        )
    if kind == "heartbeat":
        return Beat(generation=data["generation"], sequence=data["sequence"])
    return Event(
        generation=data["generation"],
        sequence=data["sequence"],
        kind=data["kind"],
        observed_at_qpc=data["observed_at_qpc"],
        window_hwnd=data.get("window_hwnd"),
        window_pid=data.get("window_pid"),
        runtime_id=tuple(data["runtime_id"]) if data.get("runtime_id") else None,
        name_hint=data.get("name_hint"),
        changed_properties=tuple(data.get("changed_properties", ())),
        meta=data.get("meta") or {},
    )


def run_broker(stdin: io.BufferedReader, stdout: io.BufferedWriter, generation: int) -> None:
    core = BrokerCore(generation, stdout)
    core.handle_subscribe = _make_subscribing_handler(core)  # type: ignore[method-assign]
    core._event_pump = _uia_pump_adapter(core)
    winevent = _winevent_adapter(core)
    if winevent is not None:
        # Desktop-wide scope from process start; the host thread owns its own
        # message pump, so it does not depend on the publisher's COM STA.
        winevent.apply(None)
        core._winevent_source = winevent  # noqa: SLF001
    _pump_com_events.enabled = True
    try:
        core.run(stdin)
    finally:
        if winevent is not None:
            _stop_winevent_source(core)


def _make_subscribing_handler(core: BrokerCore):
    """Override the instance's handle_subscribe to queue through the method
    it replaces — kept as a thin alias so the real broker path and the
    default queuing implementation cannot diverge."""
    def handle(request: SubscribeRequest) -> None:
        BrokerCore.handle_subscribe(core, request)

    return handle


def _uia_pump_adapter(core: "BrokerCore") -> Callable[[dict], None]:
    """Map a queued subscription config onto the real UIA source. Runs ONLY
    on the publisher thread, which is the apartment that pumps messages."""
    def apply(config: dict) -> None:
        from windows_mcp.broker.uia_subscriptions import UiaEventSource

        source = getattr(core, "_uia_source", None)
        if source is None:
            source = UiaEventSource(core)
            core._uia_source = source  # noqa: SLF001
        source.apply(
            SubscribeRequest(
                window_hwnd=config.get("window_hwnd"),
                properties=tuple(config.get("properties") or ()),
                events=tuple(config.get("events") or ()),
            )
        )

    return apply


def _winevent_adapter(core: "BrokerCore"):
    """Create the HWND-level WinEvent source (foreground/window moved).

    Returns None when the module or hook installation fails outright: the
    broker then simply has no WinEvent stream and every consumer keeps its
    polling fallback (spec §6.3 fail-open rule). Never raises.
    """
    try:
        from windows_mcp.broker.winevent import WinEventSource

        return WinEventSource(core)
    except Exception:
        return None


def _stop_winevent_source(core: "BrokerCore") -> None:
    source = getattr(core, "_winevent_source", None)
    if source is not None:
        try:
            source.stop()
        except Exception:
            pass


def main() -> int:
    generation = 1
    if len(sys.argv) > 1:
        generation = max(1, int(sys.argv[1]))
    run_broker(sys.stdin.buffer, sys.stdout.buffer, generation)
    return 0


if __name__ == "__main__":
    sys.exit(main())
