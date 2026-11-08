"""WCC-P1-05: EventBroker protocol, supervisor, and failure isolation.

The broker exists so a native/COM-level UIA event failure cannot kill the MCP
server (spec §6.3). These tests pin the contract end to end:

- protocol: versioned, bounded, primitive-only frames; garbage is a protocol
  error, never a silent truncation;
- broker core: bounded queue, overflow flips the stream to ``resync_required``,
  hello/heartbeat/subscribe lifecycle;
- supervisor: handshake, generation bump on restart, late/old-generation event
  discard, restart after a crash, server-side liveness;
- wake sources: verifier wake-up with polling reconciliation fallback.
"""

import io
import threading
import time

import pytest

from windows_mcp.broker import (
    BrokerHello,
    DesktopEvent,
    EventBrokerSupervisor,
    Heartbeat,
    ProtocolError,
    decode,
    encode,
)
from windows_mcp.broker.__main__ import BrokerCore
from windows_mcp.broker.protocol import read_frame
from windows_mcp.broker.supervisor import HEARTBEAT_TIMEOUT
from windows_mcp.runtime.verifier import (
    BrokerWakeSource,
    PostconditionVerifier,
    PollingWakeSource,
)
from windows_mcp.runtime.results import TargetReceipt
from windows_mcp.runtime.target_resolver import ResolvedTarget


# --------------------------------------------------------------------- #
# protocol                                                              #
# --------------------------------------------------------------------- #


def test_frame_round_trip_preserves_all_identity_fields() -> None:
    event = DesktopEvent(
        generation=3,
        sequence=9,
        kind="property_changed",
        observed_at_qpc=12345,
        window_hwnd=42,
        window_pid=4242,
        runtime_id=(7, 1, 0),
        name_hint="OK",
        changed_properties=("ToggleState",),
        meta={"provider": "test"},
    )
    decoded = decode(encode(event)[4:])
    assert isinstance(decoded, DesktopEvent)
    assert decoded.event_id == "evt_3_9"
    assert decoded.generation == 3
    assert decoded.window_hwnd == 42
    assert decoded.runtime_id == (7, 1, 0)
    assert decoded.changed_properties == ("ToggleState",)


def test_oversized_frame_is_rejected() -> None:
    from windows_mcp.broker.protocol import MAX_FRAME_BYTES

    with pytest.raises(ValueError):
        encode(
            DesktopEvent(
                generation=1,
                sequence=1,
                kind="focus_changed",
                observed_at_qpc=0,
                meta={"blob": "x" * (MAX_FRAME_BYTES + 1)},
            )
        )


def test_garbage_frame_raises_protocol_error() -> None:
    with pytest.raises(ProtocolError):
        decode(b"not json at all")
    with pytest.raises(ProtocolError):
        decode(b'{"type": "unknown_kind"}')
    with pytest.raises(ProtocolError):
        decode(b'{"type": "event", "kind": "made_up_kind", "generation": 1, "sequence": 0, "observed_at_qpc": 0}')


def test_read_frame_detects_mid_frame_eof() -> None:
    payload = encode(
        DesktopEvent(generation=1, sequence=1, kind="focus_changed", observed_at_qpc=0)
    )
    # Cut the payload short: header promises more bytes than remain in the
    # stream, so a well-formed reader must raise instead of returning a
    # truncated frame.
    torn = payload[:-1]
    state = {"pos": 0}

    def stream_reader(n: int) -> bytes:
        chunk = torn[state["pos"] : state["pos"] + n]
        state["pos"] += len(chunk)
        return chunk

    with pytest.raises(ProtocolError):
        read_frame(stream_reader)


# --------------------------------------------------------------------- #
# broker core                                                           #
# --------------------------------------------------------------------- #


class _FakePump:
    def __init__(self) -> None:
        self.configs: list[dict] = []

    def __call__(self, config: dict) -> None:
        self.configs.append(config)


def _pair() -> tuple[BrokerCore, io.BytesIO]:
    out = io.BytesIO()
    return BrokerCore(7, out), out


def test_broker_hello_and_events_are_published_in_order() -> None:
    core, out = _pair()
    # read() on BytesIO returns fewer bytes at EOF, which read_frame treats
    # as a frame boundary only when the header is torn; run() loops on it.
    stdin = io.BytesIO()
    stdin_read = stdin.read
    stdin.read = lambda n: stdin_read(n) if stdin.tell() < len(stdin.getvalue()) else None  # type: ignore[method-assign]

    def run() -> None:
        core.run(stdin)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    try:
        core.emit("focus_changed", runtime_id=(1, 2, 3))
        core.emit("property_changed", changed_properties=("Value",))
        deadline = time.monotonic() + 2.0
        frames: list = []
        while time.monotonic() < deadline:
            with out.getbuffer() as buffer:
                data = bytes(buffer)
            frames = _split_frames(data)
            if len(frames) >= 3:  # hello + 2 events
                break
            time.sleep(0.01)
        messages = [decode(frame) for frame in frames]
        assert messages[0] == BrokerHello(generation=7, capabilities=("focus", "property", "structure", "winevent"))
        kinds = [m.kind for m in messages[1:] if isinstance(m, DesktopEvent)]
        assert kinds == ["focus_changed", "property_changed"]
    finally:
        core._stopped.set()
        thread.join(timeout=2.0)


def test_broker_overflow_emits_resync_required() -> None:
    core, out = _pair()
    # Saturate the bounded queue.
    emitted = 0
    while core.emit("focus_changed"):
        emitted += 1
    assert emitted == 512  # QUEUE_LIMIT
    assert core.emit("focus_changed") is False  # overflow drops and flags

    # Drive one publish pass manually: overflow flag must convert into a
    # resync_required event ahead of the queued backlog.
    core._overflowed = True
    stdin = io.BytesIO()
    thread = threading.Thread(target=lambda: core.run(stdin), daemon=True)
    thread.start()
    deadline = time.monotonic() + 2.0
    frames: list = []
    while time.monotonic() < deadline:
        with out.getbuffer() as buffer:
            data = bytes(buffer)
        frames = _split_frames(data)
        if any(b"resync_required" in frame for frame in frames):
            break
        time.sleep(0.01)
    core._stopped.set()
    thread.join(timeout=2.0)
    kinds = [decode(frame).kind for frame in frames if decode(frame).__class__.__name__ == "DesktopEvent"]
    assert "resync_required" in kinds


def test_broker_heartbeat_periodically_marks_liveness() -> None:
    core, out = _pair()
    stdin = io.BytesIO()
    thread = threading.Thread(target=lambda: core.run(stdin), daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 3.0
        frames: list = []
        while time.monotonic() < deadline:
            with out.getbuffer() as buffer:
                frames = _split_frames(bytes(buffer))
            if any(decode(frame).__class__ is Heartbeat for frame in frames):
                break
            time.sleep(0.02)
        assert any(decode(frame).__class__ is Heartbeat for frame in frames), (
            "broker must emit heartbeats within ~2s even without events"
        )
    finally:
        core._stopped.set()
        thread.join(timeout=2.0)


def _split_frames(data: bytes) -> list[bytes]:
    import struct

    frames = []
    offset = 0
    while offset + 4 <= len(data):
        (length,) = struct.unpack_from("<I", data, offset)
        if offset + 4 + length > len(data):
            break
        frames.append(data[offset + 4 : offset + 4 + length])
        offset += 4 + length
    return frames


# --------------------------------------------------------------------- #
# supervisor                                                            #
# --------------------------------------------------------------------- #


class FakeBrokerProcess:
    """Scriptable broker subprocess double.

    ``script`` is a list of callables receiving the fake; each may emit
    frames by writing to ``out``. Returning from all callables ends the
    stream (EOF), which the supervisor treats as a crash.
    """

    def __init__(self, script, out: io.BytesIO):
        self.script = list(script)
        self.out = out
        self.stdin = io.BytesIO()
        self.killed = False
        self._position = 0

    @property
    def stdout(self):
        return self

    def read(self, n: int):
        if self._position >= len(self.script):
            return None  # EOF -> process exit
        step = self.script[self._position]
        self._position += 1
        step(self)
        return self._serve()

    def _serve(self):
        # Serve whatever the script wrote.
        data = self.out.getvalue()
        self.out.seek(0)
        self.out.truncate()
        return data if data else None

    def write(self, data: bytes) -> int:
        self.stdin.write(data)
        return len(data)

    def flush(self) -> None:
        return

    def close(self) -> None:
        return

    def wait(self, timeout=None) -> int:
        time.sleep(HEARTBEAT_TIMEOUT + 0.1)
        return 1

    def kill(self) -> None:
        self.killed = True


def test_supervisor_drops_late_events_from_old_generation() -> None:
    """A late event with a retired generation must never reach consumers."""
    old = DesktopEvent(generation=1, sequence=1, kind="focus_changed", observed_at_qpc=0)
    fresh = DesktopEvent(generation=2, sequence=2, kind="focus_changed", observed_at_qpc=1)
    stale_heartbeat = Heartbeat(generation=1, sequence=3)
    hello = BrokerHello(generation=2)

    out = io.BytesIO()
    for message in (old, stale_heartbeat, hello, fresh):
        out.write(encode(message))
    payload = out.getvalue()

    supervisor = EventBrokerSupervisor.__new__(EventBrokerSupervisor)
    supervisor._launcher = None
    supervisor._on_generation_retired = None
    supervisor._lock = threading.Lock()
    supervisor._stop = threading.Event()
    supervisor._thread = None
    supervisor._process = None
    supervisor._hello = None
    supervisor._generation = 2
    supervisor._restarts = 0
    supervisor._latest_events = []
    supervisor._resync_required = threading.Event()

    # Feed the monitor read path directly: old-generation frames are skipped.
    stream = io.BytesIO(payload)
    while True:
        frame = read_frame(stream.read)
        if frame is None:
            break
        message = decode(frame)
        if isinstance(message, Heartbeat):
            if message.generation != supervisor._generation:
                continue
            continue
        if isinstance(message, DesktopEvent):
            if message.generation != supervisor._generation:
                continue
            with supervisor._lock:
                supervisor._latest_events.append(message)

    drained = supervisor.events()
    assert list(drained) == [fresh]
    assert drained[0].generation == 2


def test_supervisor_restarts_crashed_broker_and_bumps_generation() -> None:
    """A broker that dies after its hello must be restarted with generation+1
    and old identity retired; the supervisor itself must stay alive."""
    generations = iter([1, 2])

    class ScriptedProcess:
        """Serves the hello frame on the first read; afterwards the stream
        either stays open (healthy) or EOFs immediately (crashed).

        ``stdout`` honors exact byte-stream semantics: every ``read(n)``
        returns at most *n* bytes, like a real pipe.
        """

        def __init__(self, generation: int, crash_after_hello: bool):
            self.generation = generation
            self._hello = encode(BrokerHello(generation=generation))
            self._crash_after_hello = crash_after_hello
            self._buffer = b""
            self._hello_served = False
            self.stdin = io.BytesIO()
            self.killed = False

        @property
        def stdout(self):
            return self

        def read(self, n: int):
            if not self._hello_served:
                self._hello_served = True
                self._buffer = self._hello
            if not self._buffer:
                if self._crash_after_hello:
                    return b""
                time.sleep(0.01)
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
            self.killed = True

    made: list[ScriptedProcess] = []

    def launcher(_generation: int) -> ScriptedProcess:
        process = ScriptedProcess(next(generations), crash_after_hello=len(made) == 0)
        made.append(process)
        return process

    supervisor = EventBrokerSupervisor(launcher=launcher)
    supervisor.start()
    try:
        # restarts is incremented before the respawn handshake completes, so
        # wait for the generation bump that only the new hello can deliver.
        deadline = time.monotonic() + 5.0
        while supervisor.generation < 2 and time.monotonic() < deadline:
            time.sleep(0.02)
        assert supervisor.restarts >= 1, "crashed broker must be restarted"
        assert supervisor.generation == 2, "generation must bump across restarts"
        assert len(made) == 2
    finally:
        supervisor.stop()


def test_supervisor_survives_when_broker_dies_mid_stream() -> None:
    """server survives: stream EOF after events must flip resync and keep the
    supervisor thread running (the restart loop), not raise."""

    class EofProcess:
        """Serves hello + one event, then EOFs (honoring exact read sizes)."""

        def __init__(self, generation: int):
            self.generation = generation
            stream = io.BytesIO()
            stream.write(encode(BrokerHello(generation=generation)))
            stream.write(
                encode(
                    DesktopEvent(
                        generation=generation,
                        sequence=1,
                        kind="focus_changed",
                        observed_at_qpc=0,
                    )
                )
            )
            self._buffer = stream.getvalue()
            self.stdin = io.BytesIO()
            self.killed = False
            self._eof_pause_served = False

        @property
        def stdout(self):
            return self

        def read(self, n: int):
            if self._buffer:
                chunk, self._buffer = self._buffer[:n], self._buffer[n:]
                return chunk
            if not self._eof_pause_served:
                # Outlive one reaper wait so _reap_process sees a dead code
                # rather than a timeout kill; then EOF restarts the cycle.
                self._eof_pause_served = True
            time.sleep(HEARTBEAT_TIMEOUT + 0.2)
            return b""

        def write(self, data: bytes) -> int:
            return len(data)

        def flush(self) -> None:
            return

        def close(self) -> None:
            return

        def wait(self, timeout=None) -> int:
            return 1

        def kill(self) -> None:
            self.killed = True

    made: list[EofProcess] = []

    def launcher(_generation: int) -> EofProcess:
        process = EofProcess(5 + len(made))
        made.append(process)
        return process

    supervisor = EventBrokerSupervisor(launcher=launcher)
    supervisor.start()
    try:
        deadline = time.monotonic() + 8.0
        while len(made) < 2 and time.monotonic() < deadline:
            time.sleep(0.02)
        assert supervisor.resync_required, "dead stream must flag resync"
        assert supervisor.generation == 6, "generation must bump after the crash"
    finally:
        supervisor.stop()


# --------------------------------------------------------------------- #
# verifier wake sources                                                 #
# --------------------------------------------------------------------- #


def _target() -> ResolvedTarget:
    return ResolvedTarget(
        receipt=TargetReceipt(target_kind="element", description="t", window_handle=11),
        screen_point=(1, 1),
        source="test",
    )


def test_broker_wake_source_fires_only_for_scoped_window_and_property() -> None:
    source = BrokerWakeSource()
    source.subscribe(11, ("toggle_state",))
    source.feed(12, "property_changed", ("toggle_state",))  # other window
    assert not source.wait(0.01)
    source.feed(11, "property_changed", ("value",))  # other property
    assert not source.wait(0.01)
    source.feed(11, "property_changed", ("toggle_state",))  # match
    assert source.wait(0.01)


def test_resync_event_disables_property_scoping_until_next_subscribe() -> None:
    source = BrokerWakeSource()
    source.subscribe(11, ("toggle_state",))
    source.feed(None, "resync_required", ())
    assert source.wait(0.01)
    # After resync, scoping is off (frozenset cleared) so any event wakes.
    source.feed(99, "property_changed", ("whatever",))
    assert source.wait(0.01)


def test_verifier_disarm_leaves_no_stale_wake_or_scope_for_waitfor() -> None:
    """A finished verification must not leak its matched event (instant bogus
    wake) or its window/property scope (silently narrowed wake) into the
    shared source that WaitFor waits on unscoped."""
    source = BrokerWakeSource()
    source.subscribe(11, ("toggle_state",))
    source.feed(11, "property_changed", ("toggle_state",))
    assert source.wait(0.01)
    source.unsubscribe()
    # No stale wake: the leftover matched event was consumed.
    assert not source.wait(0.01)
    # No stale scope: an event on any window/property still wakes the next
    # unscoped waiter.
    source.feed(99, "property_changed", ("name",))
    assert source.wait(0.01)


def test_verifier_observe_after_dispatch_disarms_wake_source() -> None:
    """The full verifier flow must leave the wake source disarmed, even when
    the predicate is satisfied by an event-delivered change."""
    from collections import deque

    from windows_mcp.runtime.clock import FakeClock
    from windows_mcp.runtime.predicates import changed

    wake = BrokerWakeSource()
    states = deque([{"toggle_state": 0}, {"toggle_state": 1}])
    verifier = PostconditionVerifier(
        lambda target: states.popleft(),
        clock=FakeClock(),
        wake_source=wake,
    )
    handle = verifier.prepare(_target(), pre_revision=1, predicates=(changed("toggle_state"),))
    result = verifier.observe_after_dispatch(
        handle,
        changed("toggle_state"),
        earliest_qpc=handle.prepared_at_qpc,
        timeout_seconds=1.0,
    )
    assert result.evidence is not None
    # The source is fully disarmed: no event, no scope.
    assert not wake.wait(0.0)
    wake.feed(11, "property_changed", ("toggle_state",))
    assert wake.wait(0.01)
    wake.unsubscribe()


def test_verifier_confirms_via_event_wake_and_fresh_read() -> None:
    from collections import deque

    from windows_mcp.runtime.clock import FakeClock
    from windows_mcp.runtime.predicates import changed

    wake = BrokerWakeSource()
    clock = FakeClock()
    states = deque([{"toggle_state": 0}, {"toggle_state": 0}, {"toggle_state": 1}])

    def reader(target):
        return states.popleft()

    verifier = PostconditionVerifier(
        reader,
        clock=clock,
        sleeper=clock.advance,
        wake_source=wake,
        verifier_name="scoped_uia_event_poll",
    )
    handle = verifier.prepare(_target(), pre_revision=1, predicates=(changed("toggle_state"),))

    # Simulate the broker delivering a matching event after dispatch.
    threading.Thread(
        target=lambda: (time.sleep(0.05), wake.feed(11, "property_changed", ("toggle_state",))),
        daemon=True,
    ).start()

    result = verifier.observe_after_dispatch(
        handle,
        changed("toggle_state"),
        earliest_qpc=clock.qpc_ns(),
        timeout_seconds=2.0,
    )
    assert result.evidence is not None
    assert result.evidence.verifier == "scoped_uia_event_poll"
    assert result.evidence.predicate == "element.toggle_state_changed"


def test_verifier_completes_via_reconciliation_when_events_never_fire() -> None:
    """provider 漏事件：bounded reconciliation polling must still finish."""
    from collections import deque

    from windows_mcp.runtime.clock import FakeClock
    from windows_mcp.runtime.predicates import changed

    wake = BrokerWakeSource()  # never fed
    clock = FakeClock()
    states = deque([{"toggle_state": 0}] * 3 + [{"toggle_state": 1}])
    verifier = PostconditionVerifier(
        lambda target: states.popleft(),
        clock=clock,
        sleeper=clock.advance,
        wake_source=wake,
        poll_interval=0.05,
    )
    handle = verifier.prepare(_target(), pre_revision=1, predicates=(changed("toggle_state"),))
    result = verifier.observe_after_dispatch(
        handle,
        changed("toggle_state"),
        earliest_qpc=clock.qpc_ns(),
        timeout_seconds=1.0,
    )
    assert result.evidence is not None


def test_polling_wake_source_is_the_silent_fallback() -> None:
    source = PollingWakeSource()
    source.subscribe(1, ("x",))
    assert source.wait(0.0) is False
    source.unsubscribe()
