"""Versioned, bounded messages exchanged with the event broker process.

Design constraints (WCC-P1-05 / spec §6.3):

- Messages are primitive-only JSON: no COM object, HWND wrapper, or callback
  ever crosses the process boundary. UIA callbacks inside the broker extract
  the minimum identity fields and enqueue immediately.
- Every message carries the broker ``generation``. The supervisor increments
  the generation on every (re)start, so events and subscriptions from a dead
  broker can be recognized and discarded instead of being mistaken for fresh
  facts.
- Frames are length-prefixed JSON lines with a hard size limit; an oversized
  or undecodable frame is a protocol violation, never silently truncated.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass, field
from typing import Any, Mapping

PROTOCOL_VERSION = 1

# Property ids monitored by the default subscription (same set the legacy
# watchdog used): 30005 Name, 30045 Value, 30093 LegacyIAccessibleValue,
# 30128 ToggleState. The supervisor sends these to every new broker
# generation so the wake stream is live without a per-window subscribe.
DEFAULT_PROPERTY_IDS = (30005, 30045, 30093, 30128)

# Property id → stable field name for changed_properties reporting. Shared by
# the supervisor (server side) and the UIA subscription source (broker side).
PROPERTY_NAMES = {
    30005: "Name",
    30045: "Value",
    30093: "LegacyIAccessibleValue",
    30128: "ToggleState",
}

# Length-prefix is 4-byte little-endian unsigned; frames larger than this are
# a protocol error. Events are tiny by construction (primitive identity only).
MAX_FRAME_BYTES = 1 << 20
_HEADER = struct.Struct("<I")


class ProtocolError(RuntimeError):
    """A peer sent a frame that cannot be trusted; the stream is poisoned."""


def _validated_meta(meta: Mapping[str, Any] | None) -> dict[str, Any]:
    if meta is None:
        return {}
    if not isinstance(meta, dict):
        raise ValueError("meta must be a mapping")
    return meta


@dataclass(frozen=True, slots=True)
class BrokerHello:
    """First message a broker sends on the pipe after starting."""

    generation: int
    protocol_version: int = PROTOCOL_VERSION
    capabilities: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": "hello",
            "protocol_version": self.protocol_version,
            "generation": self.generation,
            "capabilities": list(self.capabilities),
        }


@dataclass(frozen=True, slots=True)
class SubscribeRequest:
    """Server → broker subscription. Properties/events are UIA identifiers."""

    window_hwnd: int | None = None
    properties: tuple[int, ...] = ()
    events: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": "subscribe",
            "window_hwnd": self.window_hwnd,
            "properties": list(self.properties),
            "events": list(self.events),
        }


@dataclass(frozen=True, slots=True)
class DesktopEvent:
    """A normalized, primitive-only desktop event.

    ``kind`` values mirror spec §11.1: ``focus_changed``, ``property_changed``,
    ``structure_changed``, ``window_opened``, ``window_closed``,
    ``window_moved``, ``foreground_changed``, ``resync_required``.
    Events are wake-up hints, never final facts: the consumer must re-read
    live state on the actor thread before drawing conclusions.
    """

    generation: int
    sequence: int
    kind: str
    observed_at_qpc: int
    window_hwnd: int | None = None
    window_pid: int | None = None
    runtime_id: tuple[int, ...] | None = None
    name_hint: str | None = None
    changed_properties: tuple[str, ...] = ()
    meta: Mapping[str, Any] = field(default_factory=dict)

    @property
    def event_id(self) -> str:
        return f"evt_{self.generation}_{self.sequence}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": "event",
            "generation": self.generation,
            "sequence": self.sequence,
            "kind": self.kind,
            "observed_at_qpc": self.observed_at_qpc,
            "window_hwnd": self.window_hwnd,
            "window_pid": self.window_pid,
            "runtime_id": list(self.runtime_id) if self.runtime_id else None,
            "name_hint": self.name_hint,
            "changed_properties": list(self.changed_properties),
            "meta": dict(self.meta),
        }


@dataclass(frozen=True, slots=True)
class Heartbeat:
    generation: int
    sequence: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": "heartbeat",
            "generation": self.generation,
            "sequence": self.sequence,
        }


Message = BrokerHello | SubscribeRequest | DesktopEvent | Heartbeat

_DATA_CLASSES = {
    "hello": BrokerHello,
    "subscribe": SubscribeRequest,
    "event": DesktopEvent,
    "heartbeat": Heartbeat,
}

_KINDS = frozenset(
    {
        "focus_changed",
        "property_changed",
        "structure_changed",
        "window_opened",
        "window_closed",
        "window_moved",
        "foreground_changed",
        "resync_required",
    }
)


def encode(message: Message) -> bytes:
    payload = json.dumps(message.to_dict(), ensure_ascii=False).encode("utf-8")
    if len(payload) > MAX_FRAME_BYTES:
        raise ValueError("encoded message exceeds the protocol frame limit")
    return _HEADER.pack(len(payload)) + payload


def decode(frame: bytes) -> Message:
    if len(frame) > MAX_FRAME_BYTES:
        raise ProtocolError("frame exceeds the protocol size limit")
    try:
        data = json.loads(frame.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError("frame is not valid JSON") from exc
    if not isinstance(data, dict):
        raise ProtocolError("frame must be a JSON object")
    kind = data.get("type")
    cls = _DATA_CLASSES.get(kind)
    if cls is None:
        raise ProtocolError(f"unknown message type: {kind!r}")
    return _from_dict(cls, data)


def read_frame(read_exact) -> bytes | None:
    """Read one length-prefixed frame using a ``read_exact(n) -> bytes``
    callable. Returns None on clean EOF at a frame boundary; raises
    ProtocolError when the stream ends mid-frame or the header is corrupt.
    The callable signals EOF by returning fewer bytes than requested (or b'')."""

    header = read_exact(_HEADER.size)
    if not header:
        return None
    if len(header) < _HEADER.size:
        return None  # torn header: treat as EOF at a frame boundary
    try:
        (length,) = _HEADER.unpack(header)
    except struct.error as exc:
        raise ProtocolError("frame header is corrupt") from exc
    if length > MAX_FRAME_BYTES:
        raise ProtocolError("declared frame length exceeds the protocol limit")
    payload = read_exact(length)
    if not payload or len(payload) < length:
        raise ProtocolError("stream ended mid-frame")
    return payload


def _from_dict(cls: type, data: Mapping[str, Any]) -> Message:
    if cls is BrokerHello:
        return BrokerHello(
            generation=_positive_int(data.get("generation"), "generation"),
            protocol_version=data.get("protocol_version", PROTOCOL_VERSION),
            capabilities=tuple(str(c) for c in data.get("capabilities", ())),
        )
    if cls is SubscribeRequest:
        hwnd = data.get("window_hwnd")
        return SubscribeRequest(
            window_hwnd=None if hwnd is None else _positive_int(hwnd, "window_hwnd"),
            properties=tuple(int(p) for p in data.get("properties", ())),
            events=tuple(str(e) for e in data.get("events", ())),
        )
    if cls is Heartbeat:
        return Heartbeat(
            generation=_positive_int(data.get("generation"), "generation"),
            sequence=_non_negative_int(data.get("sequence"), "sequence"),
        )
    # DesktopEvent
    kind = str(data.get("kind", ""))
    if kind not in _KINDS:
        raise ProtocolError(f"unknown event kind: {kind!r}")
    runtime_id = data.get("runtime_id")
    hwnd = data.get("window_hwnd")
    pid = data.get("window_pid")
    return DesktopEvent(
        generation=_positive_int(data.get("generation"), "generation"),
        sequence=_non_negative_int(data.get("sequence"), "sequence"),
        kind=kind,
        observed_at_qpc=_non_negative_int(data.get("observed_at_qpc"), "observed_at_qpc"),
        window_hwnd=None if hwnd is None else int(hwnd),
        window_pid=None if pid is None else int(pid),
        runtime_id=None if runtime_id is None else tuple(int(p) for p in runtime_id),
        name_hint=None if data.get("name_hint") is None else str(data["name_hint"]),
        changed_properties=tuple(str(p) for p in data.get("changed_properties", ())),
        meta=_validated_meta(data.get("meta")),
    )


def _positive_int(value: Any, field_name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ProtocolError(f"{field_name} must be a positive integer")
    return value


def _non_negative_int(value: Any, field_name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ProtocolError(f"{field_name} must be a non-negative integer")
    return value
