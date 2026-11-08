import type {
  WorkflowImprovementEvidence, WorkflowImprovementFeedback,
  WorkflowImprovementProposal, WorkflowOpportunity, WorkflowProcessContract, WorkflowProcessTask,
} from "../improvement/contracts.js";

export function sourceNavigationProcess(): WorkflowProcessContract {
  return { key: "repository-source-navigation-v1", inputContract: "current repository snapshot and requested symbols",
    outputContract: "complete current source evidence with file references", sideEffects: "read_only",
    checkContract: "source ownership and evidence completeness" };
}

/** Test-only public facts. No successful execution of the proposed procedure is preloaded. */
export function searchImprovementFixture(): {
  readonly opportunity: WorkflowOpportunity;
  readonly evidence: readonly WorkflowImprovementEvidence[];
  readonly proposal: WorkflowImprovementProposal;
} {
  const task: WorkflowProcessTask = {
    scope: "repo:workspace-a",
    taskFamily: { id: "source-navigation", intentClass: "locate_owner", checkKind: "acceptance", language: "typescript" },
    conditions: { repoLayout: "monorepo-v1", evidenceMode: "read_only" },
    process: sourceNavigationProcess(),
  };
  return {
    opportunity: {
      opportunityId: "opportunity:repeated-search", issueKey: "search:discarded-directory-evidence", task,
      trigger: "repeated_inefficiency", problem: "Whole-repository searches repeatedly truncate after an owning directory was found.",
      desiredOutcome: "Locate the owning implementation with complete evidence and fewer discarded search results.",
      evidenceRefs: ["receipt:search-1", "receipt:search-2"],
    },
    evidence: [
      { ref: "receipt:search-1", kind: "rework", summary: "A whole-repository search truncated; an owning directory was identified.", executionId: "run:search-1" },
      { ref: "receipt:search-2", kind: "rework", summary: "The next search repeated the whole-repository scope and truncated again.", executionId: "run:search-1" },
      { ref: "receipt:layout", kind: "context", summary: "The repository layout is monorepo-v1; reads are authorized." },
    ],
    proposal: {
      diagnosis: {
        hypothesis: "Ignoring the already located owning directory causes repeated broad searches.",
        supportingRefs: ["receipt:search-1", "receipt:search-2"], counterEvidenceRefs: [],
        alternatives: ["The expected implementation may not exist in the current snapshot."],
        discriminateBy: ["Check the directory owner and snapshot before treating an empty search as absence."],
      },
      procedure: {
        name: "Reuse owner evidence before content search", requiredConditions: { ...task.conditions },
        assumptions: [{ claim: "The previously located owner still exists.", check: "Inspect the owner directory and its snapshot anchor." }],
        steps: [
          { id: "confirm-owner", action: "Confirm the owning directory from current directory evidence.",
            inputs: ["located owner", "current repository snapshot"], outputs: ["current owner directory"], dependsOn: [],
            verify: "The directory exists and belongs to the requested implementation.",
            onFailure: { action: "replan", reason: "A missing or moved owner invalidates the cached location." } },
          { id: "scoped-search", action: "Search independent symbols together within the confirmed owner directory.",
            inputs: ["current owner directory", "requested symbols"], outputs: ["complete relevant source evidence"], dependsOn: ["confirm-owner"],
            when: { fact: "owner_confirmed", equals: "yes" }, verify: "Results are complete and support the requested conclusion.",
            onFailure: { action: "replan", reason: "Incomplete or empty owner results require a new scope decision." } },
        ],
        qualityInvariants: ["Do not infer missing implementation from truncated results.", "Conclusions must cite current source evidence."],
        invalidationSignals: ["The directory owner or repository snapshot changes."],
        stopRules: ["Stop repeating an unchanged search after it yields no new evidence."],
      },
      changes: [{ kind: "reuse", stepIds: ["confirm-owner", "scoped-search"],
        before: "Repeat every search over the complete repository.",
        after: "Confirm and reuse owner evidence, then batch independent queries inside that owner.",
        rationale: "The second broad search discarded a usable narrowing decision.",
        evidenceRefs: ["receipt:search-1", "receipt:search-2"], expectedEffect: "Reduce repeated exploration while retaining complete source evidence." }],
    },
  };
}

export function improvementFeedbackFixture(overrides: Partial<WorkflowImprovementFeedback> = {}): WorkflowImprovementFeedback {
  return {
    feedbackId: "feedback:use-1", useId: "use:1", versionId: "workflow:proposal-v1", executionId: "execution:candidate-a",
    task: searchImprovementFixture().opportunity.task,
    exposure: "reported_used", quality: "passed", evidenceRefs: ["receipt:current-check"],
    followedStepIds: ["confirm-owner", "scoped-search"],
    processEvidence: hostCompleteSearchProcessEvidence(overrides.executionId),
    explanation: "The test host independently observed the complete selected path and a passing source-evidence check.",
    ...overrides,
  };
}

/** Synthetic trusted-host process receipts for contract tests, never real-study evidence. */
export function hostCompleteSearchProcessEvidence(
  executionId = "execution:candidate-a",
): Extract<NonNullable<WorkflowImprovementFeedback["processEvidence"]>, { kind: "complete" }> {
  return { kind: "complete", checkerRef: "checker:source-navigation-process-v1",
    evidenceRefs: [`receipt:${executionId}:observed-confirm-owner`, `receipt:${executionId}:observed-scoped-search`],
    checkedStepIds: ["confirm-owner", "scoped-search"], skippedStepIds: [] };
}

export function hostPartialSearchProcessEvidence(
  checkedStepIds: readonly string[] = ["confirm-owner"],
): Extract<NonNullable<WorkflowImprovementFeedback["processEvidence"]>, { kind: "partial" }> {
  return { kind: "partial", checkerRef: "checker:source-navigation-process-v1",
    evidenceRefs: ["receipt:observed-selected-fragment"], checkedStepIds };
}

/** A conditional recovery branch can remain unexposed on a complete normal path. */
export function searchImprovementWithRecoveryFixture(): ReturnType<typeof searchImprovementFixture> {
  const fixture = searchImprovementFixture();
  return { ...fixture, proposal: { ...fixture.proposal,
    procedure: { ...fixture.proposal.procedure, steps: [...fixture.proposal.procedure.steps,
      { id: "recover-moved-owner", action: "Locate a moved owner from current package metadata before restarting search.",
        inputs: ["current package metadata", "requested symbols"], outputs: ["updated owning directory"], dependsOn: [],
        when: { fact: "owner_moved", equals: "yes" }, verify: "The updated directory owns the requested implementation.",
        onFailure: { action: "replan", reason: "Unknown ownership requires a new scope decision." } }] } } };
}

export function measuredSearchComparison(): NonNullable<WorkflowImprovementFeedback["comparison"]> {
  return {
    comparisonKey: "pair:input-a", baselineExecutionId: "execution:baseline-a", candidateExecutionId: "execution:candidate-a",
    baselineQuality: "passed", baselineCost: 8, candidateCost: 3, unit: "tool_calls",
    evidenceRefs: ["receipt:baseline-a", "receipt:candidate-a"],
  };
}
