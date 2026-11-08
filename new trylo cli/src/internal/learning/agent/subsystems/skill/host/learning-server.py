#!/usr/bin/env python3
"""Review-only Hermes MCP bridge; the legacy server still owns staging.

Run one process per review with --capabilities-dir pointing at the pinned
vendor directory. A persistent Context carries Hermes' native origin and
read-before-write marks across MCP request tasks. No active skill is written
here. Multiple pending operations remain independent approvals: create must
be approved before its supporting-file proposals can be applied.
"""

from __future__ import annotations

import argparse
import contextvars
import importlib.util
import json
import os
import sys
from pathlib import Path
from types import ModuleType
from typing import Any
from view_transport import require_view_max_bytes, view_reply_fits


_REVISION_ACTIONS = frozenset({"create", "edit", "patch", "write_file", "remove_file"})


class ReviewTools:
    """Preserve upstream guards without depending on MCP task-local context."""

    def __init__(self, server: ModuleType, mode: str = "implicit", max_view_bytes: int | None = None,
                 review_origin: str = "native") -> None:
        from tools import skill_manager_tool as native
        from tools.skill_provenance import set_current_write_origin

        if mode not in {"implicit", "explicit"}:
            raise ValueError("review mode must be implicit or explicit")
        if review_origin not in {"native", "central_research"} or (review_origin == "central_research" and mode != "explicit"):
            raise ValueError("invalid trusted review origin")
        self._server = server
        self._max_view_bytes = max_view_bytes
        self._native = native
        self._view = server._skill_view
        self._manage = server._skill_manage
        self._context = contextvars.Context()
        # Prompt authoring mode is not authorship. Only the managed host may
        # supply central_research after resolving the original Board request.
        # Ordinary explicit /learn retains foreground/user ownership.
        self._context.run(set_current_write_origin, "background_review"
                          if mode == "implicit" or review_origin == "central_research" else "assistant_tool")
        self._context.run(native._reset_background_review_read_marks)
        self._created_pending: set[str] = set()

    def view(self, name: str, file_path: str | None = None) -> str:
        # Upstream marks the path while reading. Retain that mark only when
        # the complete, successful response can actually reach the reviewer.
        previous = self._context.copy()
        try:
            result = self._context.run(
                self._view, name=name, file_path=file_path, preprocess=False
            )
            parsed = json.loads(result)
        except Exception:
            self._context = previous
            raise
        if not isinstance(parsed, dict) or not parsed.get("success"):
            self._context = previous
            return result
        if not isinstance(parsed.get("content"), str):
            self._context = previous
            return self._server.err("HERMES_REVIEW_VIEW_INVALID: skill content was not returned")
        if not view_reply_fits(result, self._server.MAX_TOOL_CHARS, self._max_view_bytes):
            self._context = previous
            return self._server.err(
                "HERMES_REVIEW_VIEW_TOO_LARGE: full skill content exceeds the review tool limit; "
                "the target has not been admitted as read"
            )
        return result

    def manage(self, action: str, name: str, **kwargs: Any) -> str:
        if action not in _REVISION_ACTIONS:
            return self._server.err(
                "HERMES_REVIEW_ACTION_DENIED: review may create or revise skills; "
                "skill deletion, archive, approval and rollback are unavailable"
            )
        return self._context.run(self._propose, action, name, kwargs)

    def _propose(self, action: str, name: str, kwargs: dict[str, Any]) -> str:
        guard = self._native._background_review_preflight(action, name)
        if guard is not None:
            return json.dumps(guard, ensure_ascii=False)
        if action == "create":
            guard = self._pending_create_guard(name)
            if guard is not None:
                return json.dumps(guard, ensure_ascii=False)
        error = self._validate_proposal(action, name, kwargs)
        if error is not None:
            return self._server.err(error)
        guard = self._read_guard(action, name, kwargs.get("file_path"))
        if guard is not None:
            return json.dumps(guard, ensure_ascii=False)
        # Called by legacy skill_propose after its fail-closed approval check.
        # The official skill_manage gate produces the native pending payload.
        result = self._manage(action=action, name=name, **kwargs)
        parsed = json.loads(result)
        if not isinstance(parsed, dict) or not parsed.get("success"):
            return result
        pending_id = parsed.get("pending_id")
        if not parsed.get("staged") or not isinstance(pending_id, str):
            return self._server.err("HERMES_REVIEW_NOT_STAGED: native proposal was not staged")
        pending = self._server._wa.get_pending("skills", pending_id)
        expected = {"action": action, "name": name}
        expected.update({key: value for key, value in kwargs.items() if value is not None})
        if not isinstance(pending, dict) or pending.get("payload") != expected:
            return self._server.err(
                "HERMES_REVIEW_PENDING_UNCONFIRMED: native pending payload could not be confirmed"
            )
        if action == "create":
            self._created_pending.add(name)
        return result

    def _pending_create_guard(self, name: str) -> dict[str, Any] | None:
        # This prevents sequential reviews from re-proposing the same unapproved
        # create. Native read-then-stage is not a cross-process atomic name lock.
        try:
            pending = self._server._wa.list_pending("skills")
        except Exception:
            return {"success": False, "code": "HERMES_REVIEW_PENDING_UNAVAILABLE", "error": "Native skill proposals could not be read"}
        if not isinstance(pending, list):
            return {"success": False, "code": "HERMES_REVIEW_PENDING_UNAVAILABLE", "error": "Native skill proposals did not return a list"}
        for item in pending:
            payload = item.get("payload") if isinstance(item, dict) else None
            if isinstance(payload, dict) and payload.get("action") == "create" and payload.get("name") == name:
                return {"success": False, "code": "HERMES_REVIEW_CREATE_PENDING",
                    "error": "A create proposal for this skill is awaiting approval; resolve it before proposing another create",
                    "existingPendingId": item.get("id")}
        return None

    def _validate_proposal(self, action: str, name: str, args: dict[str, Any]) -> str | None:
        """Use native validators before staging, where upstream otherwise defers them."""
        native = self._native
        error = native._validate_name(name)
        if error:
            return error
        existing = native._find_skill(name)
        if action == "create" and (existing or name in self._created_pending):
            return "A skill or a create proposal with this name already exists; revise the existing skill."
        if action != "create" and not existing:
            if action != "write_file" or name not in self._created_pending:
                return "Skill does not exist. Approve its create proposal before patching or removing files."
        if action == "create":
            error = native._validate_category(args.get("category"))
            if error:
                return error
        if action in {"create", "edit"}:
            content = args.get("content")
            if not isinstance(content, str):
                return "content is required for create/edit."
            error = native._validate_frontmatter(content) or native._validate_content_size(content)
            if error:
                return error
        file_path = args.get("file_path")
        if action in {"write_file", "remove_file"} or file_path is not None:
            error = native._validate_file_path(file_path)
            if error:
                return error
        if action == "remove_file" and Path(file_path).name == "SKILL.md":
            return "The main SKILL.md cannot be removed by review; revise it with patch or edit."
        if action == "remove_file" and existing:
            target, error = native._resolve_skill_target(existing["path"], file_path)
            if error:
                return error
            if target is not None and target.resolve() == (existing["path"] / "SKILL.md").resolve():
                return "The main SKILL.md cannot be removed by review; revise it with patch or edit."
        if action == "write_file":
            content = args.get("file_content")
            if not isinstance(content, str):
                return "file_content is required for write_file."
            if len(content.encode("utf-8")) > native.MAX_SKILL_FILE_BYTES:
                return "Supporting file exceeds the native byte limit."
            return native._validate_content_size(content, label=file_path)
        if action == "patch":
            if not isinstance(args.get("old_string"), str) or not args["old_string"]:
                return "old_string is required for patch."
            if not isinstance(args.get("new_string"), str):
                return "new_string is required for patch."
        return None

    def _read_guard(self, action: str, name: str, file_path: str | None) -> dict[str, Any] | None:
        if action == "create":
            return None
        existing = self._native._find_skill(name)
        # A new supporting file can stage behind a create in this review.
        # It is not readable or applicable until that create is approved.
        if not existing:
            return None
        skill_dir = existing["path"]
        if action == "edit" or file_path is None:
            target, label = skill_dir / "SKILL.md", "SKILL.md"
        else:
            target, error = self._native._resolve_skill_target(skill_dir, file_path)
            if error:
                return {"success": False, "error": error}
            assert target is not None
            label = file_path
        if action == "write_file" and not target.exists():
            return None
        return self._native._background_review_read_before_write_guard(name, target, action, label)


def install_learning_guards(server: ModuleType, mode: str = "implicit", max_view_bytes: int | None = None,
                            review_origin: str = "native") -> ReviewTools:
    tools = ReviewTools(server, mode, max_view_bytes, review_origin)
    server._skill_view = tools.view
    server._skill_manage = tools.manage
    return tools


def install_skill_listing(server: ModuleType, max_bytes: int | None = None) -> None:
    spec = importlib.util.spec_from_file_location("trylo_hermes_skill_listing", Path(__file__).with_name("skill-listing.py"))
    if spec is None or spec.loader is None:
        raise ImportError("skill listing adapter is missing")
    listing = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = listing
    spec.loader.exec_module(listing)
    listing.install_skill_listing(server, max_bytes)


def load_legacy_server(capabilities_dir: Path) -> ModuleType:
    if not capabilities_dir.is_absolute():
        raise ValueError("capabilities-dir must be absolute")
    directory = capabilities_dir.resolve(strict=True)
    server_path = directory / "server.py"
    if not server_path.is_file() or not (directory / "upstream.py").is_file():
        raise ValueError("capabilities-dir does not contain the pinned Hermes adapter")
    # This entrypoint never advertises normal-profile memory or admin tools.
    os.environ["TRYLO_MCP_PROFILE"] = "learning"
    sys.path.insert(0, str(directory))
    spec = importlib.util.spec_from_file_location("trylo_hermes_review_legacy", server_path)
    if spec is None or spec.loader is None:
        raise ImportError("could not load the pinned Hermes adapter")
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    return server


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capabilities-dir", required=True, type=Path)
    parser.add_argument("--review-mode", choices=("implicit", "explicit"), default="implicit")
    parser.add_argument("--review-origin", choices=("native", "central_research"), default="native")
    args = parser.parse_args()
    max_view_bytes = require_view_max_bytes()
    server = load_legacy_server(args.capabilities_dir)
    install_learning_guards(server, args.review_mode, max_view_bytes, args.review_origin)
    install_skill_listing(server, max_view_bytes)
    server.main()


if __name__ == "__main__":
    main()
