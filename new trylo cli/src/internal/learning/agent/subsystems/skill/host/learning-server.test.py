"""Native, isolated-store contracts for the review bridge (no model calls).

Use the pinned Hermes Python environment. --unguarded selects the original
legacy server to establish that the new regression assertions can fail.
"""

from __future__ import annotations

import contextvars
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


UNGUARDED = "--unguarded" in sys.argv
if UNGUARDED:
    sys.argv.remove("--unguarded")
LEGACY_APPROVAL = "--legacy-approval" in sys.argv
if LEGACY_APPROVAL:
    sys.argv.remove("--legacy-approval")

SPEC = importlib.util.spec_from_file_location("review_bridge", Path(__file__).with_name("learning-server.py"))
assert SPEC is not None and SPEC.loader is not None
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)


def content(name: str, body: str = "Follow the observed procedure.") -> str:
    return f"---\nname: {name}\ndescription: Reuse the observed procedure.\n---\n\n# Procedure\n\n{body}\n"


class LearningServerContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.initial_home = os.environ.get("HERMES_HOME")
        cls.initial_profile = os.environ.get("TRYLO_MCP_PROFILE")
        cls.bootstrap = tempfile.TemporaryDirectory(prefix="trylo-review-bootstrap-")
        os.environ["HERMES_HOME"] = cls.bootstrap.name
        directory = Path(__file__).resolve().parent.parent / "vendor" / "legacy" / "hermes-capabilities"
        cls.server = BRIDGE.load_legacy_server(directory)
        from tools import skill_manager_tool, skill_usage, skills_tool
        from tools.skill_provenance import reset_current_write_origin, set_current_write_origin

        cls.native = skill_manager_tool
        cls.usage = skill_usage
        cls.skills = skills_tool
        cls.set_origin = staticmethod(set_current_write_origin)
        cls.reset_origin = staticmethod(reset_current_write_origin)

    @classmethod
    def tearDownClass(cls) -> None:
        for name, value in (("HERMES_HOME", cls.initial_home), ("TRYLO_MCP_PROFILE", cls.initial_profile)):
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        cls.bootstrap.cleanup()

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="trylo-review-contract-")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        os.environ["HERMES_HOME"] = str(self.home)
        self.write_gate(True)
        self.server._skill_view = self.skills.skill_view
        self.server._skill_manage = self.native.skill_manage
        self.limit = self.server.MAX_TOOL_CHARS
        self.addCleanup(setattr, self.server, "MAX_TOOL_CHARS", self.limit)
        if not UNGUARDED:
            BRIDGE.install_learning_guards(self.server)

    def review_mode(self, mode: str, max_view_bytes: int | None = None, review_origin: str = "native") -> None:
        self.server._skill_view = self.skills.skill_view
        self.server._skill_manage = self.native.skill_manage
        if not UNGUARDED:
            BRIDGE.install_learning_guards(self.server, mode, max_view_bytes, review_origin)

    def write_gate(self, enabled: bool) -> None:
        value = "true" if enabled else "false"
        (self.home / "config.yaml").write_text(f"skills:\n  write_approval: {value}\n", encoding="utf-8")

    def seed(self, name: str = "task-procedure", body: str = "Follow the observed procedure.") -> Path:
        token = self.set_origin("background_review")
        try:
            result = json.loads(self.native.apply_skill_pending({
                "action": "create", "name": name, "content": content(name, body)
            }))
        finally:
            self.reset_origin(token)
        self.assertTrue(result.get("success"), result)
        return self.home / "skills" / name

    def view(self, name: str, file_path: str | None = None) -> dict:
        # Separate sibling contexts mirror distinct MCP request tasks.
        result = contextvars.Context().run(self.server.skill_view, name, file_path)
        return json.loads(result)

    def propose(self, action: str, name: str = "task-procedure", **kwargs) -> dict:
        result = contextvars.Context().run(self.server.skill_propose, action, name, **kwargs)
        return json.loads(result)

    def pending(self) -> list[dict]:
        return self.server._wa.list_pending("skills")

    def approval_admin(self, source: str):
        if source == "desktop":
            path = Path(__file__).resolve().parents[8] / "desktop" / "sidecars" / "hermes-capabilities" / "admin.py"
        else:
            path = Path(__file__).resolve().parent.parent / "vendor" / "legacy" / "hermes-capabilities" / "admin.py"
        spec = importlib.util.spec_from_file_location(f"approval_contract_{source}", path)
        assert spec is not None and spec.loader is not None
        admin = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(admin)
        if LEGACY_APPROVAL:
            # Test-only reproduction of the old approved replay, with no
            # product flag or change to the frozen failure snapshot.
            admin._replay_approved_skill = lambda rec: admin.apply_skill_pending(rec.get("payload") or {})
        return admin

    def approve(self, admin, pending_id: str, mode: str = "snapshot") -> dict:
        record = admin.wa.get_pending("skills", pending_id)
        expected_hash = admin._payload_hash(record["payload"])
        result = admin.apply_pending("skills", pending_id, expected_hash) if mode == "generic" else \
            admin.apply_skill_with_snapshot(pending_id, expected_hash, "isolated-approval-contract")
        return json.loads(result)

    def test_unread_patch_is_refused_before_staging(self) -> None:
        directory = self.seed()
        before = (directory / "SKILL.md").read_text(encoding="utf-8")
        result = self.propose("patch", old_string="observed", new_string="corrected")
        self.assertFalse(result.get("success"), result)
        self.assertTrue(result.get("_read_before_write_required"), result)
        self.assertEqual(self.pending(), [])
        self.assertEqual((directory / "SKILL.md").read_text(encoding="utf-8"), before)

    def test_read_in_prior_request_allows_only_native_pending(self) -> None:
        directory = self.seed()
        before = (directory / "SKILL.md").read_text(encoding="utf-8")
        self.assertTrue(self.view("task-procedure")["success"])
        result = self.propose("patch", old_string="observed", new_string="corrected")
        self.assertTrue(result.get("staged"), result)
        records = self.pending()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["id"], result["pending_id"])
        self.assertEqual(records[0]["origin"], "background_review")
        self.assertEqual(records[0]["payload"]["new_string"], "corrected")
        self.assertEqual((directory / "SKILL.md").read_text(encoding="utf-8"), before)

    def test_supporting_file_requires_its_exact_read(self) -> None:
        directory = self.seed()
        reference = directory / "references" / "case.md"
        reference.parent.mkdir()
        reference.write_text("Observed workaround.", encoding="utf-8")
        self.assertTrue(self.view("task-procedure")["success"])
        denied = self.propose("patch", file_path="references/case.md", old_string="Observed", new_string="Corrected")
        self.assertFalse(denied.get("success"), denied)
        self.assertTrue(self.view("task-procedure", "references/case.md")["success"])
        staged = self.propose("patch", file_path="references/case.md", old_string="Observed", new_string="Corrected")
        self.assertTrue(staged.get("staged"), staged)
        self.assertEqual(reference.read_text(encoding="utf-8"), "Observed workaround.")

    def test_skill_deletion_and_main_file_removal_are_unavailable(self) -> None:
        directory = self.seed()
        self.assertTrue(self.view("task-procedure")["success"])
        for action, args in (("delete", {}), ("remove_file", {"file_path": "SKILL.md"})):
            result = self.propose(action, **args)
            self.assertFalse(result.get("success"), result)
        self.assertEqual(self.pending(), [])
        self.assertTrue((directory / "SKILL.md").is_file())

    @unittest.skipUnless(os.name == "nt", "Windows case-insensitive alias contract")
    def test_directory_alias_cannot_remove_the_main_skill_under_different_case(self) -> None:
        directory = self.seed()
        references = directory / "references"
        references.mkdir()
        alias = references / "root-alias"
        try:
            alias.symlink_to(directory, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"Directory symlink unavailable: {type(error).__name__}")
        self.assertTrue(self.view("task-procedure")["success"])
        self.assertTrue((alias / "skill.md").is_file())
        result = self.propose("remove_file", file_path="references/root-alias/skill.md")
        self.assertFalse(result.get("success"), result)
        self.assertIn("main SKILL.md", result.get("error", ""))
        self.assertEqual(self.pending(), [])
        self.assertTrue((directory / "SKILL.md").is_file())

    def test_native_pinned_ownership_guard_is_preserved(self) -> None:
        self.seed()
        self.usage.set_pinned("task-procedure", True)
        self.assertTrue(self.view("task-procedure")["success"])
        result = self.propose("patch", old_string="observed", new_string="corrected")
        self.assertFalse(result.get("success"), result)
        self.assertEqual(self.pending(), [])

    def test_oversized_view_does_not_grant_read_mark(self) -> None:
        self.seed()
        self.server.MAX_TOOL_CHARS = 40
        # Legacy truncation produces malformed JSON, also a red regression.
        result = self.view("task-procedure")
        self.assertFalse(result.get("success"), result)
        self.server.MAX_TOOL_CHARS = self.limit
        result = self.propose("patch", old_string="observed", new_string="corrected")
        self.assertFalse(result.get("success"), result)
        self.assertEqual(self.pending(), [])

    def test_astral_reply_inside_native_character_cap_cannot_leave_a_read_mark_before_host_truncation(self) -> None:
        directory = self.seed()
        target = directory / "SKILL.md"
        target.write_text(content("task-procedure", "observed " + "😀" * 17_000), encoding="utf-8")
        native_reply = self.skills.skill_view("task-procedure", preprocess=False)
        host_bytes = 65_536  # Explicit synthetic host input; production reads the TS-owned envelope.
        self.assertLess(len(native_reply), self.server.MAX_TOOL_CHARS)
        self.assertGreater(len(native_reply.encode("utf-8")), host_bytes)
        self.review_mode("implicit", host_bytes)
        refused = self.view("task-procedure")
        self.assertFalse(refused.get("success"), refused)
        self.assertIn("HERMES_REVIEW_VIEW_TOO_LARGE", refused.get("error", ""))
        denied = self.propose("patch", old_string="observed", new_string="corrected")
        self.assertFalse(denied.get("success"), denied)
        self.assertTrue(denied.get("_read_before_write_required"), denied)
        self.assertEqual(self.pending(), [])

        # A complete subsequent read may authorize staging, never direct application.
        target.write_text(content("task-procedure", "observed normal procedure"), encoding="utf-8")
        viewed = self.view("task-procedure")
        self.assertTrue(viewed.get("success"), viewed)
        self.assertEqual(viewed["content"], target.read_text(encoding="utf-8"))
        staged = self.propose("patch", old_string="observed", new_string="corrected")
        self.assertTrue(staged.get("staged"), staged)
        self.assertIsInstance(staged.get("pending_id"), str)
        self.assertEqual(self.pending()[0]["id"], staged["pending_id"])
        self.assertIn("observed normal procedure", target.read_text(encoding="utf-8"))

    def test_oversized_linked_text_cannot_authorize_a_support_file_patch(self) -> None:
        directory = self.seed()
        reference = directory / "references" / "case.md"
        reference.parent.mkdir()
        reference.write_text("observed " + "😀" * 17_000, encoding="utf-8")
        native_reply = self.skills.skill_view("task-procedure", "references/case.md", preprocess=False)
        host_bytes = 65_536
        self.assertLess(len(native_reply), self.server.MAX_TOOL_CHARS)
        self.assertGreater(len(native_reply.encode("utf-8")), host_bytes)
        self.review_mode("implicit", host_bytes)
        self.assertFalse(self.view("task-procedure", "references/case.md").get("success"))
        denied = self.propose("patch", file_path="references/case.md", old_string="observed", new_string="corrected")
        self.assertFalse(denied.get("success"), denied)
        self.assertTrue(denied.get("_read_before_write_required"), denied)
        self.assertEqual(self.pending(), [])

    def test_disabled_gate_never_writes_active_skill(self) -> None:
        self.write_gate(False)
        result = self.propose("create", "new-procedure", content=content("new-procedure"))
        self.assertFalse(result.get("success"), result)
        self.assertFalse((self.home / "skills" / "new-procedure").exists())
        self.assertEqual(self.pending(), [])

    def test_create_and_support_file_stage_then_require_ordered_approval(self) -> None:
        created = self.propose("create", "new-procedure", content=content("new-procedure"))
        self.assertTrue(created.get("staged"), created)
        support = self.propose("write_file", "new-procedure", file_path="references/case.md", file_content="Concrete case.")
        self.assertTrue(support.get("staged"), support)
        self.assertFalse((self.home / "skills" / "new-procedure").exists())
        before_create = self.propose("patch", "new-procedure", old_string="observed", new_string="corrected")
        self.assertFalse(before_create.get("success"), before_create)
        records = {record["id"]: record for record in self.pending()}
        self.assertEqual(len(records), 2)
        support_payload = records[support["pending_id"]]["payload"]
        out_of_order = json.loads(self.native.apply_skill_pending(support_payload))
        self.assertFalse(out_of_order.get("success"), out_of_order)
        # Explicit native replay here simulates user approval in the isolated
        # fixture; the MCP review surface has no such operation.
        approved = json.loads(self.native.apply_skill_pending(records[created["pending_id"]]["payload"]))
        self.assertTrue(approved.get("success"), approved)
        approved_support = json.loads(self.native.apply_skill_pending(support_payload))
        self.assertTrue(approved_support.get("success"), approved_support)
        path = self.home / "skills" / "new-procedure" / "references" / "case.md"
        self.assertEqual(path.read_text(encoding="utf-8"), "Concrete case.")

    def test_unconfirmed_stage_receipt_is_not_reported_as_staged(self) -> None:
        with patch.object(self.server._wa, "get_pending", return_value=None):
            result = self.propose("create", "new-procedure", content=content("new-procedure"))
        self.assertFalse(result.get("success"), result)
        self.assertEqual(len(self.pending()), 1)
        self.assertFalse((self.home / "skills" / "new-procedure").exists())

    def test_ui_approved_create_remains_revisable_after_foreground_use(self) -> None:
        for source in ("desktop", "internal"):
            for mode in ("generic", "snapshot"):
                with self.subTest(source=source, mode=mode):
                    admin = self.approval_admin(source)
                    name = f"approval-{source}-{mode}"
                    staged = self.propose("create", name, content=content(name))
                    self.assertTrue(staged.get("staged"), staged)
                    approved = self.approve(admin, staged["pending_id"], mode)
                    self.assertTrue(approved.get("committed"), approved)
                    self.assertEqual(self.usage.get_record(name)["created_by"], "agent")
                    # Match the actual foreground observer's native helpers.
                    self.usage.bump_view(name)
                    self.usage.bump_use(name)
                    self.assertTrue(self.view(name)["success"])
                    revision = self.propose("patch", name,
                        old_string="Follow the observed procedure.", new_string="Follow the corrected procedure.")
                    self.assertTrue(revision.get("staged"), revision)
                    revised = self.approve(admin, revision["pending_id"], mode)
                    self.assertTrue(revised.get("committed"), revised)
                    actual = (self.home / "skills" / name / "SKILL.md").read_text(encoding="utf-8")
                    self.assertIn("Follow the corrected procedure.", actual)
                    self.assertEqual(self.usage.get_record(name)["created_by"], "agent")
                    # A later independent review must retain native ownership,
                    # but must obtain its own read instead of inheriting marks.
                    self.review_mode("implicit")
                    unread = self.propose("patch", name,
                        old_string="Follow the corrected procedure.", new_string="Follow the revised reusable procedure.")
                    self.assertFalse(unread.get("success"), unread)
                    self.assertTrue(unread.get("_read_before_write_required"), unread)
                    self.assertIn("Follow the corrected procedure.", self.view(name)["content"])
                    next_revision = self.propose("patch", name,
                        old_string="Follow the corrected procedure.", new_string="Follow the revised reusable procedure.")
                    self.assertTrue(next_revision.get("staged"), next_revision)
                    self.assertTrue(self.approve(admin, next_revision["pending_id"], mode).get("committed"))
                    self.assertIn("Follow the revised reusable procedure.",
                        (self.home / "skills" / name / "SKILL.md").read_text(encoding="utf-8"))
                    self.assertEqual(self.usage.get_record(name)["created_by"], "agent")

    def test_approval_origin_never_promotes_foreground_or_failed_create(self) -> None:
        for source in ("desktop", "internal"):
            with self.subTest(source=source):
                admin = self.approval_admin(source)
                name = f"manual-{source}"
                token = self.set_origin("foreground")
                try:
                    staged = json.loads(self.native.skill_manage(action="create", name=name, content=content(name)))
                finally:
                    self.reset_origin(token)
                approved = self.approve(admin, staged["pending_id"])
                self.assertTrue(approved.get("committed"), approved)
                self.assertIsNone(self.usage.get_record(name)["created_by"])
                self.usage.bump_use(name)
                self.assertTrue(self.view(name)["success"])
                revision = self.propose("patch", name,
                    old_string="Follow the observed procedure.", new_string="Follow the corrected procedure.")
                self.assertFalse(revision.get("success"), revision)
                other = f"unapproved-{source}"
                staged = self.propose("create", other, content=content(other))
                failed = json.loads(admin.apply_skill_with_snapshot(staged["pending_id"], "sha256:wrong", "isolated-failure"))
                self.assertFalse(failed.get("success"), failed)
                self.assertFalse((self.home / "skills" / other).exists())
                self.assertNotIn(other, self.usage.load_usage())

    def test_explicit_learning_can_stage_user_directed_manual_revision(self) -> None:
        admin = self.approval_admin("desktop")
        token = self.set_origin("assistant_tool")
        try:
            staged = json.loads(self.native.skill_manage(action="create", name="user-procedure", content=content("user-procedure")))
        finally:
            self.reset_origin(token)
        self.assertTrue(self.approve(admin, staged["pending_id"])["committed"])
        self.usage.bump_use("user-procedure")
        self.assertTrue(self.view("user-procedure")["success"])
        denied = self.propose("patch", "user-procedure",
            old_string="Follow the observed procedure.", new_string="Follow the user-corrected procedure.")
        self.assertFalse(denied.get("success"), denied)
        self.review_mode("explicit")
        # Match upstream foreground semantics: no forged background mark or
        # special ownership override is necessary for a user-directed request.
        allowed = self.propose("patch", "user-procedure",
            old_string="Follow the observed procedure.", new_string="Follow the user-corrected procedure.")
        self.assertTrue(allowed.get("staged"), allowed)
        native = self.server._wa.get_pending("skills", allowed["pending_id"])
        self.assertEqual(native["origin"], "assistant_tool")
        actual = (self.home / "skills" / "user-procedure" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("Follow the observed procedure.", actual)
        self.assertFalse(self.propose("delete", "user-procedure").get("success"))
        self.assertTrue(self.approve(admin, allowed["pending_id"])["committed"])

    def test_explicitly_authored_skill_stays_user_owned_after_ui_approval(self) -> None:
        self.review_mode("explicit")
        staged = self.propose("create", "explicit-procedure", content=content("explicit-procedure"))
        self.assertTrue(staged.get("staged"), staged)
        admin = self.approval_admin("internal")
        self.assertTrue(self.approve(admin, staged["pending_id"])["committed"])
        self.usage.bump_view("explicit-procedure")
        self.usage.bump_use("explicit-procedure")
        self.assertIsNone(self.usage.get_record("explicit-procedure")["created_by"])
        self.review_mode("implicit")
        self.assertTrue(self.view("explicit-procedure")["success"])
        revision = self.propose("patch", "explicit-procedure",
            old_string="Follow the observed procedure.", new_string="Follow the corrected procedure.")
        self.assertFalse(revision.get("success"), revision)

    def test_central_research_origin_and_exact_legacy_repair_preserve_manual_ownership(self) -> None:
        import copy
        import hashlib
        import upstream

        spec = importlib.util.spec_from_file_location("central_origin_repair", Path(__file__).with_name("central_provenance.py"))
        assert spec is not None and spec.loader is not None
        repair = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(repair)
        admin = self.approval_admin("internal")
        self.review_mode("explicit")
        manual = self.propose("create", "manual-procedure", content=content("manual-procedure"))
        self.assertTrue(self.approve(admin, manual["pending_id"])["committed"])
        self.usage.bump_view("manual-procedure")
        self.assertIsNone(self.usage.get_record("manual-procedure")["created_by"])

        # The original defect: central authoring used explicit's user origin.
        legacy = self.propose("create", "legacy-research", content=content("legacy-research"))
        pending = copy.deepcopy(self.server._wa.get_pending("skills", legacy["pending_id"]))
        pending["payloadHash"] = admin._payload_hash(pending["payload"])
        committed = self.approve(admin, legacy["pending_id"])
        self.usage.bump_view("legacy-research")
        clarified = self.propose("patch", "legacy-research", old_string="Follow the observed procedure.",
                                 new_string="Keep the separately approved clarification.")
        self.assertTrue(self.approve(admin, clarified["pending_id"])["committed"])
        current = json.loads(upstream.skill_view("legacy-research", preprocess=False))["content"]
        proof = {"repairRef": "hermes-central-origin-repair:fixture", "originalPending": pending, "approvedCreation": committed,
                 "expectedCurrentInstructionHash": repair._hash(current),
                 "expectedCurrentBodySha256": hashlib.sha256(current.encode("utf-8")).hexdigest(),
                 "audit": {"pendingId": legacy["pending_id"], "name": "legacy-research", "jobId": "native-job",
                           "grantId": "native-grant", "issueId": "research-issue", "researchRecordRef": "verified-research",
                           "outcomeRef": "confirmed-native-outcome"}}
        before = self.usage.get_record("legacy-research")
        broken = copy.deepcopy(proof)
        broken["approvedCreation"]["payloadHash"] = "sha256:wrong"
        self.assertFalse(repair.dispatch({"mode": "inspect", "proof": broken}, upstream)["success"])
        self.assertEqual(self.usage.get_record("legacy-research"), before)
        inspected = repair.dispatch({"mode": "inspect", "proof": proof}, upstream)
        self.assertTrue(inspected["success"], inspected)
        fixed = repair.dispatch({"mode": "repair", "proof": proof, "previous": inspected}, upstream)
        self.assertTrue(fixed["success"], fixed)
        self.assertEqual(fixed["before"]["created_by"], None)
        self.assertEqual(fixed["after"]["created_by"], "agent")
        self.assertTrue(fixed["bodyUnchanged"])
        self.assertEqual(json.loads(upstream.skill_view("legacy-research", preprocess=False))["content"], current)

        self.review_mode("explicit", review_origin="central_research")
        central = self.propose("create", "future-research", content=content("future-research"))
        self.assertEqual(self.server._wa.get_pending("skills", central["pending_id"])["origin"], "background_review")
        self.assertTrue(self.approve(admin, central["pending_id"])["committed"])
        self.assertEqual(self.usage.get_record("future-research")["created_by"], "agent")
        self.review_mode("implicit")
        self.assertTrue(self.view("future-research")["success"])
        self.assertTrue(self.propose("patch", "future-research", old_string="Follow the observed procedure.",
                                     new_string="Follow the confirmed procedure.")["staged"])
        self.assertTrue(self.view("manual-procedure")["success"])
        self.assertFalse(self.propose("patch", "manual-procedure", old_string="Follow the observed procedure.",
                                      new_string="An unauthorized autonomous revision.")["success"])
        self.assertIsNone(self.usage.get_record("manual-procedure")["created_by"])

    def test_another_review_cannot_duplicate_a_native_unapproved_create(self) -> None:
        first = self.propose("create", "pending-procedure", content=content("pending-procedure"))
        self.assertTrue(first.get("staged"), first)
        before = self.server._wa.get_pending("skills", first["pending_id"])
        self.review_mode("implicit")
        duplicate = self.propose("create", "pending-procedure", content=content("pending-procedure", "A later task's technique."))
        self.assertFalse(duplicate.get("success"), duplicate)
        self.assertEqual(duplicate.get("code"), "HERMES_REVIEW_CREATE_PENDING")
        self.assertEqual(duplicate.get("existingPendingId"), first["pending_id"])
        self.assertNotIn("pending_id", duplicate, "an existing proposal is not a new stage receipt")
        self.assertEqual(self.pending(), [before])

    def test_a_different_skill_pending_does_not_block_a_new_create(self) -> None:
        first = self.propose("create", "first-procedure", content=content("first-procedure"))
        self.assertTrue(first.get("staged"), first)
        self.review_mode("implicit")
        second = self.propose("create", "second-procedure", content=content("second-procedure"))
        self.assertTrue(second.get("staged"), second)
        self.assertEqual({item["payload"]["name"] for item in self.pending()}, {"first-procedure", "second-procedure"})

    def test_approved_create_is_found_natively_and_supports_normal_read_then_patch(self) -> None:
        created = self.propose("create", "approved-procedure", content=content("approved-procedure"))
        self.assertTrue(created.get("staged"), created)
        self.assertTrue(self.approve(self.approval_admin("internal"), created["pending_id"])["committed"])
        self.review_mode("implicit")
        duplicate = self.propose("create", "approved-procedure", content=content("approved-procedure"))
        self.assertFalse(duplicate.get("success"), duplicate)
        self.assertNotEqual(duplicate.get("code"), "HERMES_REVIEW_CREATE_PENDING", "the create is already approved, not pending")
        self.assertTrue(self.view("approved-procedure")["success"])
        revised = self.propose("patch", "approved-procedure",
            old_string="Follow the observed procedure.", new_string="Follow the corrected procedure.")
        self.assertTrue(revised.get("staged"), revised)
        self.assertEqual(len(self.pending()), 1)


if __name__ == "__main__":
    unittest.main()
