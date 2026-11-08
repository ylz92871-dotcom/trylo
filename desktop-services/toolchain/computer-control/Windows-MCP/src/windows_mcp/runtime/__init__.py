"""Typed runtime contracts for the Windows computer-control V2 pipeline."""

from windows_mcp.runtime.errors import ComputerControlError, ErrorCode, StructuredError
from windows_mcp.runtime.results import (
    ACTION_RESULT_SCHEMA_VERSION,
    ActionResult,
    DispatchStatus,
    EffectStatus,
    RuntimeWarning,
    TargetReceipt,
    VerificationEvidence,
    accepted_unknown_result,
    confirmed_success_result,
    dispatched_unknown_result,
)
from windows_mcp.runtime.identity import ElementRef, ProcessInstanceRef, WindowRef
from windows_mcp.runtime.generation_registry import GenerationRegistry
from windows_mcp.runtime.observations import InteractionNode, ObservationReceipt
from windows_mcp.runtime.predicates import Predicate, PredicateOperator, PredicateTruth
from windows_mcp.runtime.snapshot_store import SnapshotStore
from windows_mcp.runtime.target_resolver import ResolvedTarget, TargetResolver
from windows_mcp.runtime.verifier import PostconditionVerifier

__all__ = [
    "ACTION_RESULT_SCHEMA_VERSION",
    "ActionResult",
    "ComputerControlError",
    "DispatchStatus",
    "EffectStatus",
    "ElementRef",
    "ErrorCode",
    "GenerationRegistry",
    "RuntimeWarning",
    "InteractionNode",
    "ObservationReceipt",
    "ProcessInstanceRef",
    "Predicate",
    "PredicateOperator",
    "PredicateTruth",
    "PostconditionVerifier",
    "SnapshotStore",
    "StructuredError",
    "TargetReceipt",
    "TargetResolver",
    "ResolvedTarget",
    "VerificationEvidence",
    "WindowRef",
    "accepted_unknown_result",
    "confirmed_success_result",
    "dispatched_unknown_result",
]
