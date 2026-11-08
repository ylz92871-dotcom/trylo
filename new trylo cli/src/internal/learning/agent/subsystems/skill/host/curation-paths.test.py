"""Native skill-directory lookup contracts; no models or skill mutations.

Use --adapter=<saved-baseline.py> to demonstrate the pre-fix red cases, or omit
the argument to exercise the internal adapter. The Desktop copy is byte-paired.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SUBSYSTEM = Path(__file__).resolve().parent.parent
CAPABILITIES = SUBSYSTEM / "vendor" / "legacy" / "hermes-capabilities"
ADAPTER = CAPABILITIES / "curation_adapter.py"
for argument in sys.argv[1:]:
    if argument.startswith("--adapter="):
        ADAPTER = Path(argument.partition("=")[2]).resolve()
        sys.argv.remove(argument)
        break


class CurationPathContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.initial_home = os.environ.get("HERMES_HOME")
        cls.bootstrap = tempfile.TemporaryDirectory(prefix="trylo-curation-import-")
        os.environ["HERMES_HOME"] = cls.bootstrap.name
        sys.path.insert(0, str(CAPABILITIES))
        spec = importlib.util.spec_from_file_location("curation_path_contract_adapter", ADAPTER)
        assert spec is not None and spec.loader is not None
        cls.adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.adapter)
        from tools import skill_manager_tool, skill_provenance, skills_tool
        cls.native = skill_manager_tool
        cls.provenance = skill_provenance
        cls.skills = skills_tool

    @classmethod
    def tearDownClass(cls) -> None:
        if cls.initial_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = cls.initial_home
        sys.path.remove(str(CAPABILITIES))
        cls.bootstrap.cleanup()

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="trylo-curation-paths-")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        os.environ["HERMES_HOME"] = str(self.home)
        self.local = self.home / "skills"
        self.external = self.home / "external-skills"
        self.local.mkdir()
        self.external.mkdir()
        roots = patch("agent.skill_utils.get_all_skills_dirs", return_value=[self.local, self.external])
        roots.start()
        self.addCleanup(roots.stop)

    def seed(self, directory: Path, name: str, metadata: str) -> Path:
        directory.mkdir(parents=True)
        (directory / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: Synthetic directory contract.\n{metadata}---\n\nRead actual task inputs.\n",
            encoding="utf-8",
        )
        return directory

    def scan(self, expected: Path, names: list[str]) -> dict:
        calls = []

        def scanner(directory, source):
            self.assertEqual(directory, expected)
            self.assertEqual(source, "community")
            self.assertTrue((directory / "SKILL.md").is_file())
            calls.append(directory)
            return SimpleNamespace(verdict="safe", findings=[])

        with patch.object(self.adapter, "scan_skill", side_effect=scanner):
            result = self.adapter._build_verdicts(names)
        self.assertEqual(calls, [expected])
        return result

    def test_category_directory_supplies_actual_scan_and_metadata(self) -> None:
        target = self.seed(self.local / "reports" / "summary", "summary", "applies_to_platform: [windows]\ndeprecated: true\n")
        self.assertEqual(self.scan(target, ["summary"]), {"summary": {"verdict": "safe", "reasons": []}})
        self.assertEqual(self.adapter._build_frontmatter(["summary"]), {
            "summary": {"applies_to_platform": ["windows"], "deprecated": True},
        })

    def test_external_directory_is_resolved_by_the_same_native_lookup(self) -> None:
        target = self.seed(self.external / "external-procedure", "external-procedure", "applies_to_workspace: [synthetic]\n")
        self.assertEqual(self.scan(target, ["external-procedure"])["external-procedure"]["verdict"], "safe")
        self.assertEqual(self.adapter._build_frontmatter(["external-procedure"]), {
            "external-procedure": {"applies_to_workspace": ["synthetic"]},
        })

    def test_native_name_precedence_wins_over_a_same_name_external_skill(self) -> None:
        target = self.seed(self.local / "category" / "shared", "shared", "deprecated: false\n")
        self.seed(self.external / "shared", "shared", "deprecated: true\n")
        self.assertEqual(self.native._find_skill("shared")["path"], target)
        self.assertEqual(self.scan(target, ["shared"])["shared"]["verdict"], "safe")
        self.assertEqual(self.adapter._build_frontmatter(["shared"]), {"shared": {"deprecated": False}})

    def test_missing_skill_stays_unknown_without_scanning_a_guessed_path(self) -> None:
        with patch.object(self.adapter, "scan_skill", side_effect=AssertionError("missing skill must not be scanned")) as scanner:
            self.assertEqual(self.adapter._build_verdicts(["missing"]), {"missing": {"verdict": "unknown", "reasons": []}})
            scanner.assert_not_called()
        self.assertEqual(self.adapter._build_frontmatter(["missing"]), {"missing": {}})

    def test_graph_metadata_never_counts_as_a_background_review_read(self) -> None:
        target = self.seed(self.local / "category" / "summary", "summary", "deprecated: false\n")
        graph = {"nodes": [{"id": "summary", "kind": "skill", "category": "reports"}], "edges": [], "clusters": [], "stats": {}}
        token = self.provenance.set_current_write_origin("background_review")
        read_token = self.native._background_review_read_paths.set(frozenset())
        try:
            with patch.object(self.adapter, "build_learning_graph", return_value=graph), \
                patch.object(self.adapter, "usage_report", return_value=[]), \
                patch.object(self.adapter, "scan_skill", return_value=SimpleNamespace(verdict="safe", findings=[])), \
                patch.object(self.skills, "skill_view", side_effect=AssertionError("summary must not activate a skill")), \
                patch.object(self.native, "mark_background_review_skill_read", side_effect=AssertionError("summary must not authorize a write")):
                summary = self.adapter.build_summary()
            self.assertTrue(summary["success"])
            self.assertEqual(summary["frontmatter"]["summary"], {"deprecated": False})
            self.assertFalse(self.native._background_review_has_read(target / "SKILL.md"))
            self.assertEqual(self.native._background_review_read_paths.get(), frozenset())
        finally:
            self.native._background_review_read_paths.reset(read_token)
            self.provenance.reset_current_write_origin(token)


if __name__ == "__main__":
    unittest.main()
