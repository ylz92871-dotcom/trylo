#!/usr/bin/env python3
"""Pending write-approval admin for the Trylo UI.

Only the Trylo UI (a VS Code command) calls this; the model never gets
apply/discard as a tool (architecture section 7 / 10, 11 §2). It wraps the official
``tools.write_approval`` pending store, the official ``apply_*_pending`` replay
functions, ``write_approval.skill_pending_diff``, ``skills_guard.scan_skill``
and ``threat_patterns`` - no pending/security/diff logic is reimplemented.

Input (JSON on stdin):
  {"op": "list"}
  {"op": "get",    "subsystem": "memory|skills", "id": "<pending_id>"}
  {"op": "apply",   "subsystem": "memory|skills", "id": "<pending_id>",
                    "expectedHash": "sha256:..."}      # R2 anti-swap
  {"op": "discard", "subsystem": "memory|skills", "id": "<pending_id>"}
  {"op": "apply_skill_with_snapshot",   # 11 §2.3 - one-shot Skill transaction
                    "id": "<pending_id>",
                    "expectedHash": "sha256:...",
                    "reason": "trylo-before-apply:<pending_id>"}
  {"op": "list_skill_backups"}
  {"op": "rollback_skill_backup", "snapshotId": "<exact id>"}

Output: one JSON line on stdout (ok/err). Diagnostics go to stderr.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import logging
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import upstream
from upstream import (
    apply_memory_pending,
    apply_skill_pending,
    list_backups,
    rollback,
    scan_for_threats,
    scan_skill,
    snapshot_skills,
    write_approval as wa,
    ok,
    err,
)
from tools.memory_tool import load_on_disk_store  # honors config char limits
import upstream  # noqa: E402 — used below

logging.basicConfig(level=logging.WARNING, format="admin: %(message)s")
logger = logging.getLogger("admin")

_SUBSYSTEMS = ("memory", "skills")
_BLOCKING_VERDICTS = {"dangerous", "blocked"}


# ---------------------------------------------------------------------------
# payload hash (anti-swap: the UI previews a hash, apply must match)
# ---------------------------------------------------------------------------
def _payload_hash(payload: Dict[str, Any]) -> str:
    """Stable hash of the pending payload. The UI shows this to the user; apply
    re-fetches the pending, recomputes, and refuses if it changed between
    preview and approve (architecture section 3.2)."""
    raw = json.dumps(payload or {}, sort_keys=True, ensure_ascii=False)
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# before/after/diff for memory
# ---------------------------------------------------------------------------
def _memory_detail(rec: Dict[str, Any]) -> Dict[str, Any]:
    payload = rec.get("payload") or {}
    action = payload.get("action", "")
    target = payload.get("target", "memory")
    content = payload.get("content") or ""
    old_text = payload.get("old_text") or ""

    if action == "add":
        before, after = "", content
    elif action == "replace":
        before, after = old_text, content
    elif action == "remove":
        before, after = old_text, "(entry removed)"
    else:  # batch
        ops = payload.get("operations") or []
        before = "(current memory)"
        after = "batch of %d op(s):\n" % len(ops) + "\n".join(
            "- %s: %s" % (o.get("action"), (o.get("content") or o.get("old_text") or "")[:120])
            for o in ops
        )
    findings = scan_for_threats(after, scope="strict") if after else []
    verdict = "blocked" if findings else "safe"
    return {
        "target": target,
        "before": before,
        "after": after,
        "diff": "\n".join(difflib.unified_diff(
            before.splitlines(keepends=True), after.splitlines(keepends=True),
            fromfile="before", tofile="after")) or "(no textual change)",
        "security": {"verdict": verdict, "findings": findings},
    }


# ---------------------------------------------------------------------------
# before/after/diff/security for skills (reuses official diff + scan_skill)
# ---------------------------------------------------------------------------
def _current_skill_md(name: str) -> Optional[str]:
    try:
        found = _find_skill(name)
    except Exception:
        return None
    if not found:
        return None
    p = Path(found["path"]) / "SKILL.md"
    try:
        return p.read_text(encoding="utf-8") if p.exists() else None
    except Exception:
        return None


def _projected_skill_md(payload: Dict[str, Any]) -> Optional[str]:
    """Projected SKILL.md content after the proposed change, or None for
    actions that don't touch SKILL.md (write_file/remove_file/delete)."""
    action = payload.get("action")
    if action in ("create", "edit"):
        return payload.get("content") or ""
    if action == "patch":
        cur = _current_skill_md(payload.get("name", "")) or ""
        old = payload.get("old_string") or ""
        new = payload.get("new_string") or ""
        return cur.replace(old, new) if old else cur
    return None


def _skill_security(payload: Dict[str, Any]) -> Tuple[str, List[str]]:
    """Security verdict for a staged skill. Materializes the projected SKILL.md
    in a throwaway temp dir and runs the official scan_skill - never writes to
    the real skills dir."""
    projected = _projected_skill_md(payload)
    if projected is not None:
        with tempfile.TemporaryDirectory(prefix="hermes-scan-") as d:
            (Path(d) / "SKILL.md").write_text(projected, encoding="utf-8")
            res = scan_skill(Path(d), source="agent-created")
            return res.verdict, [
                "%s(%s): %s" % (f.pattern_id, f.severity, f.description)
                for f in res.findings
            ]
    # Non-SKILL.md file op: scan the file content text via threat_patterns.
    fc = payload.get("file_content") or ""
    findings = scan_for_threats(fc, scope="strict") if fc else []
    return ("blocked" if findings else "safe"), findings


def _skill_detail(rec: Dict[str, Any]) -> Dict[str, Any]:
    payload = rec.get("payload") or {}
    name = payload.get("name", "")
    action = payload.get("action", "")
    # Official diff (create=full content, edit/patch=unified diff, etc.)
    diff = wa.skill_pending_diff(rec)
    before = _current_skill_md(name) or ""
    projected = _projected_skill_md(payload)
    if projected is not None:
        after = projected
    elif action == "delete":
        before, after = before, "(skill deleted)"
    elif action == "remove_file":
        before, after = "(current file)", "(file removed)"
    else:
        after = payload.get("file_content") or ""
    verdict, findings = _skill_security(payload)
    return {
        "target": name,
        "before": before,
        "after": after,
        "diff": diff or "(no textual change)",
        "security": {"verdict": verdict, "findings": findings},
    }


# ---------------------------------------------------------------------------
# ops
# ---------------------------------------------------------------------------
def list_all() -> str:
    out = []
    for sub in _SUBSYSTEMS:
        for r in wa.list_pending(sub):
            payload = r.get("payload") or {}
            out.append({
                "id": r.get("id"),
                "subsystem": r.get("subsystem") or sub,
                "action": r.get("action"),
                "target": payload.get("target") or payload.get("name") or "",
                "summary": r.get("summary"),
                "origin": r.get("origin"),
                "created_at": r.get("created_at"),
                "payloadHash": _payload_hash(payload),
            })
    return ok(pending=out, count=len(out))


def get_detail(subsystem: str, pending_id: str) -> str:
    if subsystem not in _SUBSYSTEMS:
        return err(f"unknown subsystem: {subsystem}")
    rec = wa.get_pending(subsystem, pending_id)
    if not rec:
        return err(f"pending {subsystem}/{pending_id} not found")
    payload = rec.get("payload") or {}
    detail = _memory_detail(rec) if subsystem == "memory" else _skill_detail(rec)
    return ok(
        id=pending_id,
        subsystem=subsystem,
        action=rec.get("action") or payload.get("action"),
        origin=rec.get("origin"),
        createdAt=rec.get("created_at"),
        payloadHash=_payload_hash(payload),
        source={"sessionId": None, "turnId": None, "note": "unknown"},
        **detail,
    )


def apply_pending(subsystem: str, pending_id: str, expected_hash: Optional[str] = None) -> str:
    if subsystem not in _SUBSYSTEMS:
        return err(f"unknown subsystem: {subsystem}")
    rec = wa.get_pending(subsystem, pending_id)
    if not rec:
        return err(f"pending {subsystem}/{pending_id} not found")
    payload = rec.get("payload") or {}

    # R2 anti-swap: recompute the hash from the live pending and compare to the
    # hash the user actually previewed.
    live_hash = _payload_hash(payload)
    if expected_hash and expected_hash != live_hash:
        return err(
            "payload changed since preview; refusing to apply a different change "
            "than the one the user reviewed.",
            liveHash=live_hash, expectedHash=expected_hash, kept_pending=True,
        )

    # R2 security block: refuse to apply dangerous/injection content even if the
    # user clicks Approve. Recompute from the live pending (not a cached scan).
    if subsystem == "memory":
        verdict = "blocked" if scan_for_threats(
            payload.get("content") or "", scope="strict") else "safe"
        findings = []
    else:
        verdict, findings = _skill_security(payload)
    if verdict in _BLOCKING_VERDICTS:
        return err(
            f"apply blocked by security verdict '{verdict}'; pending kept for review.",
            verdict=verdict, findings=findings, kept_pending=True,
        )

    try:
        if subsystem == "memory":
            store = load_on_disk_store()
            result = apply_memory_pending(payload, store)
        else:  # skills
            result_str = apply_skill_pending(payload)
            result = json.loads(result_str) if isinstance(result_str, str) else result_str
    except Exception as exc:  # pragma: no cover - surfaced to the UI
        logger.exception("apply failed for %s/%s", subsystem, pending_id)
        return ok(committed=False, kept_pending=True, lastError=str(exc))
    committed = bool(result.get("success")) if isinstance(result, dict) else False
    # R5: only discard the pending on a confirmed success.
    if committed:
        wa.discard_pending(subsystem, pending_id)
        return ok(committed=True, kept_pending=False, result=result)
    last_error = result.get("error") if isinstance(result, dict) else None
    return ok(committed=False, kept_pending=True, result=result, lastError=last_error)


def discard(subsystem: str, pending_id: str) -> str:
    if subsystem not in _SUBSYSTEMS:
        return err(f"unknown subsystem: {subsystem}")
    removed = wa.discard_pending(subsystem, pending_id)
    return ok(removed=bool(removed))


# ---------------------------------------------------------------------------
# 11 §2.3 / §2.4: L3 Skill snapshot + apply + list + rollback.
# These four ops go through a single Python transaction so Node never has
# to require `upstream.py` or know about backup paths. The model/MCP
# never gets these ops.
# ---------------------------------------------------------------------------

def _skills_root_is_empty() -> bool:
    """11 §2.3: decide whether the Hermes Skills tree is empty. We
    do NOT parse Skill files ourselves; we ask the official
    `list_backups()` helper for the list of currently-tracked
    backups, and the on-disk skills/ directory directly via the
    standard `os.listdir` from the configured HERMES_HOME. Empty
    means: either no skills/ directory, or the directory exists but
    contains no .md files."""
    home = os.environ.get("HERMES_HOME", "")
    if not home:
        return True
    skills_root = os.path.join(home, "skills")
    if not os.path.isdir(skills_root):
        return True
    for entry in os.listdir(skills_root):
        if entry.endswith(".md"):
            return False
    return True


def _skills_root_exists() -> bool:
    """13 §2.1 fix: the ONLY check is whether the official `skills/`
    root exists. We do NOT scan for `.md` files. The real Hermes 0.19.0
    Skill layout is `skills/<name>/SKILL.md` (a subdirectory) and any
    fake `.md` check would mis-classify a populated tree as empty.
    Whether the tree is actually populated is decided by the official
    `snapshot_skills` call below — that function already handles
    empty directories and returns None when there is genuinely
    nothing to back up.
    """
    home = os.environ.get("HERMES_HOME", "")
    if not home:
        return False
    return os.path.isdir(os.path.join(home, "skills"))


def apply_skill_with_snapshot(pending_id: str, expected_hash: Optional[str], reason: str) -> str:
    """11 §2.3: read live pending -> anti-swap -> security -> snapshot
    when non-empty -> apply -> discard. Returns the same shape as
    apply_pending plus `backupState` and `snapshotId`. On ANY failure
    before the official `apply_skill_pending` succeeds, the pending
    is kept and the function returns `committed=false, kept_pending=True`.
    """
    rec = wa.get_pending("skills", pending_id)
    if not rec:
        return err(f"pending skills/{pending_id} not found")
    payload = rec.get("payload") or {}

    # 15 §2.2: an empty expectedHash is itself a fail-closed
    # condition. The production caller (reviewSkillProposalForTurn /
    # generic review) must supply the user-previewed hash; a missing
    # one means the caller is trying to bypass anti-swap.
    if not expected_hash or not isinstance(expected_hash, str) or not expected_hash.strip():
        return err(
            "EXPECTED_HASH_REQUIRED: caller did not supply the user-previewed hash; "
            "refusing to apply.",
            kept_pending=True,
        )

    # R2 anti-swap
    live_hash = _payload_hash(payload)
    if expected_hash and expected_hash != live_hash:
        return err(
            "payload changed since preview; refusing to apply.",
            liveHash=live_hash, expectedHash=expected_hash, kept_pending=True,
        )

    # R2 security
    verdict, findings = _skill_security(payload)
    if verdict in _BLOCKING_VERDICTS:
        return err(
            f"apply blocked by security verdict '{verdict}'; pending kept.",
            verdict=verdict, findings=findings, kept_pending=True,
        )

    # Pre-apply snapshot. Per 13 §2.2: only the OFFICIAL `snapshot_skills`
    # decides. When `skills/` does not exist, we are creating from
    # scratch and `nothing_to_backup` is the honest answer. When
    # `skills/` exists we MUST call the official snapshot; if the
    # official call returns None or raises, we fail closed.
    backup_state = "nothing_to_backup"
    snapshot_id = ""
    if _skills_root_exists():
        try:
            snap_path = snapshot_skills(reason or f"trylo-before-apply:{pending_id}")
        except Exception as exc:  # pragma: no cover - surfaced to UI
            logger.exception("snapshot_skills failed for %s", pending_id)
            return err(
                f"snapshot_skills raised: {exc}",
                backupState="snapshot_failed", kept_pending=True,
            )
        if not snap_path:
            # 13 §2.2: skills/ exists but the official snapshot returned
            # nothing. That is ambiguous: it could be empty, or it could
            # be an IO error. The contract is fail closed.
            return err(
                "skills/ exists but official snapshot_skills returned no path; "
                "fail closed; pending kept.",
                backupState="snapshot_failed", kept_pending=True,
            )
        snap_name = Path(snap_path).name
        if snap_name.endswith(".tar.gz"):
            snap_name = snap_name[:-len(".tar.gz")]
        snapshot_id = snap_name
        backup_state = "snapshot_ok"

    # Official apply
    try:
        result_str = apply_skill_pending(payload)
        result = json.loads(result_str) if isinstance(result_str, str) else result_str
    except Exception as exc:  # pragma: no cover
        logger.exception("apply_skill_pending failed for %s", pending_id)
        return ok(
            committed=False, kept_pending=True,
            backupState=backup_state, snapshotId=snapshot_id,
            lastError=str(exc),
        )

    committed = bool(result.get("success")) if isinstance(result, dict) else False
    if committed:
        wa.discard_pending("skills", pending_id)
        # 13 §2.3: action / skillName are projected from the LIVE
        # payload that already passed anti-swap. Never guessed from
        # the official apply result.
        action = str(payload.get("action") or "")
        target = payload.get("target")
        skill_name = str(payload.get("name") or (target if isinstance(target, str) else "") or "")
        return ok(
            committed=True, kept_pending=False,
            backupState=backup_state, snapshotId=snapshot_id,
            action=action, skillName=skill_name, result=result,
        )
    last_error = result.get("error") if isinstance(result, dict) else None
    return ok(
        committed=False, kept_pending=True,
        backupState=backup_state, snapshotId=snapshot_id,
        result=result, lastError=last_error,
    )


def list_skill_backups() -> str:
    """11 §2.4: list the official Hermes Skill backups. The snapshotId
    field is taken verbatim from the official record; the UI must
    pass one of these ids back to `rollback_skill_backup`."""
    rows = []
    for b in (list_backups() or []):
        if not isinstance(b, dict):
            continue
        bid = b.get("id") or b.get("backup_id") or ""
        rows.append({
            "id": str(bid),
            "reason": str(b.get("reason") or ""),
            "created_at": b.get("created_at") or b.get("createdAt") or "",
            "skill_count": b.get("skill_count") if isinstance(b.get("skill_count"), int) else None,
        })
    return ok(backups=rows, count=len(rows))


def rollback_skill_backup(snapshot_id: str) -> str:
    """11 §2.4: validate the snapshotId against the live list (no
    path heuristics), then call the official `rollback`. The
    official `rollback` itself takes a pre-rollback safety snapshot
    so we do not duplicate that here."""
    if not snapshot_id:
        return err("snapshotId is required")
    live = {str(b.get("id") or b.get("backup_id") or "") for b in (list_backups() or [])}
    if snapshot_id not in live:
        return err(
            f"snapshotId {snapshot_id!r} not present in live list_backups()",
            kept_pending=True,
        )
    try:
        ok_commit, msg, safety = rollback(snapshot_id)
    except Exception as exc:  # pragma: no cover
        logger.exception("rollback failed for %s", snapshot_id)
        return err(f"rollback raised: {exc}")
    payload = {"committed": bool(ok_commit), "message": msg}
    if safety:
        payload["safetySnapshotId"] = str(Path(safety).name)
    return ok(**payload)


def _propose_skill(action: str, name: str, content: Optional[str] = None,
                   category: Optional[str] = None,
                   file_path: Optional[str] = None,
                   file_content: Optional[str] = None,
                   old_string: Optional[str] = None,
                   new_string: Optional[str] = None,
                   replace_all: bool = False) -> str:
    """Thin bridge: call the official `skill_propose` LLM tool and
    return its raw JSON. C1 (P0) — the only allowed production
    staging path.  Do NOT translate or wrap; the response is the
    contract.

    The C1 spec requires:
      - use the official `skill_propose` (NOT `apply`),
      - return the real `pending_id` from Hermes (no fabrication),
      - the LLM tool already enforces the write gate and
        `_require_staged` defence, so the only contract we
        preserve is "make the call, return the JSON".
    """
    try:
        from server import skill_propose
    except Exception as exc:
        return err(f"could not import server.skill_propose: {exc}")
    try:
        result = skill_propose(
            action=action, name=name, content=content, category=category,
            file_path=file_path, file_content=file_content,
            old_string=old_string, new_string=new_string,
            replace_all=replace_all,
        )
        # skill_propose returns JSON; the lifecycle caller parses
        # `success`/`staged`/`pending_id` itself. Pass through.
        return result if isinstance(result, str) else json.dumps(result)
    except Exception as exc:
        return err(f"skill_propose call failed: {exc}")


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception as exc:
        print(err(f"invalid stdin json: {exc}"))
        sys.exit(1)
    op = payload.get("op")
    if op == "list":
        print(list_all())
    elif op == "get":
        print(get_detail(payload.get("subsystem"), payload.get("id")))
    elif op == "apply":
        print(apply_pending(payload.get("subsystem"), payload.get("id"), payload.get("expectedHash")))
    elif op == "discard":
        print(discard(payload.get("subsystem"), payload.get("id")))
    elif op == "apply_skill_with_snapshot":
        print(apply_skill_with_snapshot(
            payload.get("id"),
            payload.get("expectedHash"),
            payload.get("reason") or f"trylo-before-apply:{payload.get('id')}",
        ))
    elif op == "list_skill_backups":
        print(list_skill_backups())
    elif op == "rollback_skill_backup":
        print(rollback_skill_backup(payload.get("snapshotId")))
    elif op == "propose_skill":
        # C1 (P0) — the real staging path. JS callers MUST use this op.
        print(_propose_skill(
            action=payload.get("action") or "",
            name=payload.get("name") or "",
            content=payload.get("content"),
            category=payload.get("category"),
            file_path=payload.get("file_path"),
            file_content=payload.get("file_content"),
            old_string=payload.get("old_string"),
            new_string=payload.get("new_string"),
            replace_all=bool(payload.get("replace_all", False)),
        ))
    else:
        print(err(f"unknown op: {op}"))
        sys.exit(1)


if __name__ == "__main__":
    main()
