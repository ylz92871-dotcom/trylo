"""Read-only Skills list/view adapter for the Trylo Desktop learning UI.

Thin adapter that calls the official Hermes 0.19.0 ``skills_list`` /
``skill_view`` through ``upstream``. No skill parsing, listing or threat logic
is re-implemented here — the official ``tools.skills_tool`` owns all of it.

Phase 3A (read-only) only. Every mutation path stays in ``admin.py``
(staged pending + apply with expected hash), so the Desktop UI can list and
view Skills without ever being able to write one.

Request (single-line JSON on stdin):
    {"op": "list"}
    {"op": "view", "name": "<skill-name>", "hermes_home": "..."}

Response (single-line JSON on stdout):
    {"success": true, "schemaVersion": 1, "hermesVersion": "0.19.0",
     "op": "list", ...upstream fields...}

On any failure the adapter returns ``success=false`` with ``error`` and NEVER
writes to the skills tree.
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any

import upstream
from upstream import err, require_version, skill_view, skills_list


SCHEMA_VERSION = 1
HERMES_REQUIRED_VERSION = upstream.HERMES_REQUIRED_VERSION

# Conservative name guard: skill directories are simple slugs. Rejecting
# traversal/whitespace here keeps the adapter from being used as a path probe
# even if a caller passes UI text straight through.
NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


def _respond(op: str, upstream_json: str) -> dict[str, Any]:
    parsed = json.loads(upstream_json)
    if not isinstance(parsed, dict):
        return json.loads(err("upstream returned a non-object payload", op=op))
    body: dict[str, Any] = {
        "success": bool(parsed.get("success")),
        "schemaVersion": SCHEMA_VERSION,
        "hermesVersion": HERMES_REQUIRED_VERSION,
        "op": op,
    }
    body.update(parsed)
    return body


def main() -> int:
    try:
        raw = sys.stdin.read()
        request = json.loads(raw) if raw.strip() else {}
    except Exception as exc:
        sys.stdout.write(err("invalid request JSON: %s" % exc))
        return 1

    if not isinstance(request, dict):
        sys.stdout.write(err("request must be a JSON object"))
        return 1

    op = str(request.get("op") or "list")
    hermes_home = str(request.get("hermes_home") or os.environ.get("HERMES_HOME") or "")
    if hermes_home:
        os.environ["HERMES_HOME"] = hermes_home

    version_check = json.loads(require_version())
    if not version_check.get("success"):
        version_check["op"] = op
        sys.stdout.write(json.dumps(version_check, ensure_ascii=False))
        return 1

    try:
        if op == "list":
            body = _respond(op, skills_list())
        elif op == "view":
            name = str(request.get("name") or "")
            if not NAME_RE.match(name):
                sys.stdout.write(err("invalid skill name", op=op))
                return 1
            body = _respond(op, skill_view(name))
        else:
            sys.stdout.write(err("unsupported op: %s" % op, op=op))
            return 1
    except Exception as exc:
        sys.stdout.write(err("skills adapter failed: %s" % exc, op=op))
        return 1

    sys.stdout.write(json.dumps(body, ensure_ascii=False))
    return 0 if body.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
