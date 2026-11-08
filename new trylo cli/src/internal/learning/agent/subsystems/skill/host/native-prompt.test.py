"""Pinned prompt equality/privacy contracts; no agent, model or skill writes."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest

SPEC = importlib.util.spec_from_file_location("native_prompt_contract", Path(__file__).with_name("native-prompt.py"))
assert SPEC is not None and SPEC.loader is not None
READER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(READER)


class NativePromptContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.previous_home = os.environ.get("HERMES_HOME")
        cls.temporary = tempfile.TemporaryDirectory(prefix="trylo-native-prompt-")
        os.environ["HERMES_HOME"] = cls.temporary.name
        cls.capabilities = Path(__file__).resolve().parent.parent / "vendor" / "legacy" / "hermes-capabilities"
        sys.path.insert(0, str(cls.capabilities))
        import upstream
        cls.upstream = upstream

    @classmethod
    def tearDownClass(cls):
        if cls.previous_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = cls.previous_home
        cls.temporary.cleanup()

    def test_implicit_is_exact_official_prompt_with_its_plural_skill_decision(self):
        from agent.background_review import _SKILL_REVIEW_PROMPT
        result = READER.dispatch({"mode": "implicit"}, self.upstream)
        self.assertTrue(result["success"], result)
        self.assertEqual(result["prompt"], _SKILL_REVIEW_PROMPT)
        self.assertEqual(result["hermesVersion"], "0.19.0")
        self.assertEqual(result["promptHash"], "sha256:" + hashlib.sha256(_SKILL_REVIEW_PROMPT.encode("utf-8")).hexdigest())
        self.assertIn("relevant skill(s)", result["prompt"])
        for legacy in ("Trylo L0 contract", "learning_graph_summary", "at most 1-3", "At most one coherent staged proposal"):
            self.assertNotIn(legacy, result["prompt"])

    def test_explicit_passes_the_complete_user_request_to_the_official_builder(self):
        from agent.learn_prompt import build_learn_prompt
        request = "来源 D:/example/api；保留分页顺序，包含空组；跳过旧接口。😀"
        result = READER.dispatch({"mode": "explicit", "request": request}, self.upstream)
        self.assertEqual(result["prompt"], build_learn_prompt(request))
        self.assertIn(request, result["prompt"])
        self.assertIn("Author ONE SKILL.md", result["prompt"])
        self.assertEqual(READER.dispatch({"mode": "explicit"}, self.upstream)["prompt"], build_learn_prompt(""))

    def test_version_and_input_refusals_have_fixed_non_source_errors(self):
        wrong = SimpleNamespace(require_version=lambda: json.dumps({"success": False, "error": "private-source-secret /local/path"}))
        self.assertEqual(READER.dispatch({"mode": "implicit"}, wrong), {"success": False, "code": "hermes_version_unavailable"})
        for request in ({"mode": "unknown"}, {"mode": "explicit", "request": []},
                        {"mode": "explicit", "request": "x" * (READER.MAX_REQUEST_CHARS + 1)}):
            self.assertEqual(READER.dispatch(request, self.upstream), {"success": False, "code": "hermes_native_prompt_invalid"})

    def test_real_stdin_entry_returns_official_body_and_never_echoes_parse_errors(self):
        from agent.background_review import _SKILL_REVIEW_PROMPT
        command = [sys.executable, str(Path(__file__).with_name("native-prompt.py")), "--capabilities-dir", str(self.capabilities)]
        valid = subprocess.run(command, input=json.dumps({"mode": "implicit"}), text=True,
                               capture_output=True, timeout=15, encoding="utf-8")
        self.assertEqual(valid.returncode, 0, valid.stderr)
        self.assertEqual(json.loads(valid.stdout)["prompt"], _SKILL_REVIEW_PROMPT)
        malformed = subprocess.run(command, input='{"request":"private-source-secret",', text=True,
                                   capture_output=True, timeout=15, encoding="utf-8")
        self.assertEqual(malformed.returncode, 1)
        self.assertEqual(json.loads(malformed.stdout), {"success": False, "code": "hermes_native_prompt_unavailable"})
        self.assertNotIn("private-source-secret", malformed.stdout + malformed.stderr)


if __name__ == "__main__":
    unittest.main()
