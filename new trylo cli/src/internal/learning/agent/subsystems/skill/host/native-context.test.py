"""Native index budget contracts in an isolated Hermes home; no model calls."""
from __future__ import annotations
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("native_context_bridge", Path(__file__).with_name("native-context.py"))
assert SPEC is not None and SPEC.loader is not None
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)


class NativeBudgetContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.previous_home = os.environ.get("HERMES_HOME")
        cls.temporary = tempfile.TemporaryDirectory(prefix="trylo-native-index-budget-")
        cls.home = Path(cls.temporary.name)
        os.environ["HERMES_HOME"] = str(cls.home)
        (cls.home / "config.yaml").write_text("skills:\n  write_approval: true\n", encoding="utf-8")
        capabilities = Path(__file__).resolve().parent.parent / "vendor" / "legacy" / "hermes-capabilities"
        sys.path.insert(0, str(capabilities))
        import upstream
        cls.upstream = upstream
        for index in range(90):
            # Flat skills expose the difference between skills_list's category
            # None and the native prompt builder's folder-based category.
            directory = cls.home / "skills" / f"procedure-{index:03d}"
            directory.mkdir(parents=True)
            (directory / "SKILL.md").write_text(
                f"---\nname: procedure-{index:03d}\ndescription: {'Repeatable synthetic procedure description ' * 5}\n---\n\nRead the supplied inputs and apply the requested rules.\n",
                encoding="utf-8",
            )
        gated = cls.home / "skills" / "environment-gated"
        gated.mkdir()
        (gated / "SKILL.md").write_text(
            "---\nname: environment-gated\ndescription: Only relevant to a detected Docker environment.\nenvironments: [docker]\n---\n\nRead the supplied environment-specific instructions.\n",
            encoding="utf-8",
        )

    @classmethod
    def tearDownClass(cls) -> None:
        if cls.previous_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = cls.previous_home
        cls.temporary.cleanup()

    def test_over_budget_uses_native_names_only_and_keeps_the_last_skill(self) -> None:
        full = BRIDGE.dispatch({"op": "context"}, self.upstream)
        compact = BRIDGE.dispatch({"op": "context", "maxPromptChars": 7500}, self.upstream)
        self.assertTrue(full["success"])
        self.assertTrue(compact["success"])
        self.assertNotIn("[names only]", full["prompt"])
        self.assertIn("[names only]", compact["prompt"])
        for index in range(90):
            self.assertIn(f"procedure-{index:03d}", compact["prompt"])
        self.assertLess(BRIDGE._prompt_chars(compact["prompt"]), BRIDGE._prompt_chars(full["prompt"]))
        self.assertLessEqual(BRIDGE._prompt_chars(compact["prompt"]), 7500)
        self.assertIn("Trylo skill-index budget", compact["prompt"])
        self.assertNotIn("outside the current coding context", compact["prompt"])

    def test_fit_preserves_the_original_native_prompt_and_hash(self) -> None:
        from agent.prompt_builder import build_skills_system_prompt, clear_skills_system_prompt_cache
        clear_skills_system_prompt_cache(clear_snapshot=True)
        raw = build_skills_system_prompt()
        result = BRIDGE.dispatch({"op": "context", "maxPromptChars": 500_000}, self.upstream)
        self.assertEqual(result["prompt"], raw)
        self.assertEqual(result["upstreamPromptHash"], "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest())

    def test_context_rebuild_applies_current_environment_gate_in_the_same_directory(self) -> None:
        with patch("agent.skill_utils._detect_environment", return_value=True):
            visible = BRIDGE.dispatch({"op": "context", "maxPromptChars": 500_000}, self.upstream)
        self.assertIn("environment-gated", visible["prompt"])
        with patch("agent.skill_utils._detect_environment", return_value=False):
            hidden = BRIDGE.dispatch({"op": "context", "maxPromptChars": 500_000}, self.upstream)
            compact = BRIDGE.dispatch({"op": "context", "maxPromptChars": 7500}, self.upstream)
        self.assertNotIn("environment-gated", hidden["prompt"])
        self.assertNotIn("environment-gated", compact["prompt"])
        for index in range(90):
            self.assertIn(f"procedure-{index:03d}", hidden["prompt"])
            self.assertIn(f"procedure-{index:03d}", compact["prompt"])

    def test_budget_and_javascript_character_contracts_are_explicit(self) -> None:
        self.assertEqual(BRIDGE._prompt_chars("a😀中"), 4)
        for value in (True, 0, -1, 1.5, "4000"):
            result = BRIDGE.dispatch({"op": "context", "maxPromptChars": value}, self.upstream)
            self.assertFalse(result["success"])


class NativeToolVisibilityContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.previous_home = os.environ.get("HERMES_HOME")
        cls.temporary = tempfile.TemporaryDirectory(prefix="trylo-native-tool-visibility-")
        cls.home = Path(cls.temporary.name)
        os.environ["HERMES_HOME"] = str(cls.home)
        (cls.home / "config.yaml").write_text("skills:\n  write_approval: true\n", encoding="utf-8")
        capabilities = Path(__file__).resolve().parent.parent / "vendor" / "legacy" / "hermes-capabilities"
        sys.path.insert(0, str(capabilities))
        import upstream
        cls.upstream = upstream
        conditions = {
            "visible-always": "",
            "requires-observed-tools": "requires_tools: [read_file, mcp__service__inspect]",
            "fallback-if-no-reader": "fallback_for_tools: [read_file]",
            "requires-hermes-terminal": "requires_tools: [terminal]",
            "requires-native-web-group": "requires_toolsets: [web]",
        }
        for name, condition in conditions.items():
            directory = cls.home / "skills" / name
            directory.mkdir(parents=True)
            metadata = f"metadata:\n  hermes:\n    {condition}\n" if condition else ""
            (directory / "SKILL.md").write_text(
                f"---\nname: {name}\ndescription: Inspect native visibility conditions.\n{metadata}---\n\n"
                "# Procedure\n\nRead the supplied inputs. Visibility is not a permission grant.\n", encoding="utf-8",
            )

    @classmethod
    def tearDownClass(cls) -> None:
        if cls.previous_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = cls.previous_home
        cls.temporary.cleanup()

    def context(self, **visibility) -> str:
        result = BRIDGE.dispatch({"op": "context", "maxPromptChars": 500_000, **visibility}, self.upstream)
        self.assertTrue(result.get("success"), result)
        return result["prompt"]

    def test_none_is_unfiltered_but_explicit_empty_sets_apply_native_conditions(self) -> None:
        unfiltered = self.context()
        strict = self.context(availableTools=[], availableToolsets=[])
        for name in ("visible-always", "requires-observed-tools", "fallback-if-no-reader", "requires-hermes-terminal", "requires-native-web-group"):
            self.assertIn(name, unfiltered)
        self.assertIn("visible-always", strict)
        self.assertIn("fallback-if-no-reader", strict)
        for name in ("requires-observed-tools", "requires-hermes-terminal", "requires-native-web-group"):
            self.assertNotIn(name, strict)

    def test_requires_all_exact_tool_names_and_hides_a_superseded_fallback(self) -> None:
        partial = self.context(availableTools=["read_file"], availableToolsets=[])
        complete = self.context(availableTools=["read_file", "mcp__service__inspect"], availableToolsets=[])
        self.assertNotIn("requires-observed-tools", partial)
        self.assertIn("requires-observed-tools", complete)
        self.assertNotIn("fallback-if-no-reader", partial)
        self.assertNotIn("fallback-if-no-reader", complete)

    def test_trylo_names_do_not_imply_hermes_aliases_or_toolset_membership(self) -> None:
        actual_names = self.context(availableTools=["run_shell", "web_search", "mcp__service__inspect"], availableToolsets=[])
        self.assertNotIn("requires-hermes-terminal", actual_names)
        self.assertNotIn("requires-native-web-group", actual_names)
        literal_native_names = self.context(availableTools=["terminal"], availableToolsets=["web"])
        self.assertIn("requires-hermes-terminal", literal_native_names)
        self.assertIn("requires-native-web-group", literal_native_names)

    def test_hidden_index_entry_remains_available_for_explicit_native_discovery_and_read(self) -> None:
        prompt = self.context(availableTools=[], availableToolsets=[])
        self.assertNotIn("requires-observed-tools", prompt)
        listed = json.loads(self.upstream.skills_list())
        self.assertTrue(listed.get("success"), listed)
        self.assertIn("requires-observed-tools", [item["name"] for item in listed["skills"]])
        viewed = json.loads(self.upstream.skill_view("requires-observed-tools", preprocess=False))
        self.assertTrue(viewed.get("success"), viewed)
        self.assertEqual(viewed["name"], "requires-observed-tools")
        self.assertIn("Visibility is not a permission grant.", viewed["content"])


if __name__ == "__main__":
    unittest.main()
