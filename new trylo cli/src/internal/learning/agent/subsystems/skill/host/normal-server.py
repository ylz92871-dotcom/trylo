"""Read Hermes skills without executing their optional inline-shell rendering."""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
from view_transport import require_view_max_bytes, view_reply_fits


def install_read_only_view(server, max_view_bytes=None):
    from agent.skill_preprocessing import load_skills_config, substitute_template_vars
    original = server._skill_view

    def view(name, file_path=None):
        result = original(name=name, file_path=file_path, preprocess=False)
        if not file_path:
            body = json.loads(result)
            if isinstance(body, dict) and body.get("success") and isinstance(body.get("content"), str):
                raw = json.dumps(body["content"], ensure_ascii=False, separators=(",", ":"))
                body["tryloRawInstructionHash"] = hashlib.sha256(raw.encode("utf-8")).hexdigest()
                if load_skills_config().get("template_vars", True):
                    directory = body.get("skill_dir")
                    body["content"] = substitute_template_vars(body["content"], Path(directory) if isinstance(directory, str) else None, None)
                result = json.dumps(body, ensure_ascii=False)
        if max_view_bytes is not None and not view_reply_fits(result, server.MAX_TOOL_CHARS, max_view_bytes):
            return server.err("HERMES_VIEW_TOO_LARGE: full skill content exceeds the host view transport limit")
        return result

    server._skill_view = view


def install_skill_listing(server, max_bytes=None):
    spec = importlib.util.spec_from_file_location("trylo_hermes_skill_listing", Path(__file__).with_name("skill-listing.py"))
    if spec is None or spec.loader is None:
        raise ImportError("skill listing adapter is missing")
    listing = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = listing
    spec.loader.exec_module(listing)
    listing.install_skill_listing(server, max_bytes)


def load_legacy_server(capabilities_dir: Path):
    if not capabilities_dir.is_absolute():
        raise ValueError("capabilities-dir must be absolute")
    directory = capabilities_dir.resolve(strict=True)
    if not (directory / "upstream.py").is_file():
        raise ValueError("pinned Hermes adapter is missing")
    # Start with the legacy skill-only registration surface, then remove its
    # two non-read tools. The server itself must be read-only even when a host
    # forgets the additional client-side profile filter.
    os.environ["TRYLO_MCP_PROFILE"] = "learning"
    sys.path.insert(0, str(directory))
    spec = importlib.util.spec_from_file_location("trylo_hermes_normal_legacy", directory / "server.py")
    if spec is None or spec.loader is None:
        raise ImportError("could not load the pinned Hermes adapter")
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    server.mcp.remove_tool("skill_propose")
    server.mcp.remove_tool("learning_graph_summary")
    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capabilities-dir", required=True, type=Path)
    args = parser.parse_args()
    max_view_bytes = require_view_max_bytes()
    server = load_legacy_server(args.capabilities_dir)
    install_read_only_view(server, max_view_bytes)
    install_skill_listing(server, max_view_bytes)
    server.main()
