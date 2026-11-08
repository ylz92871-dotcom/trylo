"""Expose Hermes' native compact index and foreground skill-load telemetry.

This adapter never instantiates AIAgent. The upstream index owns discovery,
conditional visibility, metadata parsing and its native snapshot cache; the
upstream telemetry functions own counters and locking. Skill contents, pending
proposals and the UI's list/view calls are unchanged.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys


# Exact Hermes 0.19.0 host-specific footer, replaced only when the host budget
# requested names-only presentation. Categories and skill names stay upstream-owned.
_CODING_COMPACT_FOOTER = (
    "\n(Categories marked [names only] are outside the current coding "
    "context, so their descriptions are omitted — the skills work "
    "normally and load with skill_view(name) as usual.)"
)
_BUDGET_COMPACT_FOOTER = (
    "\n(Categories marked [names only] omit descriptions to fit the Trylo "
    "skill-index budget. Every skill name remains visible; load with "
    "skill_view(name) or use skills_list() for full descriptions.)"
)


def _prompt_chars(text: str) -> int:
    # Match the JavaScript host's string.length, including astral characters.
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


def _all_compact_categories(builder) -> frozenset[str]:
    from agent.skill_utils import get_all_skills_dirs, iter_skill_index_files

    categories = set()
    for root in get_all_skills_dirs():
        for skill_file in iter_skill_index_files(root, "SKILL.md"):
            # In the pinned helper category is derived only from this path.
            # No metadata/body read or alternative category parser is needed.
            entry = builder._build_snapshot_entry(skill_file, root, {}, "")
            categories.add(entry["category"].split("/", 1)[0])
    return frozenset(categories)


def _string_set(request: dict, key: str) -> set[str] | None:
    value = request.get(key)
    if value is None:
        return None
    if not isinstance(value, list) or len(value) > 2048:
        raise ValueError("invalid tools")
    if any(not isinstance(item, str) or len(item) > 256 for item in value):
        raise ValueError("invalid tool name")
    return set(value)


def dispatch(request: dict, upstream) -> dict:
    version = json.loads(upstream.require_version())
    if not version.get("success"):
        return {"success": False, "code": "hermes_version_unavailable"}

    operation = request.get("op")
    if operation == "central_origin":
        from central_provenance import dispatch as central_origin

        return central_origin(request, upstream)
    if operation == "context":
        from agent import prompt_builder

        maximum = request.get("maxPromptChars")
        if maximum is not None and (type(maximum) is not int or maximum < 1 or maximum > 1_000_000):
            return {"success": False, "code": "hermes_context_invalid"}
        visibility = {"available_tools": _string_set(request, "availableTools"), "available_toolsets": _string_set(request, "availableToolsets")}
        # 0.19.0's disk snapshot omits environments and its warm renderer does
        # not reapply that gate. Freeze a fresh native scan for this task rather
        # than silently making environment-ineligible skills visible.
        prompt_builder.clear_skills_system_prompt_cache(clear_snapshot=True)
        prompt = prompt_builder.build_skills_system_prompt(**visibility)
        if not isinstance(prompt, str):
            return {"success": False, "code": "hermes_context_invalid"}
        compacted = maximum is not None and _prompt_chars(prompt) > maximum
        if compacted:
            # A budget changes presentation only. Let the official renderer
            # keep all names before the host resorts to incomplete-index fallback.
            categories = _all_compact_categories(prompt_builder)
            prompt_builder.clear_skills_system_prompt_cache(clear_snapshot=True)
            prompt = prompt_builder.build_skills_system_prompt(
                **visibility, compact_categories=categories
            )
            if not isinstance(prompt, str):
                return {"success": False, "code": "hermes_context_invalid"}
        upstream_hash = "sha256:" + hashlib.sha256(prompt.encode("utf-8")).hexdigest()
        if compacted and prompt.endswith(_CODING_COMPACT_FOOTER):
            prompt = prompt[:-len(_CODING_COMPACT_FOOTER)] + _BUDGET_COMPACT_FOOTER
        return {
            "success": True,
            "prompt": prompt,
            "upstreamPromptHash": upstream_hash,
        }

    if operation == "record_view":
        name = request.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 512:
            return {"success": False, "code": "hermes_usage_invalid"}
        from tools.skill_usage import bump_use, bump_view, load_usage

        # Match the official skill_view registry handler, which records a
        # successful instruction load as both view and use. These counters do
        # not assert that applying the instructions solved the user's task.
        previous = load_usage().get(name, {})
        previous_views = int(previous.get("view_count") or 0)
        previous_uses = int(previous.get("use_count") or 0)
        bump_view(name)
        bump_use(name)
        current = load_usage().get(name, {})
        # Native bumps are best-effort. Surface a failed persistence attempt
        # without converting the successful foreground tool read to failure.
        if int(current.get("view_count") or 0) <= previous_views or int(current.get("use_count") or 0) <= previous_uses:
            return {"success": False, "code": "hermes_usage_not_recorded"}
        return {"success": True}

    return {"success": False, "code": "hermes_context_unknown_operation"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--capabilities-dir", required=True)
    args = parser.parse_args()
    try:
        capabilities = Path(args.capabilities_dir).resolve(strict=True)
        if not (capabilities / "upstream.py").is_file():
            raise ValueError("missing upstream adapter")
        sys.path.insert(0, str(capabilities))
        import upstream

        raw = sys.stdin.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("input limit")
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("invalid request")
        result = dispatch(request, upstream)
    except Exception:
        # Exceptions may contain local paths or user content. The parent owns
        # diagnostics through these fixed codes, never raw dependency errors.
        result = {"success": False, "code": "hermes_native_context_unavailable"}
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
