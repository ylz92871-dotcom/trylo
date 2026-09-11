"""Frozen, threat-sanitized Hermes Memory snapshot for the Trylo context.

Thin adapter that calls the official Hermes 0.19.0 MemoryStore +
load_on_disk_store + format_for_system_prompt. No parsing of MEMORY.md /
USER.md is re-implemented here; the official modules own the parsing,
threat scan, capacity limits and lock semantics.

Output is a single-line JSON object with the following contract:
  {
    "success": true,
    "schemaVersion": 1,
    "hermesVersion": "0.19.0",
    "memoryBlock": "<sanitized MEMORY block>",   # may include [BLOCKED: ...] placeholders
    "userBlock":   "<sanitized USER block>",     # may include [BLOCKED: ...] placeholders
    "memoryCharCount": 1234,
    "userCharCount":   567,
    "memoryHash": "sha256:...",
    "userHash":   "sha256:...",
    "snapshotHash": "sha256:...",
    "frozenAt": 1234567890
  }

On any failure, the adapter returns success=false with `error` and
NEVER writes to memory files.

05 §5 Phase B1 — frozen memory snapshot.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from typing import Any

import upstream
from upstream import (
    MemoryStore,
    ok,
    err,
    require_version,
    load_on_disk_store,
)


SCHEMA_VERSION = 1
HERMES_REQUIRED_VERSION = upstream.HERMES_REQUIRED_VERSION

# Hard output cap. 05 §5 B1.6: "设硬输出上限, 超限按完整 block/entry 边界失败或裁剪,
# 不能输出半个 JSON". 16 KiB per block is well above the official MemoryStore
# char cap and below the agent's safe budget for the durable_memory block.
MAX_BLOCK_CHARS = int(os.environ.get("TRYLO_MEMORY_SNAPSHOT_MAX_CHARS", "16384"))


def _sha256(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _bounded_block(text: str, limit: int = MAX_BLOCK_CHARS, label: str = 'block') -> tuple[str, bool]:
    """Return (text, truncated). 07 §2 E4: we must not output a half-entry.

    If the text exceeds the limit we either fail closed (refuse to
    output a partial block) or we keep the full block untouched. We do
    NOT split on an arbitrary character offset and pretend it is
    entry-boundary safe. The caller can override by raising rather than
    emitting a partial string.

    For the memory snapshot use case we choose to fail closed by
    returning a sentinel and propagating it; the build_snapshot caller
    returns an err() payload instead of a partial snapshot.
    """
    if text is None:
        return "", False
    if len(text) <= limit:
        return text, False
    raise ValueError(
        f"{label} length {len(text)} exceeds hard limit {limit}; "
        "refusing to emit a partial entry"
    )


def _verify_block(block: str) -> str:
    """05 §5 B1.3: defence-in-depth scan in case the upstream
    `MemoryStore.load_from_disk` threat scan was ever disabled or
    regressed. v3-P3-1 fix: the previous version was a no-op (both
    branches appended the line unchanged), which masked upstream
    regressions. This version checks for known dangerous patterns
    and, if a line looks like a threat but lacks the official
    `[BLOCKED: ...]` marker, replaces it with the marker.

    Note: the upstream MemoryStore.load_from_disk is the PRIMARY
    scanner (it owns the regex catalogue). This is a backstop only.
    """
    if not block:
        return block
    # Conservative patterns: anything that could be an instruction
    # bypass. We err on the side of replacing (false positive is
    # safer than false negative for Memory blocks). v3-P3-1 fix: the
    # previous version was a no-op (both branches appended the line
    # unchanged). Now: real pattern match. Inline (?i) is invalid mid
    # pattern in Python re, so we compile with re.IGNORECASE instead.
    threat_patterns = (
        r"\b(?:run_shell|shell_exec|eval\(|exec\(|subprocess\.|os\.system)\b",
        r"\b(?:import\s+os|import\s+subprocess|import\s+sys)\b",
        r"\b(?:exfiltrate|http://|https://[^\s]*localhost)",
        r"\bcurl\s+[^\n]*\|\s*(?:sh|bash)\b",
    )
    threat_re = re.compile("|".join(threat_patterns), re.IGNORECASE)
    safe_lines = []
    for line in block.splitlines():
        if "[BLOCKED:" in line:
            safe_lines.append(line)
            continue
        if threat_re.search(line):
            # Replace with the official marker so downstream rendering
            # is uniform. Do NOT silently drop: the operator needs the
            # visibility that something was flagged.
            safe_lines.append("[BLOCKED: defence_in_depth_pattern_match]")
        else:
            safe_lines.append(line)
    return "\n".join(safe_lines)


def build_snapshot(hermes_home: str = "") -> dict[str, Any]:
    """Build a frozen Memory snapshot. Returns a JSON-serialisable dict."""
    version_check = json.loads(require_version())
    if not version_check.get("success"):
        return version_check  # err() payload

    if not hermes_home:
        hermes_home = os.environ.get("HERMES_HOME", "")

    started = time.time()
    try:
        # 05 §5 B1.2: load_on_disk_store() respects the user-configured
        # memory/user char limit and triggers threat scan on load. We do
        # NOT take a custom path — the store knows where to look
        # (HERMES_HOME env var or the user's memory config).
        # HERMES_HOME must be set BEFORE we call into the store so the
        # official load logic finds the right files.
        if hermes_home:
            os.environ["HERMES_HOME"] = hermes_home
        store = load_on_disk_store()
    except Exception as exc:  # pragma: no cover - surfaced to caller
        return err(f"MemoryStore load failed: {exc}")

    try:
        memory_block = store.format_for_system_prompt("memory") or ""
        user_block = store.format_for_system_prompt("user") or ""
    except Exception as exc:  # pragma: no cover - surfaced to caller
        return err(f"format_for_system_prompt failed: {exc}")

    memory_block = _verify_block(memory_block)
    user_block = _verify_block(user_block)
    try:
        memory_block, _ = _bounded_block(memory_block, label='memoryBlock')
        user_block, _ = _bounded_block(user_block, label='userBlock')
    except ValueError as exc:
        # 07 §2 E4: refuse to emit a half-block. Caller fails closed.
        return err(f"memory snapshot too large to emit safely: {exc}")

    snapshot = {
        "success": True,
        "schemaVersion": SCHEMA_VERSION,
        "hermesVersion": HERMES_REQUIRED_VERSION,
        "memoryBlock": memory_block,
        "userBlock": user_block,
        "memoryCharCount": len(memory_block),
        "userCharCount": len(user_block),
        "memoryHash": _sha256(memory_block),
        "userHash": _sha256(user_block),
        "frozenAt": int(started * 1000),
    }
    # Combined hash for the caller to verify atomicity.
    combined = snapshot["memoryHash"] + "|" + snapshot["userHash"]
    snapshot["snapshotHash"] = _sha256(combined)
    return snapshot


def main() -> int:
    """CLI entry point. Reads a JSON request on stdin:
        {"hermes_home": "..."}   (hermes_home optional)
    Writes a single-line JSON response on stdout and exits 0.
    On any uncaught failure, writes err() JSON and exits 1.
    """
    try:
        raw = sys.stdin.read()
        request = json.loads(raw) if raw.strip() else {}
    except Exception as exc:
        sys.stdout.write(err(f"invalid request JSON: {exc}"))
        return 1

    hermes_home = str(request.get("hermes_home") or os.environ.get("HERMES_HOME") or "")
    snapshot = build_snapshot(hermes_home=hermes_home)
    sys.stdout.write(json.dumps(snapshot, ensure_ascii=False))
    return 0 if snapshot.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
