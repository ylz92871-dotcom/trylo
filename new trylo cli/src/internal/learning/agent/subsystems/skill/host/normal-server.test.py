"""Native read-only skill contracts; no model or shell execution.

--unguarded selects the original legacy view for a red regression result.
Use the pinned Hermes Python; all stores are temporary.
"""
from __future__ import annotations
import importlib.util
import asyncio
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch
from view_transport import require_view_max_bytes, view_reply_fits

UNGUARDED = "--unguarded" in sys.argv
if UNGUARDED:
    sys.argv.remove("--unguarded")
UNGUARDED_UI = "--unguarded-ui" in sys.argv
if UNGUARDED_UI:
    sys.argv.remove("--unguarded-ui")
bridge_path = Path(__file__).with_name("normal-server.py")
for arg in list(sys.argv):
    if arg.startswith("--bridge="):
        bridge_path = Path(arg.split("=", 1)[1])
        sys.argv.remove(arg)
SPEC = importlib.util.spec_from_file_location("normal_bridge", bridge_path)
assert SPEC is not None and SPEC.loader is not None
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)


class NormalReadContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.previous_home = os.environ.get("HERMES_HOME")
        cls.previous_profile = os.environ.get("TRYLO_MCP_PROFILE")
        cls.temporary = tempfile.TemporaryDirectory(prefix="trylo-normal-read-")
        cls.home = Path(cls.temporary.name)
        os.environ["HERMES_HOME"] = str(cls.home)
        (cls.home / "config.yaml").write_text("skills:\n  write_approval: true\n  inline_shell: true\n", encoding="utf-8")
        directory = Path(__file__).resolve().parent.parent / "vendor" / "legacy" / "hermes-capabilities"
        cls.server = BRIDGE.load_legacy_server(directory)
        if not UNGUARDED:
            BRIDGE.install_read_only_view(cls.server)
        cls.skill = cls.home / "skills" / "procedure"
        cls.skill.mkdir(parents=True)
        (cls.skill / "SKILL.md").write_text(
            "---\nname: procedure\ndescription: Inspect an observed procedure.\n---\n\n"
            "Read ${HERMES_SKILL_DIR}/references/check.md.\nDo not execute this example: !`printf trylo-inline-example`\n",
            encoding="utf-8",
        )

    @classmethod
    def tearDownClass(cls) -> None:
        for key, value in (("HERMES_HOME", cls.previous_home), ("TRYLO_MCP_PROFILE", cls.previous_profile)):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        cls.temporary.cleanup()

    def test_skill_read_does_not_execute_configured_inline_shell(self) -> None:
        with patch("agent.skill_preprocessing.load_skills_config", return_value={"inline_shell": True}), patch(
            "agent.skill_preprocessing.run_inline_shell", return_value="EXECUTED"
        ) as shell:
            result = json.loads(self.server.skill_view("procedure"))
        self.assertTrue(result.get("success"), result)
        shell.assert_not_called()
        self.assertIn("!`printf trylo-inline-example`", result["content"])
        self.assertNotIn("EXECUTED", result["content"])

    def test_native_normal_server_itself_only_advertises_skill_read_tools(self) -> None:
        tools = asyncio.run(self.server.mcp.list_tools())
        self.assertEqual({tool.name for tool in tools}, {"skills_list", "skill_view"})

    def test_native_directory_template_remains_available_without_shell_rendering(self) -> None:
        with patch("agent.skill_preprocessing.run_inline_shell", return_value="MOCKED_INLINE_OUTPUT"):
            result = json.loads(self.server.skill_view("procedure"))
        self.assertTrue(result.get("success"), result)
        self.assertIn(str(self.skill), result["content"])
        self.assertNotIn("${HERMES_SKILL_DIR}", result["content"])

    def test_native_lookup_guards_remain_in_force(self) -> None:
        for name, file in (("../procedure", None), ("procedure", "../../private.txt")):
            result = json.loads(self.server.skill_view(name, file))
            self.assertFalse(result.get("success"), result)

    def test_normal_view_respects_disabled_directory_template_rendering(self) -> None:
        # The installed wrapper captures the native config reader. Exercise its
        # actual config input rather than replace a module symbol afterwards.
        config = self.home / "config.yaml"
        original = config.read_text(encoding="utf-8")
        self.addCleanup(config.write_text, original, encoding="utf-8")
        config.write_text("skills:\n  write_approval: true\n  inline_shell: true\n  template_vars: false\n", encoding="utf-8")
        with patch("agent.skill_preprocessing.run_inline_shell", return_value="NORMAL_SHELL_EXECUTED") as shell:
            result = json.loads(self.server.skill_view("procedure"))
        self.assertTrue(result.get("success"), result)
        self.assertIn("${HERMES_SKILL_DIR}", result["content"])
        shell.assert_not_called()

    def transport_server(self, max_bytes):
        directory = Path(__file__).resolve().parent.parent / "vendor" / "legacy" / "hermes-capabilities"
        server = BRIDGE.load_legacy_server(directory)
        if not UNGUARDED:
            BRIDGE.install_read_only_view(server, max_bytes)
        return server

    def test_native_view_inside_character_cap_but_over_host_bytes_returns_a_short_refusal(self) -> None:
        target = self.skill / "SKILL.md"
        original = target.read_text(encoding="utf-8")
        self.addCleanup(target.write_text, original, encoding="utf-8")
        target.write_text("---\nname: procedure\ndescription: Synthetic.\n---\n" + "😀" * 17_000, encoding="utf-8")
        server = self.transport_server(65_536)
        native_reply = server.upstream.skill_view("procedure", preprocess=False)
        self.assertLess(len(native_reply), server.MAX_TOOL_CHARS)
        self.assertGreater(len(native_reply.encode("utf-8")), 65_536)
        refused = json.loads(server.skill_view("procedure"))
        self.assertFalse(refused.get("success"), refused)
        self.assertIn("HERMES_VIEW_TOO_LARGE", refused.get("error", ""))
        self.assertNotIn("content", refused)
        target.write_text(original, encoding="utf-8")
        viewed = json.loads(server.skill_view("procedure"))
        self.assertTrue(viewed.get("success"), viewed)
        self.assertEqual(viewed["name"], "procedure")
        self.assertIn("linked_files", viewed)
        self.assertIn(str(self.skill), viewed["content"])

    def test_host_byte_check_runs_after_pure_directory_template_substitution(self) -> None:
        target = self.skill / "SKILL.md"
        original = target.read_text(encoding="utf-8")
        self.addCleanup(target.write_text, original, encoding="utf-8")
        target.write_text("---\nname: procedure\ndescription: Synthetic.\n---\n" + "${HERMES_SKILL_DIR}\n" * 100, encoding="utf-8")
        raw = self.server.upstream.skill_view("procedure", preprocess=False)
        byte_limit = len(raw.encode("utf-8")) + 100
        self.assertLess(len(raw.encode("utf-8")), byte_limit)
        server = self.transport_server(byte_limit)
        refused = json.loads(server.skill_view("procedure"))
        self.assertFalse(refused.get("success"), refused)
        self.assertIn("HERMES_VIEW_TOO_LARGE", refused.get("error", ""))

    def test_host_budget_is_required_and_cannot_be_a_tool_argument_default(self) -> None:
        for environment in ({}, {"TRYLO_HERMES_VIEW_MAX_BYTES": ""}, {"TRYLO_HERMES_VIEW_MAX_BYTES": "0"},
                            {"TRYLO_HERMES_VIEW_MAX_BYTES": "-1"}, {"TRYLO_HERMES_VIEW_MAX_BYTES": "not-a-budget"}):
            with self.assertRaisesRegex(ValueError, "hermes_view_transport_budget_required"):
                require_view_max_bytes(environment)
        self.assertEqual(require_view_max_bytes({"TRYLO_HERMES_VIEW_MAX_BYTES": "65536"}), 65_536)
        self.assertTrue(view_reply_fits("中" * 100, 100, 300))
        self.assertFalse(view_reply_fits("😀" * 100, 100, 300))
        self.assertFalse(view_reply_fits("a" * 101, 100, 300))

    def ui_adapter(self, source: str):
        if source == "desktop":
            path = Path(__file__).resolve().parents[8] / "desktop" / "sidecars" / "hermes-capabilities" / "skills_adapter.py"
        else:
            path = Path(__file__).resolve().parent.parent / "vendor" / "legacy" / "hermes-capabilities" / "skills_adapter.py"
        spec = importlib.util.spec_from_file_location(f"ui_read_contract_{source}", path)
        assert spec is not None and spec.loader is not None
        adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(adapter)
        if UNGUARDED_UI:
            # Test-only old view operation; mocked shell below means this red
            # probe never executes a shell command or needs a shell installed.
            adapter._read_skill_view = adapter.skill_view
        return adapter

    def ui_request(self, adapter, request: dict) -> tuple[int, dict]:
        output = io.StringIO()
        with patch.object(sys, "stdin", io.StringIO(json.dumps(request))), redirect_stdout(output):
            code = adapter.main()
        return code, json.loads(output.getvalue())

    def test_ui_skill_view_never_executes_inline_shell_and_keeps_native_envelope(self) -> None:
        for source in ("desktop", "internal"):
            with self.subTest(source=source):
                adapter = self.ui_adapter(source)
                with patch("agent.skill_preprocessing.load_skills_config", return_value={"inline_shell": True}), patch(
                    "agent.skill_preprocessing.run_inline_shell", return_value="UI_SHELL_EXECUTED"
                ) as shell:
                    code, body = self.ui_request(adapter, {"op": "view", "name": "procedure", "hermes_home": str(self.home)})
                self.assertEqual(code, 0, body)
                self.assertTrue(body.get("success"), body)
                self.assertEqual(body["schemaVersion"], 1)
                self.assertEqual(body["hermesVersion"], "0.19.0")
                self.assertEqual(body["op"], "view")
                self.assertEqual(body["name"], "procedure")
                self.assertEqual(body["path"], "procedure/SKILL.md".replace("/", os.sep))
                self.assertEqual(body["skill_dir"], str(self.skill))
                self.assertIn("linked_files", body)
                shell.assert_not_called()
                self.assertIn("!`printf trylo-inline-example`", body["content"])
                self.assertNotIn("UI_SHELL_EXECUTED", body["content"])
                self.assertIn(str(self.skill), body["content"])
                self.assertNotIn("${HERMES_SKILL_DIR}", body["content"])

    def test_ui_read_preserves_disabled_template_option_and_native_lookup_refusal(self) -> None:
        for source in ("desktop", "internal"):
            with self.subTest(source=source):
                adapter = self.ui_adapter(source)
                with patch("agent.skill_preprocessing.load_skills_config", return_value={"inline_shell": True, "template_vars": False}), patch(
                    "agent.skill_preprocessing.run_inline_shell", return_value="UI_SHELL_EXECUTED"
                ) as shell:
                    code, body = self.ui_request(adapter, {"op": "view", "name": "procedure"})
                self.assertEqual(code, 0, body)
                self.assertIn("${HERMES_SKILL_DIR}", body["content"])
                shell.assert_not_called()
                code, refused = self.ui_request(adapter, {"op": "view", "name": "../procedure"})
                self.assertEqual(code, 1)
                self.assertFalse(refused.get("success"), refused)


if __name__ == "__main__":
    unittest.main()
