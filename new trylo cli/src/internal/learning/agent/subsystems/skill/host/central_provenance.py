"""Host-only repair through Hermes' native provenance writer.

The managed host proves the original Board research/create/apply association.
No MCP tool exposes this operation. This adapter verifies the exact native
receipts and current body again; it never edits a skill or rewrites old origin.
"""
from __future__ import annotations

import hashlib
import json


def _hash(content: str) -> str:
    return hashlib.sha256(json.dumps(content, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def dispatch(request: dict, upstream) -> dict:
    proof = request.get("proof")
    if not isinstance(proof, dict) or request.get("mode") not in {"inspect", "repair"}:
        return {"success": False, "code": "hermes_origin_repair_invalid"}
    original, approved, audit = proof.get("originalPending"), proof.get("approvedCreation"), proof.get("audit")
    if not all(isinstance(value, dict) for value in (original, approved, audit)):
        return {"success": False, "code": "hermes_origin_repair_invalid"}
    payload = original.get("payload")
    if not isinstance(payload, dict) or payload.get("action") != "create" or not isinstance(payload.get("content"), str):
        return {"success": False, "code": "hermes_origin_repair_invalid"}
    payload_hash = "sha256:" + hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    name = payload.get("name")
    if (not isinstance(name, str) or original.get("origin") != "assistant_tool"
            or original.get("id") != audit.get("pendingId") or audit.get("name") != name
            or payload_hash != original.get("payloadHash") or payload_hash != approved.get("payloadHash")
            or approved.get("pendingId") != original.get("id") or approved.get("action") != "create"
            or approved.get("skillName") != name or approved.get("committed") is not True
            or approved.get("instructionHash") != _hash(payload["content"])
            or not all(isinstance(audit.get(key), str) and audit[key] for key in
                       ("jobId", "grantId", "issueId", "researchRecordRef", "outcomeRef"))):
        return {"success": False, "code": "hermes_origin_repair_invalid"}

    body = json.loads(upstream.skill_view(name, preprocess=False))
    if not body.get("success") or not isinstance(body.get("content"), str):
        return {"success": False, "code": "hermes_origin_repair_body_unavailable"}
    raw = body["content"]
    body_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    if _hash(raw) != proof.get("expectedCurrentInstructionHash") or body_hash != proof.get("expectedCurrentBodySha256"):
        return {"success": False, "code": "hermes_origin_repair_body_changed"}
    from tools.skill_usage import get_record, mark_agent_created

    before = get_record(name)
    if before.get("pinned") or before.get("created_by") not in (None, "agent") or not before.get("created_at"):
        return {"success": False, "code": "hermes_origin_repair_metadata_changed"}
    inspected = {"success": True, "repairRef": proof.get("repairRef"), "name": name,
                 "instructionHash": _hash(raw), "bodySha256": body_hash, "metadata": before}
    if request["mode"] == "inspect":
        return inspected
    previous = request.get("previous")
    if (not isinstance(previous, dict) or previous.get("repairRef") != proof.get("repairRef")
            or previous.get("instructionHash") != _hash(raw) or not isinstance(previous.get("metadata"), dict)):
        return {"success": False, "code": "hermes_origin_repair_metadata_changed"}
    expected = previous["metadata"]
    if {key: value for key, value in before.items() if key != "created_by"} != {
            key: value for key, value in expected.items() if key != "created_by"}:
        return {"success": False, "code": "hermes_origin_repair_metadata_changed"}
    if before.get("created_by") is None:
        # The pinned native owner owns its lock, eligibility and JSON format.
        # Never write usage files or the skill body directly from Trylo.
        mark_agent_created(name)
    after = get_record(name)
    current = json.loads(upstream.skill_view(name, preprocess=False))
    unchanged = current.get("success") and current.get("content") == raw
    only_origin = {key: value for key, value in after.items() if key != "created_by"} == {
        key: value for key, value in before.items() if key != "created_by"}
    if after.get("created_by") != "agent" or not unchanged or not only_origin:
        return {"success": False, "code": "hermes_origin_repair_not_confirmed", "repairRef": proof.get("repairRef"),
                "before": before, "after": after, "bodyUnchanged": bool(unchanged)}
    return {"success": True, "repairRef": proof.get("repairRef"), "status": "repaired" if before.get("created_by") is None else "already_agent",
            "before": before, "after": after, "instructionHash": _hash(raw), "bodySha256": body_hash, "bodyUnchanged": True}
