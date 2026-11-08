"""Native catalogue + actual MCP schema contracts. No model calls or waits.

--legacy-truncation substitutes the old bounded-list response in test code;
it accepts the new arguments but reproduces the old broken JSON output.
"""
from __future__ import annotations
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

LEGACY = "--legacy-truncation" in sys.argv
if LEGACY:
    sys.argv.remove("--legacy-truncation")


def module_at(name: str):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), Path(__file__).with_name(name + ".py"))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class SkillListingContract(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_home = os.environ.get("HERMES_HOME")
        self.previous_profile = os.environ.get("TRYLO_MCP_PROFILE")
        self.temporary = tempfile.TemporaryDirectory(prefix="trylo-skill-list-")
        self.home = Path(self.temporary.name)
        os.environ["HERMES_HOME"] = str(self.home)
        (self.home / "config.yaml").write_text("skills:\n  write_approval: true\n", encoding="utf-8")
        for index in range(16):
            self.add_skill(f"procedure-{index:02}", "category" if index % 2 else None)

    def tearDown(self) -> None:
        for key, value in (("HERMES_HOME", self.previous_home), ("TRYLO_MCP_PROFILE", self.previous_profile)):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.temporary.cleanup()

    def add_skill(self, name: str, category: str | None = None) -> None:
        root = self.home / "skills"
        directory = root / category / name if category else root / name
        directory.mkdir(parents=True)
        description = "Reuse the exact observed procedure with the documented prerequisites and verification. " * 2
        (directory / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: {description}\n---\n\n# Procedure\n\nFollow the observed steps.\n", encoding="utf-8")

    def server(self, surface: str = "normal", max_bytes=None):
        module = module_at(surface + "-server")
        directory = Path(__file__).resolve().parent.parent / "vendor" / "legacy" / "hermes-capabilities"
        server = module.load_legacy_server(directory)
        server.MAX_TOOL_CHARS = 1600
        module.install_skill_listing(server, max_bytes)
        if LEGACY:
            server.skills_list = lambda **args: server._bounded(server._skills_list(category=args.get("category")), limit=server.MAX_TOOL_CHARS)
        return server

    def test_default_large_catalogue_is_valid_json_and_every_native_entry_is_reachable(self) -> None:
        for surface in ("normal", "learning"):
            with self.subTest(surface=surface):
                server = self.server(surface)
                expected = json.loads(server._skills_list())["skills"]
                raw = server.skills_list()
                found = []
                while True:
                    self.assertLessEqual(len(raw), server.MAX_TOOL_CHARS)
                    page = json.loads(raw)
                    self.assertTrue(page.get("success"), page)
                    self.assertEqual(page["count"], len(expected))
                    self.assertEqual(page["returnedCount"], len(page["skills"]))
                    self.assertEqual(page["offset"], len(found))
                    self.assertEqual(page["categoryScope"], "page")
                    self.assertEqual(page["categories"], sorted({item["category"] for item in page["skills"] if item["category"]}))
                    found.extend(page["skills"])
                    if page["nextOffset"] is None:
                        break
                    self.assertGreater(page["nextOffset"], page["offset"])
                    raw = server.skills_list(offset=page["nextOffset"], snapshot_hash=page["snapshotHash"])
                self.assertEqual(found, expected, "preserve all native descriptions, null categories and ordering")

    def test_small_default_result_remains_byte_for_byte_native(self) -> None:
        server = self.server()
        server.MAX_TOOL_CHARS = 100_000
        self.assertEqual(server.skills_list(), server._skills_list())
        self.assertEqual(server.skills_list(category="category"), server._skills_list(category="category"))
        self.assertEqual(server.skills_list(category="general"), server._skills_list(category="general"))

    def emoji_descriptions(self) -> None:
        for skill in (self.home / "skills").rglob("SKILL.md"):
            skill.write_text(f"---\nname: {skill.parent.name}\ndescription: {'😀' * 1024}\n---\n\nFollow the observed steps.\n", encoding="utf-8")
        from tools.skills_tool import _SKILLS_CACHE
        _SKILLS_CACHE.clear()

    def test_character_small_but_byte_large_native_catalogue_pages_completely_on_both_surfaces(self) -> None:
        # The original 16 descriptions each contain 1024 native astral chars.
        # A deliberately small host byte budget makes the page boundary visible.
        for surface in ("normal", "learning"):
            with self.subTest(surface=surface):
                server = self.server(surface, max_bytes=6000)
                server.MAX_TOOL_CHARS = 20_000
                self.emoji_descriptions()
                native = server._skills_list()
                expected = json.loads(native)["skills"]
                self.assertEqual(len(expected), 16)
                self.assertLess(len(native), server.MAX_TOOL_CHARS)
                self.assertGreater(len(native.encode("utf-8")), 6000)
                found, pages = [], 0
                raw = server.skills_list()
                while True:
                    self.assertLessEqual(len(raw), server.MAX_TOOL_CHARS)
                    self.assertLessEqual(len(raw.encode("utf-8")), 6000)
                    page = json.loads(raw)
                    self.assertTrue(page.get("success"), page)
                    self.assertEqual(page["count"], len(expected))
                    self.assertEqual(page["offset"], len(found))
                    self.assertEqual(page["returnedCount"], len(page["skills"]))
                    self.assertTrue(all(item["description"] == "😀" * 1024 for item in page["skills"]))
                    found.extend(page["skills"])
                    pages += 1
                    self.assertLessEqual(pages, len(expected))
                    if page["nextOffset"] is None:
                        break
                    self.assertEqual(page["nextOffset"], len(found))
                    raw = server.skills_list(offset=page["nextOffset"], snapshot_hash=page["snapshotHash"])
                self.assertGreater(pages, 1, "the unqualified default must page when only UTF-8 bytes overflow")
                self.assertEqual(found, expected, "retain complete native names, descriptions, categories and order")

    def test_a_single_byte_oversized_native_entry_is_not_skipped_on_either_surface(self) -> None:
        for surface in ("normal", "learning"):
            with self.subTest(surface=surface):
                server = self.server(surface, max_bytes=2000)
                server.MAX_TOOL_CHARS = 20_000
                self.emoji_descriptions()
                refused = server.skills_list(offset=0, limit=1)
                self.assertLessEqual(len(refused), server.MAX_TOOL_CHARS)
                self.assertLessEqual(len(refused.encode("utf-8")), 2000)
                page = json.loads(refused)
                self.assertFalse(page.get("success"), page)
                self.assertEqual(page["code"], "hermes_skill_list_entry_too_large")
                self.assertEqual(page["offset"], 0)
                self.assertNotIn("nextOffset", page)
                self.assertNotIn("skills", page)

    def test_actual_mcp_schema_advertises_transport_arguments_on_both_surfaces(self) -> None:
        for surface in ("normal", "learning"):
            server = self.server(surface)
            advertised = asyncio.run(server.mcp.list_tools())
            schema = next(item.inputSchema for item in advertised if item.name == "skills_list")
            self.assertTrue({"category", "offset", "limit", "snapshot_hash"}.issubset(schema["properties"]))
            self.assertEqual(schema.get("required", []), [])

    def test_changed_catalogue_refuses_continuation_and_new_first_page_is_available(self) -> None:
        server = self.server()
        first = json.loads(server.skills_list(limit=1))
        self.add_skill("new-observed-procedure")
        # Avoid depending on wall-clock TTL when testing the transport's hash.
        from tools.skills_tool import _SKILLS_CACHE
        _SKILLS_CACHE.clear()
        changed = json.loads(server.skills_list(offset=first["nextOffset"], snapshot_hash=first["snapshotHash"]))
        self.assertFalse(changed.get("success"), changed)
        self.assertEqual(changed["code"], "hermes_skill_list_catalog_changed")
        self.assertEqual(changed["restartOffset"], 0)
        restarted = json.loads(server.skills_list(offset=0, limit=1))
        self.assertTrue(restarted.get("success"), restarted)
        self.assertEqual(restarted["count"], 17)

    def test_entry_that_cannot_fit_is_an_explicit_failure_without_skipping(self) -> None:
        server = self.server()
        server.MAX_TOOL_CHARS = 600
        result = json.loads(server.skills_list(offset=0, limit=1))
        self.assertFalse(result.get("success"), result)
        self.assertEqual(result["code"], "hermes_skill_list_entry_too_large")
        self.assertEqual(result["offset"], 0)
        self.assertNotIn("nextOffset", result)

    def test_invalid_pages_do_not_fabricate_empty_success_or_silent_restart(self) -> None:
        server = self.server()
        for arguments in ({"offset": -1}, {"offset": True}, {"limit": 0}, {"limit": 201}, {"offset": 1}):
            result = json.loads(server.skills_list(**arguments))
            self.assertFalse(result.get("success"), (arguments, result))


if __name__ == "__main__":
    unittest.main()
