"""Explicit native Team contracts. Run once at close with the pinned Python.

--unsafe-inline disables only the new safe-view wrapper for a mock-only red
fixture; it does not execute a shell or call a model.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

UNSAFE_INLINE = "--unsafe-inline" in sys.argv
if UNSAFE_INLINE:
    sys.argv.remove("--unsafe-inline")


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    assert spec is not None and spec.loader is not None
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


EXPLICIT = module("explicit_contract", "native-explicit.py")
NORMAL = module("explicit_normal_contract", "normal-server.py")


class NativeExplicitContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.previous_home = os.environ.get("HERMES_HOME")
        cls.previous_profile = os.environ.get("TRYLO_MCP_PROFILE")
        cls.temporary = tempfile.TemporaryDirectory(prefix="trylo-explicit-native-")
        cls.home = Path(cls.temporary.name)
        os.environ["HERMES_HOME"] = str(cls.home)
        cls.directory = cls.home / "skills" / "procedure"
        cls.directory.mkdir(parents=True)
        cls.server = NORMAL.load_legacy_server(Path(__file__).resolve().parent.parent / "vendor" / "legacy" / "hermes-capabilities")
        if not UNSAFE_INLINE:
            NORMAL.install_read_only_view(cls.server)

    @classmethod
    def tearDownClass(cls):
        for key, value in (("HERMES_HOME", cls.previous_home), ("TRYLO_MCP_PROFILE", cls.previous_profile)):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        cls.temporary.cleanup()

    def setUp(self):
        (self.home / "config.yaml").write_text("skills:\n  inline_shell: true\n  template_vars: true\n  disabled: []\n", encoding="utf-8")
        self.content = (
            "---\nname: resolved-procedure\ndescription: Synthetic procedure.\n"
            "allowed-tools:\n  - terminal*\n  - 'Bash(rm:*)'\n"
            "user-invocable: false\ndisable-model-invocation: true\ncontext: fork\n"
            "metadata:\n  nested:\n    supported: true\n---\n"
            "Use ${HERMES_SKILL_DIR}/references/check.md.\nExample !`do-not-execute`.\n"
        )
        (self.directory / "SKILL.md").write_text(self.content, encoding="utf-8")

    def request(self, names):
        return EXPLICIT.dispatch({"names": names}, self.server)

    def test_actual_native_content_flags_and_pure_templates_survive_without_execution(self):
        with patch("agent.skill_preprocessing.run_inline_shell", return_value="EXECUTED") as shell:
            result = self.request(["procedure", "procedure"])
        self.assertTrue(result.get("success"), result)
        self.assertEqual(len(result["skills"]), 1)
        skill = result["skills"][0]
        self.assertEqual(skill["requestedName"], "procedure")
        self.assertEqual(skill["name"], "resolved-procedure")
        self.assertEqual(skill["skillRoot"], str(self.directory))
        self.assertEqual(skill["path"], str(self.directory / "SKILL.md"))
        self.assertEqual(skill["content"], self.content.replace("${HERMES_SKILL_DIR}", str(self.directory)))
        self.assertFalse(skill["userInvocable"])
        self.assertTrue(skill["disableModelInvocation"])
        self.assertTrue(skill["forkExecution"])
        self.assertNotIn("allowedTools", skill)
        self.assertIn("Bash(rm:*)", skill["content"])
        self.assertNotIn("allowed-tools:", skill["body"])
        shell.assert_not_called()

    def test_native_disabled_platform_and_traversal_refusals_are_preserved(self):
        (self.home / "config.yaml").write_text("skills:\n  disabled: [resolved-procedure]\n", encoding="utf-8")
        refused = self.request(["procedure"])
        self.assertEqual(refused, {"success": False, "code": "hermes_explicit_not_available", "requestedName": "procedure"})
        (self.home / "config.yaml").write_text("skills:\n  disabled: []\n", encoding="utf-8")
        # A declaration that cannot match any runtime is rejected by official view.
        (self.directory / "SKILL.md").write_text(self.content.replace("description:", "platforms: [synthetic-unavailable-platform]\ndescription:"), encoding="utf-8")
        self.assertEqual(self.request(["procedure"])["code"], "hermes_explicit_not_available")
        self.assertEqual(self.request(["../procedure"])["code"], "hermes_explicit_not_available")

    def test_unknown_batch_member_exposes_no_partial_overlay_and_errors_are_fixed(self):
        result = self.request(["procedure", "not-installed"])
        self.assertFalse(result.get("success"), result)
        self.assertNotIn("skills", result)
        self.assertNotIn("error", result)
        self.assertEqual(result["requestedName"], "not-installed")

    def test_template_disable_and_malformed_invocation_flag_are_respected(self):
        # The normal view captured the native config reader during install.
        # The real isolated config also tests the setting the user can change.
        (self.home / "config.yaml").write_text("skills:\n  inline_shell: true\n  template_vars: false\n  disabled: []\n", encoding="utf-8")
        with patch("agent.skill_preprocessing.run_inline_shell", return_value="EXECUTED") as shell:
            result = self.request(["procedure"])
        self.assertTrue(result.get("success"), result)
        self.assertIn("${HERMES_SKILL_DIR}", result["skills"][0]["content"])
        shell.assert_not_called()
        (self.directory / "SKILL.md").write_text(self.content.replace("user-invocable: false", "user-invocable: [false]"), encoding="utf-8")
        self.assertEqual(self.request(["procedure"])["code"], "hermes_explicit_metadata_invalid")

    def test_batch_limits_reject_before_native_view(self):
        with patch.object(self.server, "_skill_view", side_effect=AssertionError("unexpected view")):
            for names in (["procedure"] * 33, [""], ["invalid\0name"], "procedure"):
                self.assertEqual(self.request(names), {"success": False, "code": "hermes_explicit_invalid"})


if __name__ == "__main__":
    unittest.main()
