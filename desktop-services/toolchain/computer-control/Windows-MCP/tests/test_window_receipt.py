"""WCC-P2-02: model-supplied window_receipt verification (fail closed).

The receipt copied from a Snapshot's Window Receipts is a VERIFIER, not an
alternative selector: the host scopes the user's approval to its digest, so
the server must refuse any action whose resolved window no longer matches
the receipt (app restarted, receipt belongs to another window, or the
receipt contradicts the ``window`` name).
"""

import pytest

from windows_mcp.runtime.identity import window_receipt, window_receipt_digest
from windows_mcp.tools._action_helpers import TARGET_RESULT_PREFIX


class _Window:
    def __init__(self, handle: int, process_id: int, name: str = "Notepad"):
        self.handle = handle
        self.process_id = process_id
        self.name = name


def _desktop_with_window(monkeypatch, handle: int, pid: int, start: int = 1330):
    """Build a minimal Desktop double exposing only what the verifier uses."""
    from windows_mcp.desktop.service import Desktop

    desktop = Desktop.__new__(Desktop)
    monkeypatch.setattr(
        "windows_mcp.desktop.service.Desktop._find_window_by_name",
        lambda self, name, refresh_state=False: (_Window(handle, pid), ""),
    )
    monkeypatch.setattr(
        "windows_mcp.runtime.identity.process_start_100ns", lambda pid_: start
    )
    return desktop


def test_matching_receipt_passes(monkeypatch) -> None:
    from windows_mcp.desktop.service import Desktop

    desktop = _desktop_with_window(monkeypatch, handle=7, pid=700, start=1330)
    receipt = window_receipt(7, 700)
    # Must not raise.
    Desktop._verify_window_receipt(desktop, "Notepad", receipt, resolved=None)


def test_receipt_for_restarted_process_is_refused(monkeypatch) -> None:
    from windows_mcp.desktop.service import Desktop, TargetResolutionError
    from windows_mcp.runtime.errors import ErrorCode

    desktop = _desktop_with_window(monkeypatch, handle=7, pid=700, start=1330)
    # The receipt was issued before the app restarted (start time differs).
    stale = window_receipt(7, 700, ) | {}
    stale["processStartedAt100ns"] = 999
    stale["digest"] = window_receipt_digest(7, 700, 999)
    with pytest.raises(TargetResolutionError) as exc_info:
        Desktop._verify_window_receipt(desktop, "Notepad", stale, resolved=None)
    assert exc_info.value.code is ErrorCode.STALE_WINDOW


def test_receipt_for_another_window_is_refused(monkeypatch) -> None:
    from windows_mcp.desktop.service import Desktop, TargetResolutionError
    from windows_mcp.runtime.errors import ErrorCode

    desktop = _desktop_with_window(monkeypatch, handle=7, pid=700)
    other = window_receipt(8, 800)
    with pytest.raises(TargetResolutionError) as exc_info:
        Desktop._verify_window_receipt(desktop, "Notepad", other, resolved=None)
    assert exc_info.value.code is ErrorCode.STALE_WINDOW


def test_malformed_receipt_is_refused(monkeypatch) -> None:
    from windows_mcp.desktop.service import Desktop, TargetResolutionError
    from windows_mcp.runtime.errors import ErrorCode

    desktop = _desktop_with_window(monkeypatch, handle=7, pid=700)
    for bad in ({}, {"hwnd": "x", "digest": "d"}, {"hwnd": 7}, {"digest": ""}):
        with pytest.raises(TargetResolutionError) as exc_info:
            Desktop._verify_window_receipt(desktop, "Notepad", bad, resolved=None)
        assert exc_info.value.code is ErrorCode.STALE_WINDOW


def test_receipt_without_resolvable_window_is_refused(monkeypatch) -> None:
    from windows_mcp.desktop.service import Desktop, TargetResolutionError
    from windows_mcp.runtime.errors import ErrorCode

    desktop = _desktop_with_window(monkeypatch, handle=7, pid=700)
    receipt = window_receipt(7, 700)
    with pytest.raises(TargetResolutionError) as exc_info:
        Desktop._verify_window_receipt(desktop, None, receipt, resolved=None)
    assert exc_info.value.code is ErrorCode.STALE_WINDOW


def test_no_receipt_is_the_legacy_passthrough() -> None:
    from windows_mcp.desktop.service import Desktop

    desktop = Desktop.__new__(Desktop)
    # Legacy calls (no receipt) never consult the verifier.
    Desktop._verify_window_receipt(desktop, "Notepad", None, resolved=None)


def test_empty_receipt_dict_is_malformed_not_absent(monkeypatch) -> None:
    """A present-but-empty receipt is a malformed exact-target claim and
    must fail closed — only ``None`` means "no claim"."""
    from windows_mcp.desktop.service import Desktop, TargetResolutionError
    from windows_mcp.runtime.errors import ErrorCode

    desktop = _desktop_with_window(monkeypatch, handle=7, pid=700)
    with pytest.raises(TargetResolutionError) as exc_info:
        Desktop._verify_window_receipt(desktop, "Notepad", {}, resolved=None)
    assert exc_info.value.code is ErrorCode.STALE_WINDOW


def test_facts_digest_matches_snapshot_receipt(monkeypatch) -> None:
    """The digest the mutation facts block echoes must equal what the
    Snapshot's Window Receipts published — one identity, one digest."""
    from windows_mcp.tools import _action_helpers as helpers

    monkeypatch.setattr(helpers, "_live_process_start_100ns", lambda pid: 1330)
    facts = helpers.target_facts_text(window_handle=7, process_id=700)
    assert facts is not None
    import json

    payload = json.loads(facts[len(TARGET_RESULT_PREFIX):])
    assert payload["window"]["digest"] == window_receipt_digest(7, 700, 1330)
