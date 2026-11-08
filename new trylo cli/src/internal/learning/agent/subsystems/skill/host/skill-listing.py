"""Bounded JSON transport over the original, ordered Hermes skill catalogue.

No metadata scanning, ranking or persistent catalogue is added. Small default
responses remain byte-for-byte native; pagination only changes transport.
snapshotHash fingerprints the metadata returned by the native list, not skill
file contents, approval payloads or a filesystem transaction.
"""

from __future__ import annotations

import hashlib
import json
from typing import Optional
from view_transport import view_reply_fits


def install_skill_listing(server, max_bytes=None):
    native_list = server._skills_list

    def failure(code: str, message: str, **fields) -> str:
        return server.err(message, code=code, **fields)

    def page_body(skills: list, offset: int, page: list, snapshot: str) -> dict:
        next_offset = offset + len(page)
        categories = sorted({item.get("category") for item in page if isinstance(item.get("category"), str) and item["category"]})
        return {
            "success": True, "skills": page, "count": len(skills), "returnedCount": len(page),
            "categories": categories, "categoryScope": "page", "offset": offset,
            "nextOffset": next_offset if next_offset < len(skills) else None, "snapshotHash": snapshot,
            "hint": "Load instructions with skill_view(name). Continue with offset=nextOffset and snapshot_hash=snapshotHash; omit category to include uncategorized skills.",
        }

    def skills_list(category: Optional[str] = None, offset: Optional[int] = None,
                    limit: Optional[int] = None, snapshot_hash: Optional[str] = None) -> str:
        """List native skill metadata without truncating JSON.

        Small default results retain the original response. Larger results or
        explicit pagination return a bounded page in original Hermes order.
        Follow nextOffset with the returned snapshotHash as snapshot_hash.
        count is total; categories apply to this page. Omit category to include
        uncategorized skills; 'general' is not an alias for their native null
        category. If the catalogue changes, restart at offset=0 without a hash.
        """
        if offset is not None and (type(offset) is not int or offset < 0):
            return failure("hermes_skill_list_invalid_page", "offset must be a non-negative integer")
        if limit is not None and (type(limit) is not int or not 1 <= limit <= 200):
            return failure("hermes_skill_list_invalid_page", "limit must be an integer between 1 and 200")
        if snapshot_hash is not None and not isinstance(snapshot_hash, str):
            return failure("hermes_skill_list_invalid_page", "snapshot_hash must be the returned snapshotHash")
        raw = native_list(category=category)
        try:
            body = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            return failure("hermes_skill_list_invalid_result", "Native list did not return a JSON object")
        budget = server.MAX_TOOL_CHARS
        if not isinstance(body, dict) or not body.get("success"):
            return raw if view_reply_fits(raw, budget, max_bytes) else failure("hermes_skill_list_unavailable", "Native list result exceeds the transport budget")
        skills = body.get("skills")
        if not isinstance(skills, list) or any(not isinstance(item, dict) for item in skills):
            return failure("hermes_skill_list_invalid_result", "Native list did not return skill metadata")
        if offset is None and limit is None and snapshot_hash is None and view_reply_fits(raw, budget, max_bytes):
            return raw
        start = offset if offset is not None else 0
        if start > 0 and snapshot_hash is None:
            return failure("hermes_skill_list_snapshot_required", "Continue with the previous page's snapshotHash", restartOffset=0)
        snapshot = "sha256:" + hashlib.sha256(
            json.dumps(skills, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        if snapshot_hash is not None and snapshot_hash != snapshot:
            return failure("hermes_skill_list_catalog_changed", "Catalogue changed; restart at offset=0 without snapshot_hash", restartOffset=0)
        if start > len(skills):
            return failure("hermes_skill_list_invalid_page", "offset is beyond the native catalogue", restartOffset=0)
        count = limit if limit is not None else 50
        page: list = []
        response = json.dumps(page_body(skills, start, page, snapshot), ensure_ascii=False)
        for item in skills[start:start + count]:
            candidate = json.dumps(page_body(skills, start, page + [item], snapshot), ensure_ascii=False)
            if not view_reply_fits(candidate, budget, max_bytes):
                break
            page.append(item)
            response = candidate
        if not view_reply_fits(response, budget, max_bytes) or not page and start < len(skills):
            return failure("hermes_skill_list_entry_too_large", "The entry at this offset cannot fit the transport budget; no entry was skipped", offset=start)
        return response

    # Replacing the old module variable alone would leave the registered MCP
    # signature category-only. Advertise the actual pagination parameters.
    server.mcp.remove_tool("skills_list")
    server.mcp.add_tool(skills_list, name="skills_list")
    server.skills_list = skills_list
    return skills_list
