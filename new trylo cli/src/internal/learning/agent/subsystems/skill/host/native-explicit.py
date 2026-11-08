"""Batch explicit Team selections through the pinned, non-executing Hermes view."""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import sys

MAX_NAMES = 32
MAX_CONTENT_CHARS = 20_000


def failure(code: str, name: str | None = None) -> dict:
    return {"success": False, "code": code, **({"requestedName": name} if name is not None else {})}


def _boolean(metadata: dict, key: str, default: bool) -> bool:
    value = metadata.get(key, default)
    if type(value) is bool:
        return value
    # The native parser's malformed-YAML fallback returns scalar strings.
    if value == "true":
        return True
    if value == "false":
        return False
    raise ValueError("invalid invocation flag")


def _optional_text(metadata: dict, key: str) -> str | None:
    value = metadata.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("invalid metadata text")
    return value


def dispatch(request: dict, server) -> dict:
    names = request.get("names")
    if not isinstance(names, list) or len(names) > MAX_NAMES or any(
        not isinstance(name, str) or not name.strip() or len(name) > 512 or "\0" in name for name in names
    ):
        return failure("hermes_explicit_invalid")
    if not json.loads(server.upstream.require_version()).get("success"):
        return failure("hermes_version_unavailable")
    from agent.skill_utils import parse_frontmatter

    selected = []
    for name in dict.fromkeys(names):
        try:
            # The wrapper retains official lookup, collision/platform/disabled
            # guards and pure template variables, with preprocess=False.
            native = json.loads(server._skill_view(name=name))
            if not isinstance(native, dict) or native.get("success") is not True:
                return failure("hermes_explicit_not_available", name)
            content, directory, resolved = native.get("content"), native.get("skill_dir"), native.get("name")
            if not isinstance(content, str) or len(content) > MAX_CONTENT_CHARS:
                return failure("hermes_explicit_content_limit", name)
            if not isinstance(directory, str) or not Path(directory).is_absolute() or not isinstance(resolved, str) or not resolved.strip():
                return failure("hermes_explicit_metadata_invalid", name)
            metadata, body = parse_frontmatter(content)
            context = _optional_text(metadata, "context")
            description = native.get("description", "")
            if not isinstance(description, str):
                return failure("hermes_explicit_metadata_invalid", name)
            entry = {"requestedName": name, "name": resolved, "description": description,
                     "skillRoot": directory, "path": str(Path(directory) / "SKILL.md"),
                     "content": content, "body": body,
                     "userInvocable": _boolean(metadata, "user-invocable", True),
                     "disableModelInvocation": _boolean(metadata, "disable-model-invocation", False),
                     "forkExecution": context == "fork"}
            for source, target in (("when_to_use", "whenToUse"), ("argument-hint", "argumentHint")):
                value = _optional_text(metadata, source)
                if value is not None:
                    entry[target] = value
            # Native allowed-tools remains content data. It is deliberately
            # absent from the Trylo descriptor and cannot create tool policy.
            selected.append(entry)
        except (ValueError, TypeError, KeyError):
            return failure("hermes_explicit_metadata_invalid", name)
    return {"success": True, "skills": selected}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capabilities-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        request = json.loads(sys.stdin.read())
        if not isinstance(request, dict):
            result = failure("hermes_explicit_invalid")
        else:
            spec = importlib.util.spec_from_file_location("trylo_hermes_explicit_normal", Path(__file__).with_name("normal-server.py"))
            if spec is None or spec.loader is None:
                raise ImportError("normal view adapter is missing")
            bridge = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(bridge)
            server = bridge.load_legacy_server(args.capabilities_dir)
            bridge.install_read_only_view(server)
            result = dispatch(request, server)
    except Exception:
        # Native diagnostics may contain content, local paths or credentials.
        # The process boundary exports a fixed error code, never exception text.
        result = failure("hermes_explicit_unavailable")
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("success") is True else 1


if __name__ == "__main__":
    sys.exit(main())
