"""Unified import, version check and error normalization for Hermes 0.19.0.

This is the single module that knows the Hermes upstream API surface the Trylo
MCP server reuses. MCP handlers in ``server.py`` import upstream symbols
through here; no business logic lives in this module and no Hermes behaviour
is re-implemented.

Reused symbols (see Hermes fusion architecture section 3.2 / 5.1):

    MemoryStore, memory_tool, apply_memory_pending   (tools.memory_tool)
    scan_for_threats, first_threat_message            (tools.threat_patterns)
    scan_skill, should_allow_install, full_content_hash (tools.skills_guard)
    skills_list, skill_view                           (tools.skills_tool)
    skill_manage, apply_skill_pending                 (tools.skill_manager_tool)
    session_search                                    (tools.session_search_tool)
    write_approval (stage_write / list_pending / ...) (tools.write_approval)
    SessionDB                                         (hermes_state)
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger("hermes-capabilities")

HERMES_REQUIRED_VERSION = "0.19.0"


def ok(payload: dict[str, Any] | None = None, **extra: Any) -> str:
    """Build a success JSON string. Never raises."""
    body = {"success": True}
    if payload:
        body.update(payload)
    body.update(extra)
    return json.dumps(body, ensure_ascii=False)


def err(message: str, **extra: Any) -> str:
    """Build an error JSON string. Never raises."""
    body = {"success": False, "error": str(message)}
    body.update(extra)
    return json.dumps(body, ensure_ascii=False)


def require_version() -> str:
    """Return ok() JSON if the installed hermes-agent matches the pinned
    version, otherwise an err() JSON. Called once at server startup."""
    try:
        import importlib.metadata as md

        version = md.version("hermes-agent")
    except Exception as exc:  # pragma: no cover - environment failure
        return err(f"hermes-agent version check failed: {exc}")
    if version != HERMES_REQUIRED_VERSION:
        return err(
            f"hermes-agent {version} is installed; this adapter pins "
            f"{HERMES_REQUIRED_VERSION}. Reinstall with "
            f"`uv pip install --python <py> hermes-agent[mcp]=={HERMES_REQUIRED_VERSION}`.",
            installed=version,
            required=HERMES_REQUIRED_VERSION,
        )
    return ok(version=version)


# ---------------------------------------------------------------------------
# Upstream re-exports. Importing these at module load fails fast and loudly if
# the Hermes environment is missing -- the Claude CLI then starts without the
# trylo-hermes-capabilities tools, which is the intended graceful degradation.
# ---------------------------------------------------------------------------
from tools.memory_tool import (  # noqa: E402
    MemoryStore,
    memory_tool,
    apply_memory_pending,
    load_on_disk_store,
    MEMORY_SCHEMA,
    MEMORY_BLOCK_HEADERS,
)
from tools.threat_patterns import (  # noqa: E402
    scan_for_threats,
    first_threat_message,
)
from tools.skills_guard import (  # noqa: E402
    scan_skill,
    should_allow_install,
    full_content_hash,
)
from tools.skills_tool import skills_list, skill_view  # noqa: E402
from tools.skill_manager_tool import skill_manage, apply_skill_pending  # noqa: E402
from tools.session_search_tool import session_search  # noqa: E402
from tools import write_approval as write_approval  # noqa: E402
from hermes_state import SessionDB  # noqa: E402
# 09 §5.1: L3 re-exports. The Trylo side imports these by name; the
# adapter only forwards the official outputs. We do NOT re-export
# agent.curator.run_curator_review / maybe_run_curator / AIAgent —
# those start a second model loop and are explicitly excluded.
from agent.learning_graph import build_learning_graph  # noqa: E402
from tools.skill_usage import (  # noqa: E402
    load_usage,
    usage_report,
    provenance,
    set_pinned,
)
from agent.curator_backup import (  # noqa: E402
    snapshot_skills,
    list_backups,
    rollback,
)

__all__ = [
    "ok",
    "err",
    "require_version",
    "MemoryStore",
    "memory_tool",
    "apply_memory_pending",
    "load_on_disk_store",
    "MEMORY_SCHEMA",
    "MEMORY_BLOCK_HEADERS",
    "scan_for_threats",
    "first_threat_message",
    "scan_skill",
    "should_allow_install",
    "full_content_hash",
    "skills_list",
    "skill_view",
    "skill_manage",
    "apply_skill_pending",
    "session_search",
    "write_approval",
    "SessionDB",
    # 09 §5.1: L3 exports
    "build_learning_graph",
    "load_usage",
    "usage_report",
    "provenance",
    "set_pinned",
    "snapshot_skills",
    "list_backups",
    "rollback",
]
