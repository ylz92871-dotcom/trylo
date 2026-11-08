"""Read the pinned official learning prompt without legacy Trylo policy tails."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

MAX_REQUEST_CHARS = 128_000
MAX_PROMPT_CHARS = 200 * 1024


def failure(code: str) -> dict:
    return {"success": False, "code": code}


def dispatch(request: dict, upstream) -> dict:
    mode, text = request.get("mode"), request.get("request", "")
    if mode not in ("implicit", "explicit") or not isinstance(text, str) or len(text) > MAX_REQUEST_CHARS:
        return failure("hermes_native_prompt_invalid")
    version = json.loads(upstream.require_version())
    if not version.get("success"):
        return failure("hermes_version_unavailable")
    if mode == "explicit":
        from agent.learn_prompt import build_learn_prompt
        prompt = build_learn_prompt(text)
    else:
        from agent.background_review import _SKILL_REVIEW_PROMPT
        prompt = _SKILL_REVIEW_PROMPT
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT_CHARS:
        return failure("hermes_native_prompt_invalid")
    return {"success": True, "mode": mode, "prompt": prompt,
            "hermesVersion": version["version"],
            "promptHash": "sha256:" + hashlib.sha256(prompt.encode("utf-8")).hexdigest()}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capabilities-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        capabilities = args.capabilities_dir.resolve(strict=True)
        if not (capabilities / "upstream.py").is_file():
            raise ValueError("missing pinned adapter")
        sys.path.insert(0, str(capabilities))
        import upstream

        raw = sys.stdin.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("input limit")
        request = json.loads(raw)
        result = dispatch(request, upstream) if isinstance(request, dict) else failure("hermes_native_prompt_invalid")
    except Exception:
        # Dependency exceptions can include source text, paths or credentials.
        result = failure("hermes_native_prompt_unavailable")
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
