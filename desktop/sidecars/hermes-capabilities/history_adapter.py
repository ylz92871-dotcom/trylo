""""Narrowed, threat-free history evidence for L4 cross-session mining.

Thin adapter that calls the official Hermes 0.19.0
`tools.session_search_tool.session_search` (re-exported via `upstream`)
and narrows each discovery hit into a minimal DTO (24 §4.1 / 30 §4.1).

We do NOT write SQL / FTS / tokenizer; the official engine owns search.
We do NOT pass conversation body to a model; the Node control-plane
aggregator only ever sees the narrowed DTO below.

Output is a single-line JSON object:
  {
    "ok": true,
    "results": [{
        "sessionId", "turnId", "workspace", "timestamp", "role",
        "taskSummary",        # <=200 chars, secret-redacted
        "resultOutcome",      # success|failure|partial|unknown
        "verification",       # [] (search does not expose review resolution)
        "relativeFileHints",  # <=5 relative paths
        "toolCategories",     # deduped
        "evidenceHash",       # sha256(canonical(DTO_minus_hash))
    }],
    "queryPlan": [{"query", "reason", "resultCount"}],
    "truncated": bool
  }

On any failure -> {"ok": false, "error": "..."} and exit 1. Never writes
to any Hermes store.

30 §1.3 / §3.2: the canonical rule for evidenceHash MUST be byte-identical
with learning-loop/history-mining/provenance.js.
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
from upstream import ok, err, require_version

SCHEMA_VERSION = 1
MAX_TASK_SUMMARY = 200
MAX_FILE_HINTS = 5
MAX_QUERY_LEN = 256
MAX_RESULTS_PER_QUERY = 50

# Whitelist for the narrowed DTO. Order does not matter (canonical sorts
# keys), but this is the authoritative field set.
DTO_WHITELIST = [
    "sessionId", "turnId", "timestamp", "role", "taskSummary",
    "resultOutcome", "verification", "relativeFileHints", "toolCategories",
]
ARRAY_FIELDS = {"relativeFileHints", "toolCategories"}


# ---------------------------------------------------------------------------
# 32 G0-C: cross-workspace path normalization + SessionDB cwd cache
# ---------------------------------------------------------------------------
import sys as _sys


def _normalize_path_for_compare(p):
    """32 G0-C: canonicalize a path for cross-workspace comparison.

    On Windows: normcase + normpath (case-insensitive, separator-agnostic).
    On POSIX:   normpath only (case-sensitive, separator-agnostic).

    Empty / None / non-string -> ''. Callers must treat '' as 'no scope given'
    and skip the cross-check (backward compat).
    """
    if not isinstance(p, str):
        return ''
    s = p.strip()
    if not s:
        return ''
    import os as _os
    n = _os.path.normpath(s)
    if _sys.platform.startswith('win'):
        n = _os.path.normcase(n)
    return n


def _build_cwd_cache(hermes_home, session_ids):
    """32 G0-C: open SessionDB once, fetch cwd for every distinct session_id.

    Returns {session_id: normalized_cwd_or_empty_str}. Empty string means
    'cwd is missing in SessionDB' (fail-closed sentinel: caller MUST skip
    the hit, never let it through).
    """
    cache = {sid: '' for sid in session_ids}
    if not session_ids:
        return cache
    if hermes_home:
        os.environ['HERMES_HOME'] = hermes_home
    try:
        from hermes_state import SessionDB
        db = SessionDB()
        try:
            for sid in session_ids:
                sess = db.get_session(sid)
                if sess is None:
                    continue  # already '' in cache; fail-closed
                cwd = sess.get('cwd') if isinstance(sess, dict) else None
                cache[sid] = _normalize_path_for_compare(cwd) if cwd else ''
        finally:
            try:
                db.close()
            except Exception:
                pass
    except Exception as exc:
        # 32 G0-C: if SessionDB cannot be opened (DB missing, lock, etc.),
        # the whole query fails closed. We DO NOT silently degrade to
        # 'permit all hits' — that would re-introduce the very leak G0 fixes.
        raise RuntimeError(f'SessionDB unavailable for cwd cross-check: {exc}')
    return cache

# ---------------------------------------------------------------------------
# canonical (30 §3.2) — MUST match provenance.js
# ---------------------------------------------------------------------------
def _json_str(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _canonical_value(value: Any) -> str:
    if value is None:
        return _json_str("")
    if isinstance(value, str):
        return _json_str(value.strip())
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        # integral floats serialize as integers so Python and Node agree
        if isinstance(value, float) and value.is_integer():
            return str(int(value))
        return str(value)
    if isinstance(value, list):
        return "[" + ",".join(_json_str(x) for x in sorted(value, key=str)) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            _json_str(k) + ":" + _canonical_value(value[k]) for k in sorted(value)
        ) + "}"
    return _json_str(str(value))


def _canonical_evidence(ev: dict) -> str:
    pairs = []
    for key in DTO_WHITELIST:
        if key in ev and ev[key] is not None:
            pairs.append(key + "=" + _canonical_value(ev[key]))
    return "\n".join(pairs)


def _evidence_hash(ev: dict) -> str:
    copy = {k: ev[k] for k in DTO_WHITELIST if k in ev}
    return "sha256:" + hashlib.sha256(_canonical_evidence(copy).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# secret redaction (mirror learning-loop/evidence-builder.js _stripSecrets)
# ---------------------------------------------------------------------------
_SECRET_PATTERNS = [
    (r"\b(sk-[a-zA-Z0-9]{20,})\b", "sk-…"),
    (r"\b(AKIA[0-9A-Z]{16})\b", "AKIA…"),
    (r"\b(gh[pousr]_[A-Za-z0-9]{36,})\b", "gh…"),
    (r"\b(Bearer\s+)([A-Za-z0-9._\-]{8,})", r"\1[REDACTED]"),
    (r"\b(api[_-]?key\s*[:=]\s*)([^\s,;]{8,})", r"\1[REDACTED]"),
    (r"\b(token\s*[:=]\s*)([^\s,;]{8,})", r"\1[REDACTED]"),
    (r"\b(password\s*[:=]\s*)([^\s,;]{3,})", r"\1[REDACTED]"),
    (r"\b(secret\s*[:=]\s*)([^\s,;]{3,})", r"\1[REDACTED]"),
    (r"\b(credential[s]?\s*[:=]\s*)([^\s,;]{3,})", r"\1[REDACTED]"),
]


def _strip_secrets(text: str) -> str:
    if not text:
        return ""
    for pat, repl in _SECRET_PATTERNS:
        text = re.sub(pat, repl, text, flags=re.IGNORECASE)
    return text


# ---------------------------------------------------------------------------
# lightweight signal detection (keyword heuristics, NOT FTS/parser)
# ---------------------------------------------------------------------------
def _detect_outcome(content: str) -> str:
    """Lightweight outcome detection from a content snippet.

    31 F3 (audit P1-4): explicitly check failure keywords FIRST so an error
    message that incidentally contains 'success' / 'done' is not mis-classified
    as success. Order of the two passes is the fix; the keyword sets are the
    same. A negation guard handles success statements that mention an error in
    the negative ("completed without error", "no exceptions") so they are not
    mis-classified as failure.
    """
    low = (content or "").lower()
    # negation guard: "without error" / "no error" / "no failures" / "no
    # exceptions" are SUCCESS statements, not failures.
    negated = (
        "without error" in low or "no error" in low or
        "no failures" in low or "no exceptions" in low or "no errors" in low
    )
    if not negated:
        # failure pass: if any hard-failure keyword is present, classify as
        # failure regardless of success-sounding words.
        if any(k in low for k in ("failed", "failure", "error", "exception", "timeout", "traceback")):
            return "failure"
    if any(k in low for k in ("partial", "incomplete", "partially")):
        return "partial"
    if any(k in low for k in ("succeeded", "success", "completed", "done", "fixed")):
        return "success"
    return "unknown"


def _detect_file_hints(content: str) -> list:
    """Extract up to 5 relative file paths from backtick-quoted tokens.

    Kept deliberately conservative: only tokens that look like a relative
    path (no drive letter, no leading slash, has a file extension). Does
    NOT walk the filesystem and never emits absolute paths.
    """
    out = []
    for m in re.finditer(r"`([^`]+)`", content or ""):
        tok = m.group(1).strip()
        if not tok or tok.startswith("/") or re.match(r"^[a-zA-Z]:[\\/]", tok):
            continue
        if "/" not in tok and "\\" not in tok:
            continue
        if not re.search(r"\.\w{1,10}$", tok):
            continue
        norm = tok.replace("\\", "/")
        if len(out) >= MAX_FILE_HINTS:
            break
        if norm not in out:
            out.append(norm)
    return out


_TOOL_CATEGORY_WORDS = {
    "search": ["search", "grep", "rg", "find"],
    "read": ["read", "view", "cat", "open"],
    "edit": ["edit", "patch", "replace"],
    "write": ["write", "create", "save"],
    "command": ["bash", "shell", "run", "npm", "node", "python"],
    "verify": ["verify", "check", "lint"],
    "test": ["test", "spec", "assert"],
}


def _detect_tool_categories(messages) -> list:
    """Deduped tool categories from the message set (best-effort)."""
    found = []
    text = " ".join(
        str(m.get("content", "")) for m in (messages or []) if isinstance(m, dict)
    ).lower()
    for cat, words in _TOOL_CATEGORY_WORDS.items():
        if any(w in text for w in words):
            found.append(cat)
    return found


# ---------------------------------------------------------------------------
# narrowing
# ---------------------------------------------------------------------------
def _narrow_result(hit: dict, workspace: str) -> dict | None:
    if not hit or not isinstance(hit, dict):
        return None
    sid = str(hit.get("session_id") or "")
    msg_id = hit.get("match_message_id")
    if not sid or msg_id is None:
        return None
    # matched message (from discovery messages array)
    messages = hit.get("messages") or []
    matched = None
    for m in messages:
        if isinstance(m, dict) and str(m.get("id")) == str(msg_id):
            matched = m
            break
    content = str(matched.get("content", "")) if matched else str(hit.get("snippet", ""))
    role = str(matched.get("role", "")) if matched else str(hit.get("matched_role", ""))
    ts = matched.get("timestamp") if matched else hit.get("when")
    ts_ms = _to_ms(ts)

    task_summary = _strip_secrets(content).replace("\n", " ")[:MAX_TASK_SUMMARY]
    tool_categories = _detect_tool_categories(messages)
    file_hints = _detect_file_hints(content)[:MAX_FILE_HINTS]

    dto = {
        "sessionId": sid,
        "turnId": str(msg_id),
        "workspace": workspace,
        "timestamp": ts_ms,
        "role": role,
        "taskSummary": task_summary,
        "resultOutcome": _detect_outcome(content),
        "verification": [],
        "relativeFileHints": file_hints,
        "toolCategories": tool_categories,
    }
    dto["evidenceHash"] = _evidence_hash(dto)
    return dto


def _to_ms(ts) -> int:
    """Normalise a Hermes timestamp (epoch s or ms, or ISO string) to ms."""
    if ts is None:
        return 0
    if isinstance(ts, (int, float)):
        return int(ts * 1000) if ts < 1e12 else int(ts)  # s -> ms, ms stays
    if isinstance(ts, str):
        try:
            f = float(ts)
            return int(f * 1000) if f < 1e12 else int(f)
        except ValueError:
            return 0
    return 0


def build_results(hermes_home: str, queries: list, limit: int = None) -> dict:
    version_check = json.loads(require_version())
    if not version_check.get("success"):
        return {"ok": False, "error": version_check.get("error", "version mismatch")}

    if hermes_home:
        os.environ["HERMES_HOME"] = hermes_home

    if not isinstance(queries, list) or not queries:
        return {"ok": False, "error": "no queries"}

    results = []
    query_plan = []
    truncated = False

    # 32 G0-C: pre-normalize each query's expectedScope.workspacePath so we
    # only compare once per query. '' means 'no scope given' (backward compat).
    normalized_scopes = []
    for q in queries:
        scope = q.get("expectedScope") or {}
        normalized_scopes.append(_normalize_path_for_compare(scope.get("workspacePath", "")))

    for query_idx, q in enumerate(queries):
        query = str(q.get("query", "")).strip()[:MAX_QUERY_LEN]
        reason = str(q.get("reason", ""))
        workspace = str((q.get("expectedScope") or {}).get("workspace", ""))
        if not query:
            continue
        try:
            raw = upstream.session_search(
                query=query,
                limit=limit or 3,
                # NOTE: no `profile=` — the default profile filters out
                # trylo-vscode source sessions (verified on-site: profile='default'
                # returns 0 results for a seeded trylo-vscode session). History
                # mining must search across all interactive sessions.
            )
            parsed = json.loads(raw) if isinstance(raw, str) else raw
        except Exception as exc:  # pragma: no cover - surfaced
            return {"ok": False, "error": f"session_search failed for {query!r}: {exc}"}

        if not isinstance(parsed, dict) or parsed.get("success") is not True:
            # 32 G0-C (T14b): session_search returned non-success (e.g. "Session
            # database not available"). Fail CLOSED — do NOT swallow into
            # ok:true with 0 results, which would be a silent allow-all (the
            # very leak G0 fixes). The caller must see the failure.
            return {
                "ok": False,
                "error": (parsed.get("error") if isinstance(parsed, dict) and parsed.get("error") else "session_search failed"),
            }

        hits = parsed.get("results") or []

        # 32 G0-C: the REAL cross-workspace gate. The upstream hit has no
        # workspace field (per §2.2 probe), so we resolve each hit's actual
        # workspace from SessionDB.get_session(sid).cwd and compare to the
        # caller's expectedScope.workspacePath. cwd missing / wrong / session
        # missing -> fail-closed skip. This replaces the 31 F1 structural
        # no-op (which could not filter because the hit had no workspace field).
        scope_path = normalized_scopes[query_idx] if query_idx < len(normalized_scopes) else ''
        scope_active = bool(scope_path)

        # Pre-pass: collect distinct session_ids from this query's hits so we
        # open SessionDB once (per query) and fetch cwd for all of them.
        q_session_ids = set()
        hit_sids = []
        for hit in hits:
            sid = str((hit or {}).get("session_id") or "")
            if sid:
                hit_sids.append(sid)
                q_session_ids.add(sid)
        cwd_cache = _build_cwd_cache(hermes_home, q_session_ids) if (scope_active and q_session_ids) else {}

        if len(results) + len(hits) > MAX_RESULTS_PER_QUERY:
            truncated = True
        skipped_cross_ws = 0
        for hit_i, hit in enumerate(hits[: MAX_RESULTS_PER_QUERY - len(results)]):
            sid = hit_sids[hit_i] if hit_i < len(hit_sids) else ''
            # 32 G0-C: the cross-workspace gate. If caller gave a scope, every
            # hit MUST come from that scope; cwd missing or wrong == skip.
            if scope_active:
                actual = cwd_cache.get(sid, '')
                if not actual or actual != scope_path:
                    skipped_cross_ws += 1
                    continue
            dto = _narrow_result(hit, workspace)
            if dto:
                # 32 G0-C: DTO.workspace is the (verified) caller scope label;
                # workspacePath carries the normalized verified cwd. Additive,
                # non-breaking — old callers reading `workspace` are unchanged.
                if scope_active and sid in cwd_cache and cwd_cache[sid]:
                    dto['workspacePath'] = cwd_cache[sid]
                results.append(dto)
        query_plan.append({
            "query": query, "reason": reason,
            "resultCount": len(hits),
            "skippedCrossWorkspace": skipped_cross_ws,
        })

    return {
        "ok": True,
        "schemaVersion": SCHEMA_VERSION,
        "results": results,
        "queryPlan": query_plan,
        "truncated": truncated,
    }


def main() -> int:
    try:
        raw = sys.stdin.read()
        request = json.loads(raw) if raw.strip() else {}
    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": f"invalid request JSON: {exc}"}, ensure_ascii=False))
        return 1

    hermes_home = str(request.get("hermes_home") or os.environ.get("HERMES_HOME") or "")
    queries = request.get("queries") or []
    limit = request.get("limit")
    out = build_results(hermes_home=hermes_home, queries=queries, limit=limit)
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())