#!/usr/bin/env python3
"""Read official Hermes 0.19.0 learning prompts without re-implementing them.

Reads a JSON request from stdin::

    {"mode": "implicit|explicit", "request": "..."}

Outputs one JSON line on stdout::

    {"success": true, "mode": "...", "prompt": "...", "hermesVersion": "0.19.0", "promptHash": "sha256:..."}

or::

    {"success": false, "error": "..."}

- explicit: calls the official ``agent.learn_prompt.build_learn_prompt(request)``.
- implicit: returns the official ``agent.background_review._SKILL_REVIEW_PROMPT``
  private symbol (read-only, never copied or rewritten).

Fails closed: if Hermes is not installed, version mismatches, or the private
symbol is not a non-empty string, returns ``success: false``.
"""

from __future__ import annotations

import hashlib
import json
import sys

import upstream


def _prompt_hash(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


# 09 §5.3: short Trylo contract appended to the official implicit
# prompt. The body still comes verbatim from the upstream
# _SKILL_REVIEW_PROMPT symbol; the tail is Trylo-specific guidance so
# the L0 model prefers `patch` over `edit`, and only `create`s when no
# existing Skill fits. Hermes upgrade that changes the private symbol
# will still surface the upstream body via promptHash.
TRYLO_L0_CONTRACT_TAIL = """

\n\nTrylo L0 contract (appended; upstream prompt body above is unchanged):
  1. Before proposing, call learning_graph_summary and skills_list.
  2. Use skill_view to read at most 1-3 candidate Skills.
  3. If an existing Skill covers this change, prefer action=patch;
     use action=edit only when the change is too large to express as
     a patch.
  4. action=create is reserved for cases where no existing Skill
     fits. If you are unsure whether the new Skill would duplicate
     an existing one, return no_learning — never create near-duplicates.
  5. At most one coherent staged proposal per run.
  6. Never delete, archive, or rollback Skills. Those are
     user/admin actions only.
  7. Office/Work turns produce CLASS-LEVEL Skills
     (e.g. work-presentation, weekly-report, meeting-minutes).
     Never date-stamped instance names (q3-board-deck-2026-09-04).
  8. When the evidence names a deliverable path under .trylo/out,
     prefer SKILL.md + templates/<name>.<ext> as a starter-file
     pointer. Do not embed binary bytes. Desktop copies the file
     AFTER the user applies the pending proposal.
  9. Skills capture how to do this class of task for this user;
     Memory captures who/state. Do not dump the PPT into MEMORY.md.
"""


def main() -> None:
    # Read request from stdin
    try:
        raw = sys.stdin.read()
        req = json.loads(raw) if raw.strip() else {}
    except Exception as exc:
        print(json.dumps({"success": False, "error": f"invalid stdin json: {exc}"}))
        sys.exit(1)

    mode = str(req.get("mode", "")).strip().lower()
    request = str(req.get("request", "")).strip()

    if mode not in ("implicit", "explicit"):
        print(json.dumps({"success": False, "error": f"unknown mode: {mode}"}))
        sys.exit(1)

    # Fail closed on version mismatch
    vcheck = json.loads(upstream.require_version())
    if not vcheck.get("success"):
        print(json.dumps({
            "success": False,
            "error": f"hermes version check failed: {vcheck.get('error')}",
        }))
        sys.exit(1)

    hermes_version = vcheck.get("version", "0.19.0")

    if mode == "explicit":
        try:
            from agent.learn_prompt import build_learn_prompt
            prompt = build_learn_prompt(request)
        except Exception as exc:
            print(json.dumps({"success": False, "error": f"build_learn_prompt failed: {exc}"}))
            sys.exit(1)
    else:
        # implicit: read the official _SKILL_REVIEW_PROMPT private symbol
        try:
            from agent.background_review import _SKILL_REVIEW_PROMPT
        except ImportError as exc:
            print(json.dumps({
                "success": False,
                "error": f"_SKILL_REVIEW_PROMPT not importable: {exc}",
            }))
            sys.exit(1)

        if not isinstance(_SKILL_REVIEW_PROMPT, str) or not _SKILL_REVIEW_PROMPT.strip():
            print(json.dumps({
                "success": False,
                "error": "_SKILL_REVIEW_PROMPT is not a non-empty string; "
                          "Hermes upgrade may have changed the private symbol.",
            }))
            sys.exit(1)

        prompt = _SKILL_REVIEW_PROMPT + TRYLO_L0_CONTRACT_TAIL

    ph = _prompt_hash(prompt)

    print(json.dumps({
        "success": True,
        "mode": mode,
        "prompt": prompt,
        "hermesVersion": hermes_version,
        "promptHash": ph,
    }))


if __name__ == "__main__":
    main()