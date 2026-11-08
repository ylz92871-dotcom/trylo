"""Snapshot-bound process, window, and element identities."""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass


def process_start_100ns(pid: int) -> int | None:
    """Live process creation time in 100ns units, or None when unavailable."""
    try:
        from psutil import Process

        return int(Process(pid).create_time() * 10_000_000)
    except Exception:
        return None


def window_receipt_digest(hwnd: int, pid: int, started_at_100ns: int | None) -> str:
    """Stable digest of one window's identity (HWND + PID + process start).

    The host scopes leases to this digest, never to a window title: a PID
    reuse (new process start time) produces a different digest, so an old
    lease cannot ride across an app restart. Pure function so tests can pin
    the cross-restart behavior and so the server can recompute it at
    dispatch to verify a model-supplied receipt (WCC-P2-02). The material
    serialization (json.dumps sort_keys) is part of the contract — changing
    it silently invalidates every issued receipt.
    """
    material = json.dumps(
        {"hwnd": int(hwnd), "pid": int(pid), "startedAt100ns": started_at_100ns},
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(material).hexdigest()[:32]


def window_receipt(
    hwnd: int, pid: int, *, title: str | None = None
) -> dict[str, object]:
    """Build one host-facing window receipt dict for a live window."""
    started = process_start_100ns(pid)
    receipt: dict[str, object] = {
        "hwnd": int(hwnd),
        "pid": int(pid),
        "processStartedAt100ns": started,
        "digest": window_receipt_digest(hwnd, pid, started),
    }
    if title:
        receipt["title"] = str(title)[:200]
    return receipt


@dataclass(frozen=True, slots=True)
class ProcessInstanceRef:
    pid: int
    started_at_100ns: int
    executable_path_hash: str | None = None
    package_family_name: str | None = None
    aumid: str | None = None

    def __post_init__(self) -> None:
        if self.pid <= 0 or self.started_at_100ns < 0:
            raise ValueError("invalid process instance identity")


@dataclass(frozen=True, slots=True)
class WindowRef:
    desktop_session_id: str
    producer_generation: int
    hwnd: int
    owner: ProcessInstanceRef
    window_generation: int

    def __post_init__(self) -> None:
        if not self.desktop_session_id or self.hwnd <= 0:
            raise ValueError("invalid window identity")
        if self.producer_generation < 0 or self.window_generation < 0:
            raise ValueError("window generations must be non-negative")


@dataclass(frozen=True, slots=True)
class ReacquireLocator:
    control_type: str
    automation_id: str | None = None
    class_name: str | None = None
    framework_id: str | None = None
    ancestor_fingerprint: tuple[str, ...] = ()
    name_hint: str | None = None
    spatial_hint: tuple[float, float] | None = None


@dataclass(frozen=True, slots=True)
class ElementRef:
    element_id: str
    snapshot_id: str
    window: WindowRef
    runtime_id: tuple[int, ...] | None
    locator: ReacquireLocator

    def __post_init__(self) -> None:
        if not self.element_id or not self.snapshot_id:
            raise ValueError("element and snapshot ids must not be empty")


class IdentityFactory:
    """Generate opaque, unguessable IDs without exposing user paths or names."""

    def __init__(self, secret: bytes | None = None) -> None:
        self._secret = secret or secrets.token_bytes(32)
        if len(self._secret) < 16:
            raise ValueError("identity secret must contain at least 16 bytes")
        self._sequence = 0

    def new_id(self, kind: str, *identity_parts: object) -> str:
        if not kind.isascii() or not kind.replace("_", "").isalnum():
            raise ValueError("identity kind must be an ASCII identifier")
        self._sequence += 1
        material = "\x1f".join(
            [kind, str(self._sequence), *(repr(part) for part in identity_parts)]
        ).encode("utf-8", errors="surrogatepass")
        digest = hmac.new(self._secret, material, hashlib.sha256).hexdigest()[:32]
        return f"{kind}_{digest}"

    @staticmethod
    def executable_path_hash(path: str) -> str:
        normalized = path.replace("/", "\\").casefold().encode("utf-8")
        return hashlib.sha256(normalized).hexdigest()
