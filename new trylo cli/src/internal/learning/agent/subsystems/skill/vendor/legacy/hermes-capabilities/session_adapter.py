#!/usr/bin/env python3
"""Map Trylo sessions into the Hermes SessionDB search index.

Trylo's JSON / VS Code Memento store remains the authoritative session record.
This module only mirrors user/assistant text into Hermes ``state.db`` so
``session_search`` can recall past Trylo conversations. All writes go through
``SessionDB`` public methods - no custom SQL, no custom schema.

Safety (HERMES_FUSION_ARCHITECTURE.md section 9.2 + repair R4):
  - Every mirrored session id is prefixed ``trylo_`` with source ``trylo-vscode``.
  - Before ``replace_messages``, ``get_session`` confirms the row is either absent
    or already ``source=trylo-vscode``; a row owned by another source is refused.
  - ``replace_messages`` only ever targets trylo_-prefixed rows.
  - rebuild lists ``source=trylo-vscode`` rows and ``delete_session``s any that no
    longer exist in the Trylo JSON library - never touches other sources.
  - A content hash (incl. title/workspace/model + schema version) is stored via
    ``set_meta`` and re-checked via ``get_meta`` so unchanged sessions are skipped
    and a metadata-only change still updates the index.

Input (stdin JSON):
  {"op": "sync",   "session": <trylo session>}
  {"op": "rebuild","sessions": [<trylo session>, ...]}
Output: one JSON line on stdout (ok/err). Diagnostics to stderr.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sys
from datetime import datetime

import upstream
from upstream import SessionDB, ok, err

logging.basicConfig(level=logging.WARNING, format="session-adapter: %(message)s")
logger = logging.getLogger("session-adapter")

TRYLO_SOURCE = "trylo-vscode"
SESSION_ADAPTER_SCHEMA_VERSION = 2


def _trylo_id(session_id) -> str:
    return "trylo_" + str(session_id or "")


def _mirrorable_messages(session: dict) -> list:
    """Only prompt (user) and resultText (assistant) are mirrored. Never secrets,
    attachment binaries, raw structured messages, full shell output, permission
    payloads, or shadow-review paths (architecture 9.1)."""
    out = []
    for turn in session.get("turns", []) or []:
        if not isinstance(turn, dict):
            continue
        prompt = turn.get("prompt")
        result = turn.get("resultText")
        # A cancelled/failed user-only turn is not a settled exchange and must
        # not enter recall as if Hermes had observed a completed outcome.
        if not isinstance(prompt, str) or not prompt.strip():
            continue
        if not isinstance(result, str) or not result.strip():
            continue
        started = turn.get("startedAt")
        ts = None
        if isinstance(started, (int, float)):
            ts = float(started) / 1000.0
        elif isinstance(started, str) and started.strip():
            try:
                ts = datetime.fromisoformat(started.strip().replace("Z", "+00:00")).timestamp()
            except ValueError:
                ts = None
        out.append({"role": "user", "content": prompt, "timestamp": ts})
        out.append({"role": "assistant", "content": result, "timestamp": ts})
    return out


def _content_hash(session: dict) -> str:
    """Hash covering every field written to SessionDB: per-turn prompt/result/
    startedAt, plus title, workspace.path, model, and the adapter schema version
    (so a metadata-only change or a schema bump forces a re-sync)."""
    h = hashlib.sha256()
    h.update(("schema=" + str(SESSION_ADAPTER_SCHEMA_VERSION)).encode("utf-8")); h.update(b"\x00")
    h.update(str(session.get("title", "")).encode("utf-8")); h.update(b"\x00")
    ws = session.get("workspace") or {}
    h.update(str(ws.get("path", "") if isinstance(ws, dict) else "").encode("utf-8")); h.update(b"\x00")
    h.update(str(session.get("model", "")).encode("utf-8")); h.update(b"\x00")
    for turn in session.get("turns", []) or []:
        if not isinstance(turn, dict):
            continue
        for key in ("prompt", "resultText", "startedAt"):
            h.update(str(turn.get(key, "")).encode("utf-8"))
            h.update(b"\x00")
    return h.hexdigest()


def _meta_key(sid: str) -> str:
    return "trylo_hash_" + sid


def sync_one(db: SessionDB, session: dict) -> dict:
    sid = _trylo_id(session.get("id"))
    if not sid or sid == "trylo_":
        raise ValueError("session has no id")
    if not sid.startswith("trylo_"):
        raise ValueError("refusing to sync a non-trylo session id: " + sid)

    # Source guard (R4): only touch rows we own.
    existing = db.get_session(sid)
    if existing and (existing.get("source") or "") != TRYLO_SOURCE:
        raise ValueError(
            f"session {sid} exists with source "
            f"{existing.get('source')!r} != {TRYLO_SOURCE!r}; refusing to overwrite"
        )

    chash = _content_hash(session)
    # Skip unchanged sessions: cheap get_meta probe avoids replace_messages.
    if (db.get_meta(_meta_key(sid)) or "") == chash:
        return {"session_id": sid, "skipped": True, "hash": chash}

    ws = session.get("workspace") or {}
    cwd = ws.get("path") if isinstance(ws, dict) else None
    model = session.get("model")
    title = session.get("title")

    db.ensure_session(sid, source=TRYLO_SOURCE, model=model, cwd=cwd)
    if title:
        db.set_session_title(sid, str(title))
    if cwd:
        db.update_session_cwd(sid, str(cwd))
    if model:
        db.update_session_model(sid, str(model))

    msgs = _mirrorable_messages(session)
    db.replace_messages(sid, msgs)
    db.set_meta(_meta_key(sid), chash)
    return {"session_id": sid, "message_count": len(msgs), "hash": chash}


def rebuild(db: SessionDB, sessions: list) -> dict:
    """Sync all Trylo sessions AND delete trylo-vscode rows that no longer exist
    in the Trylo JSON library (R4). Never touches other sources."""
    valid_ids = {_trylo_id(s.get("id")) for s in sessions
                 if isinstance(s, dict) and s.get("id")}
    results = []
    for s in sessions:
        if not isinstance(s, dict) or not s.get("id"):
            continue
        try:
            results.append(sync_one(db, s))
        except Exception as exc:  # per-session resilience
            logger.exception("sync failed for %s", s.get("id"))
            results.append({"session_id": _trylo_id(s.get("id")), "error": str(exc)})

    # Delete sync: remove trylo-vscode sessions no longer in the Trylo library.
    deleted = []
    try:
        rows = db.list_sessions_rich(source=TRYLO_SOURCE, limit=100000)
    except Exception as exc:
        logger.exception("list_sessions_rich failed during rebuild")
        rows = []
    for row in rows or []:
        sid = row.get("id") or ""
        if not sid or not sid.startswith("trylo_"):
            continue
        if sid not in valid_ids:
            try:
                if db.delete_session(sid):
                    deleted.append(sid)
                    db.set_meta(_meta_key(sid), "")  # clear stale hash
            except Exception as exc:
                logger.exception("delete_session failed for %s", sid)
                results.append({"session_id": sid, "delete_error": str(exc)})
    return {"synced": len(results), "deleted": deleted, "results": results}


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception as exc:
        print(err(f"invalid stdin json: {exc}"))
        sys.exit(1)

    db = SessionDB()
    try:
        if payload.get("op") == "rebuild":
            print(ok(**rebuild(db, payload.get("sessions") or [])))
        else:
            session = payload.get("session") or {}
            if not isinstance(session, dict) or not session.get("id"):
                print(err("sync requires a session with an id"))
                sys.exit(1)
            print(ok(sync_one(db, session)))
    except Exception as exc:
        logger.exception("session_adapter failed")
        print(err(f"session_adapter failed: {exc}"))
        sys.exit(1)
    finally:
        try:
            db.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
