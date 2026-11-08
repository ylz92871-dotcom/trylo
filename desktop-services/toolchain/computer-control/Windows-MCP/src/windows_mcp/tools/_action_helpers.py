"""Compatibility bridge from legacy actuators to the V2 result contract."""

from __future__ import annotations

import json
from typing import Any

from windows_mcp.runtime.results import (
    ActionResult,
    DispatchStatus,
    TargetReceipt,
    VerificationEvidence,
    confirmed_success_result,
    dispatched_unknown_result,
    legacy_action_text,
)

# Marker prefix the host parses off result text blocks to learn the server
# RESOLVED target identity (WCC-P2-01). Primitive JSON only; the host
# validates every field, so anything malformed is simply ignored there.
TARGET_RESULT_PREFIX = "trylo-target:"


def window_receipt_digest(hwnd: int, pid: int, started_at_100ns: int | None) -> str:
    """Backward-compat alias; the contract lives in runtime.identity."""
    from windows_mcp.runtime.identity import window_receipt_digest as _impl

    return _impl(hwnd, pid, started_at_100ns)


def _live_process_start_100ns(pid: int) -> int | None:
    from windows_mcp.runtime.identity import process_start_100ns

    return process_start_100ns(pid)


def _foreground_window_identity() -> tuple[int, int] | None:
    try:
        import win32gui
        import win32process

        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return None
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        return int(hwnd), int(pid)
    except Exception:
        return None


def target_facts_text(
    *,
    window_handle: int | None,
    process_id: int | None,
    title: str | None = None,
    dispatch: str | None = None,
    effect: str | None = None,
    channel: str | None = None,
    takeover: str | None = None,
) -> str | None:
    """Build the host-facing target fact block for a tool result.

    Carries the resolved window receipt, the CURRENT foreground digest (the
    host feeds it into lease ``revokeOn: foreground_changed``), and the
    dispatch/effect/channel triple straight from the ActionResult — the UI
    shows them verbatim instead of parsing projected text. No window title
    beyond the display-only truncation, no user content ever.
    """
    if window_handle is None or process_id is None:
        return None
    hwnd = int(window_handle)
    pid = int(process_id)
    started = _live_process_start_100ns(pid)
    foreground = _foreground_window_identity()
    foreground_digest = (
        window_receipt_digest(foreground[0], foreground[1], _live_process_start_100ns(foreground[1]))
        if foreground is not None
        else None
    )
    window_facts: dict[str, Any] = {
        "hwnd": hwnd,
        "pid": pid,
        "processStartedAt100ns": started,
        "digest": window_receipt_digest(hwnd, pid, started),
    }
    if title:
        window_facts["title"] = str(title)[:200]
    facts: dict[str, Any] = {"window": window_facts, "foregroundDigest": foreground_digest}
    if dispatch:
        facts["dispatch"] = str(dispatch)
    if effect:
        facts["effect"] = str(effect)
    if channel:
        facts["channel"] = str(channel)
    if takeover:
        # WCC-P2-04 (spec §11.3): identity-only takeover fact. The host's
        # classifier turns this into forced per-call approvals; the UI shows
        # it as the YIELDED/CANCELLED state. No user content, ever.
        facts["takeover"] = str(takeover)
    return f"{TARGET_RESULT_PREFIX}{json.dumps(facts, sort_keys=True)}"



def project_dispatched_action(
    runtime_owner: Any,
    legacy_text: str,
    *,
    target_kind: str,
    target_description: str,
    execution_channel: str,
    snapshot_id: str | None = None,
    element_id: str | None = None,
    window_handle: int | None = None,
    process_id: int | None = None,
    window_title: str | None = None,
    pre_revision: int = 0,
    dispatch_status: DispatchStatus = DispatchStatus.ACCEPTED,
    verification: VerificationEvidence | None = None,
    post_revision: int | None = None,
    takeover: str | None = None,
) -> str:
    """Create, record, then project a structured result as legacy text.

    When the action resolved to an exact window, the projection carries a
    ``trylo-target:{…}`` fact block after the legacy text: the host parses
    it to scope approvals to that window and to revoke window-scoped leases
    when the foreground moves (WCC-P2-01). The block contains identity
    fields only — hwnd, pid, process start time, digest, truncated title.
    """
    if snapshot_id is not None:
        marker = getattr(runtime_owner, "mark_snapshot_mutated", None)
        if callable(marker):
            marker(snapshot_id)
    receipt = TargetReceipt(
        target_kind=target_kind,
        description=target_description,
        snapshot_id=snapshot_id,
        element_id=element_id,
        window_handle=window_handle,
        process_id=process_id,
    )
    if verification is not None:
        result = confirmed_success_result(
            target_receipt=receipt,
            execution_channel=execution_channel,
            dispatch=dispatch_status,
            pre_revision=pre_revision,
            post_revision=(
                post_revision if post_revision is not None else pre_revision + 1
            ),
            verification=verification,
            legacy_text=legacy_text,
        )
    else:
        result = dispatched_unknown_result(
            target_receipt=receipt,
            execution_channel=execution_channel,
            dispatch=dispatch_status,
            pre_revision=pre_revision,
            legacy_text=legacy_text,
        )
    recorder = getattr(runtime_owner, "record_action_result", None)
    if callable(recorder):
        recorder(result)
    text = legacy_action_text(result)
    if window_handle is not None and process_id is not None:
        facts = target_facts_text(
            window_handle=window_handle,
            process_id=process_id,
            title=window_title,
            dispatch=result.dispatch.value,
            effect=result.effect.value,
            channel=execution_channel,
            takeover=takeover,
        )
        if facts is not None:
            text = f"{text}\n{facts}"
    return text


def last_recorded_action(runtime_owner: Any) -> ActionResult | None:
    """Test/diagnostic accessor that avoids exposing mutable runtime state."""
    getter = getattr(runtime_owner, "last_action_result", None)
    if not callable(getter):
        return None
    result = getter()
    return result if isinstance(result, ActionResult) else None
