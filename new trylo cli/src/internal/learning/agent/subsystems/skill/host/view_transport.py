"""Read the host-owned view envelope; never obtain limits from tool arguments."""
from __future__ import annotations

import os
from collections.abc import Mapping

VIEW_MAX_BYTES_ENV = "TRYLO_HERMES_VIEW_MAX_BYTES"


def require_view_max_bytes(environment: Mapping[str, str] | None = None) -> int:
    raw = (os.environ if environment is None else environment).get(VIEW_MAX_BYTES_ENV)
    if not isinstance(raw, str) or not raw.isascii() or not raw.isdigit() or int(raw) <= 0:
        raise ValueError("hermes_view_transport_budget_required")
    return int(raw)


def view_reply_fits(reply: str, max_chars: int, max_bytes: int | None = None) -> bool:
    if len(reply) > max_chars:
        return False
    if max_bytes is None:
        return True
    try:
        return len(reply.encode("utf-8")) <= max_bytes
    except UnicodeEncodeError:
        # A reply that cannot cross the UTF-8 transport is never a complete read.
        return False
