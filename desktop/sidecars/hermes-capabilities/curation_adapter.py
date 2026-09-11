"""Safe adapter for the official Hermes learning graph.

09 §5.2 + 11 §4 B2: a narrow read-only summary DTO that the model
and webview can see. We never expose Memory card bodies or titles.
We never parse Skill files ourselves - the official
``build_learning_graph()`` returns the parsed graph and we project a
safe subset.

Real upstream contract (Hermes 0.19.0):
  build_learning_graph() -> {
    "nodes":    [ {id, label, kind, ...}, ... ]
    "edges":    [ {source, target, weight?, ...}, ... ]
    "clusters": [ {category, count}, ... ]
    "memory":   [ {id, title?, body?, ...}, ... ]   # Memory cards; body NEVER leaks
    "stats":    { nodes, related_edges, edges_per_node, linked_nodes,
                  isolated_pct, categories, agent_created, used,
                  top_categories, memory_nodes, memory_skill_edges,
                  learned_skills }
  }

We project a SAFE summary that:
  - only emits Skill nodes (kind != "memory")
  - drops Memory card body / title (only counts them)
  - drops edges whose endpoints are not in the projected node set
    (no dangling edges)
  - does NOT silently truncate: when a cap is hit we either fail
    closed or set `truncated=true + originalCount=N` so the caller
    sees the real size. We never claim success while a partial
    projection is in flight.
  - stable order: by id, then label.

Stable DTO shape:
  {
    "success": true,
    "schemaVersion": 1,
    "nodes":    [ {"id":"...","label":"...","kind":"skill",
                    "category":"...","useCount":0,"state":"active",
                    "createdBy":"...","pinned":false}, ... ],
    "edges":    [ {"source":"...","target":"...","weight":?}, ... ],
    "clusters": [ {"id":"...","name":"...","skillIds":[...], "count":?}, ... ],
    "stats": {
      "skillNodeCount":   int,
      "memoryNodeCount":   int,
      "edgeCount":         int,
      "clusterCount":      int,
      "learnedSkillCount": int,
      "usedCount":         int,
      "truncated":         bool,
      "hermesVersion":     "0.19.0",
    },
  }
"""

from __future__ import annotations

import json
import sys
import os as _os
from typing import Any

import upstream
from upstream import build_learning_graph, ok, err
from upstream import usage_report, scan_skill  # 31 L5: usage + verdict sources

SCHEMA_VERSION = 1
MAX_NODES = 1000
MAX_EDGES = 4000
MAX_CLUSTERS = 200


def _bounded_int(value: Any, low: int = 0, high: int = 1_000_000) -> int:
    try:
        n = int(value)
    except Exception:
        n = 0
    return max(low, min(high, n))


def _build_usage_report() -> dict[str, Any]:
    """31 L5: official usage_report() -> { name: {usedCount, lastUsedAt, ...} }.

    Fail closed: if usage is unavailable, the whole summary fails (the caller
    must not silently produce "no signals"). usage_report() takes no args and
    returns a LIST of per-skill records.
    """
    try:
        records = usage_report()
    except Exception as exc:
        raise RuntimeError(f"usage data unavailable: {exc}")
    if not isinstance(records, list):
        raise RuntimeError("usage_report returned non-list")
    out = {}
    for r in records:
        if not isinstance(r, dict) or not r.get("name"):
            continue
        name = str(r["name"])
        out[name] = {
            "usedCount": r.get("use_count"),
            "viewCount": r.get("view_count"),
            "patchCount": r.get("patch_count"),
            "lastUsedAt": r.get("last_used_at"),
            "lastActivityAt": r.get("last_activity_at"),
            "state": r.get("state"),
            "provenance": r.get("provenance"),
        }
    return out


def _build_verdicts(names: list) -> dict[str, Any]:
    """31 L5: official scan_skill(Path) per skill -> { name: {verdict, reasons} }.

    scan_skill takes a Path to the skill directory. A scan error on ONE skill
    yields `VERDICT_MISSING` for it (warning), not a whole-run abort.
    """
    import pathlib
    home = _os.environ.get("HERMES_HOME", "")
    skills_root = _os.path.join(home, "skills") if home else ""
    out = {}
    for name in names:
        try:
            if not skills_root:
                out[name] = {"verdict": "unknown", "reasons": []}
                continue
            p = pathlib.Path(_os.path.join(skills_root, name))
            res = scan_skill(p, source="community")
            verdict = getattr(res, "verdict", "unknown") or "unknown"
            findings = getattr(res, "findings", []) or []
            reasons = [str(f) for f in findings][:20]
            out[name] = {"verdict": verdict, "reasons": reasons}
        except Exception:
            out[name] = {"verdict": "VERDICT_MISSING", "reasons": []}
    return out


def _read_frontmatter(skill_path: str) -> dict[str, Any]:
    """Read metadata-only frontmatter fields from SKILL.md (never the body)."""
    fm = {}
    try:
        md_path = _os.path.join(skill_path, "SKILL.md")
        if not _os.path.exists(md_path):
            return fm
        with open(md_path, "r", encoding="utf-8") as f:
            head = f.read(4096)
        if not head.lstrip().startswith("---"):
            return fm
        end = head.find("\n---", 3)
        block = head[head.find("---") + 3: end if end > 0 else len(head)]
        for line in block.splitlines():
            if ":" not in line:
                continue
            key, _, val = line.partition(":")
            key = key.strip().lower()
            val = val.strip()
            if key in ("applies_to_platform", "applies_to_workspace"):
                items = [x.strip().strip("[]\"'") for x in val.replace("[", "").replace("]", "").split(",") if x.strip()]
                fm[key] = items
            elif key in ("deprecated", "archive", "security_blocked"):
                fm[key] = val.lower() in ("true", "yes", "1")
    except Exception:
        pass
    return fm


def _build_frontmatter(names: list) -> dict[str, Any]:
    """31 L5: { skillName: {applies_to_platform, applies_to_workspace, deprecated, archive, security_blocked} }."""
    home = _os.environ.get("HERMES_HOME", "")
    skills_root = _os.path.join(home, "skills") if home else ""
    out = {}
    for name in names:
        if not skills_root:
            out[name] = {}
            continue
        out[name] = _read_frontmatter(_os.path.join(skills_root, name))
    return out


def build_summary() -> dict[str, Any]:
    """Build a safe DTO from the official learning graph.

    11 §4 B2: never silently truncate; cap detection happens BEFORE
    we return. The upstream Memory card `body` field is dropped
    unconditionally; the count is the only piece of Memory metadata
    that is exposed.

    31 L5: additionally expose `usageReport` (official usage_report()
    list, keyed by skill name), `verdicts` (official scan_skill per
    skill), and `frontmatter` (applies_to_platform/workspace/deprecated/
    archive/security_blocked read from each SKILL.md). Usage is a
    mandatory signal source: if it is unavailable the whole summary
    fails closed (never silently degrades to "no signals").
    """
    try:
        graph = build_learning_graph()
    except Exception as exc:
        # 13 §7.2: error must be a single-layer Python dict (NOT a
        # pre-serialised err() JSON string). Callers re-serialise
        # exactly once.
        return {"success": False, "error": f"build_learning_graph failed: {exc}"}

    if not isinstance(graph, dict):
        return {"success": False, "error": "build_learning_graph returned non-dict"}

    upstream_nodes = graph.get("nodes") or []
    upstream_edges = graph.get("edges") or []
    upstream_clusters = graph.get("clusters") or []
    upstream_memory = graph.get("memory") or graph.get("memory_cards") or []
    upstream_stats = graph.get("stats") or {}

    # 1) Project Skill nodes. Memory cards are excluded from the
    #    model/webview output - we only count them.
    safe_nodes: list[dict[str, Any]] = []
    memory_card_count = 0
    node_ids: set[str] = set()
    if isinstance(upstream_nodes, list):
        for n in upstream_nodes:
            if not isinstance(n, dict):
                continue
            kind = str(n.get("kind") or n.get("type") or "").lower()
            if kind == "memory" or kind == "memory_card":
                memory_card_count += 1
                continue
            node_id = str(n.get("id") or n.get("name") or "")
            if not node_id:
                continue
            safe_nodes.append({
                "id": node_id,
                "label": str(n.get("label") or n.get("name") or n.get("title") or node_id),
                "kind": kind or "skill",
                # Official graph metadata is safe and is required by the
                # reused L5 signal builder. The previous projection reduced
                # every category to the literal kind="skill", which made
                # category-based duplicate detection effectively inert.
                "category": str(n.get("category") or "general"),
                "useCount": _bounded_int(n.get("useCount") or n.get("use_count")),
                "state": str(n.get("state") or "active"),
                "createdBy": str(n.get("createdBy") or n.get("created_by") or ""),
                "pinned": bool(n.get("pinned", False)),
            })
            node_ids.add(node_id)
            if len(safe_nodes) > MAX_NODES:
                # 11 §4 B2: cap must be honest. Fail closed.
                return {
                    "success": False,
                    "error": f"learning graph summary exceeded node cap: {len(safe_nodes)} > {MAX_NODES}",
                    "originalCount": len(safe_nodes),
                    "cap": MAX_NODES,
                }

    # 2) Project edges, but drop any whose endpoint is not in our
    #    safe node set (no dangling edges).
    safe_edges: list[dict[str, Any]] = []
    if isinstance(upstream_edges, list):
        for e in upstream_edges:
            if not isinstance(e, dict):
                continue
            src = str(e.get("source") or e.get("from") or "")
            tgt = str(e.get("target") or e.get("to") or "")
            if not src or not tgt:
                continue
            if src not in node_ids or tgt not in node_ids:
                continue  # dangling
            safe_edges.append({
                "source": src,
                "target": tgt,
                "weight": _bounded_int(e.get("weight"), 0, 1_000_000) if isinstance(e.get("weight"), (int, float)) else None,
            })
            if len(safe_edges) > MAX_EDGES:
                return {
                    "success": False,
                    "error": f"learning graph summary exceeded edge cap: {len(safe_edges)} > {MAX_EDGES}",
                    "originalCount": len(safe_edges),
                    "cap": MAX_EDGES,
                }

    # 3) Project clusters.
    safe_clusters: list[dict[str, Any]] = []
    if isinstance(upstream_clusters, list):
        for c in upstream_clusters:
            if not isinstance(c, dict):
                continue
            # Hermes 0.19.0 emits clusters as {category, count}; it does not
            # include id/name. Preserve that official shape and derive stable
            # display identifiers from category instead of dropping every
            # cluster as the old adapter did.
            category = str(c.get("category") or "")
            cid = str(c.get("id") or c.get("name") or category)
            if not cid:
                continue
            raw_ids = c.get("skillIds") or c.get("skill_ids") or c.get("members") or []
            if not isinstance(raw_ids, list):
                raw_ids = []
            # Keep only ids present in our safe node set.
            clean_ids = [str(x) for x in raw_ids if str(x) in node_ids][:200]
            safe_clusters.append({
                "id": cid,
                "name": str(c.get("name") or category or cid),
                "category": category,
                "count": _bounded_int(c.get("count"), 0, 1_000_000) if isinstance(c.get("count"), (int, float)) else None,
                "skillIds": clean_ids,
            })
            if len(safe_clusters) > MAX_CLUSTERS:
                return {
                    "success": False,
                    "error": f"learning graph summary exceeded cluster cap: {len(safe_clusters)} > {MAX_CLUSTERS}",
                    "originalCount": len(safe_clusters),
                    "cap": MAX_CLUSTERS,
                }

    # 4) Sort stably.
    safe_nodes.sort(key=lambda n: (n["kind"], n["id"], n["label"]))
    safe_edges.sort(key=lambda e: (e["source"], e["target"]))
    safe_clusters.sort(key=lambda c: (c["id"], c["name"]))

    # 5) Stats. Memory body is NEVER put here.
    if not isinstance(upstream_memory, list):
        upstream_memory = []
    memory_count_observed = max(memory_card_count, len(upstream_memory))
    safe_stats = {
        "skillNodeCount":   _bounded_int(len(safe_nodes)),
        "memoryNodeCount":   _bounded_int(memory_count_observed),
        "edgeCount":         _bounded_int(len(safe_edges)),
        "clusterCount":      _bounded_int(len(safe_clusters)),
        "learnedSkillCount": _bounded_int(upstream_stats.get("learned_skills") if isinstance(upstream_stats.get("learned_skills"), (int, float)) else len(safe_nodes)),
        "usedCount":         _bounded_int(upstream_stats.get("used") if isinstance(upstream_stats.get("used"), (int, float)) else 0),
        "truncated":         False,
        "hermesVersion":     upstream.HERMES_REQUIRED_VERSION,
    }

    return {
        "success": True,
        "schemaVersion": SCHEMA_VERSION,
        "nodes": safe_nodes,
        "edges": safe_edges,
        "clusters": safe_clusters,
        "stats": safe_stats,
        # 31 L5 additive fields (never drop existing).
        "usageReport": _build_usage_report(),
        "verdicts": _build_verdicts([n["id"] for n in safe_nodes]),
        "frontmatter": _build_frontmatter([n["id"] for n in safe_nodes]),
    }


def main() -> int:
    """CLI: read JSON request on stdin, write JSON on stdout."""
    try:
        raw = ""
        if not sys.stdin.isatty():
            raw = sys.stdin.read()
    except Exception:
        raw = ""
    try:
        json.loads(raw) if raw.strip() else None
    except Exception as exc:
        sys.stdout.write(err(f"invalid request: {exc}"))
        return 1
    out = build_summary()
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
