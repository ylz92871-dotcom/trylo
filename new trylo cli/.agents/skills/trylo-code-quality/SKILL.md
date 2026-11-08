---
name: trylo-code-quality
description: Mandatory for every Trylo code change across all projects, including source, tests, scripts, build configuration, toolchain and services. UI work must keep Code and Work synchronized. Checks permissions first, then readability, state ownership, architecture and proportionate validation. CLI-specific gates apply only to CLI work.
---

# Trylo Code Quality Gate

Treat readability and maintainability as release-blocking requirements.

## Mandatory activation across Trylo

Owner decision, 2026-11-09: every Trylo code task must load, read and apply this skill before modifying code. This includes all product projects and shared source, tests, scripts, build configuration, toolchain and service code. The main agent and every agent editing code must follow it; already-loaded instructions may be reused within the task unless they change. Missing automatic skill discovery is not an exemption: read this repository file directly.

Use the owning project's contracts and proportionate checks. This requirement does not apply CLI-only phases to other projects or authorize unrelated refactors, product changes, permission changes, paid calls or releases.

## Permission-chain correctness comes first

Owner decision, 2026-11-08: permission failures have repeatedly broken real tasks. Check this chain before other implementation work and first in self-review whenever CLI, tools, MCP, Desktop dispatch, installation or runtime packaging is affected. For unrelated changes, record why the chain is unaffected; do not expand a small task into an unrelated permission migration.

- Trace the user's selected mode through the per-run snapshot, CLI flags, sandbox/filesystem scope, host approval decision, tool classifier and actual child process. An enabled tool in fully automatic mode must not become unusable because one layer silently applies a different mode, stale package manifest or narrower implicit scope.
- Separate application authorization, tool availability, protocol/argument validity, filesystem ACLs and Windows integrity labels. `policy_denied` is not evidence of a Low/Medium/High mismatch. Record the actual denying layer and machine-readable reason; do not guess from a visible warning.
- Preserve explicit denials, disabled tools, cancellation and granted scope. Full automation follows the user's authorized scope; it is not permission to bypass standing restrictions. Conversely, unknown syntax, a classifier that lags the shipped binary, or an internal service exception must not invent a standing denial. Correct the contract or return an actionable tool failure and let the model continue.
- Verify all affected tool paths: built-ins, bundled MCP and user-mounted MCP. For bundled runtimes, check the exact binary/interpreter/helper dependency closure, parent/child integrity, ACLs and writable data/cache/temp paths. A standalone executable succeeding does not prove the app-launched tool can run. Respect the existing approved development integrity setting; do not globally elevate, weaken ACLs or change user authorization to make a check pass.
- Treat a refused or undispatched call as one failed tool result with its exact call identity and reason. The model must receive it and be able to choose an allowed alternative or explain the limitation. Single and batched calls, expired approvals, approval transport errors and pre-execution guard errors must not end the whole turn with warnings alone. No denied call may execute, and no failed call may be reported as successful.
- Preserve genuine outcome-unknown and persistence/ownership failures. Do not clear their reconciliation facts or replay an uncertain write. When execution must stop, provide a truthful final explanation through the existing model/reporting owner when possible, or an explicitly system-sourced failure when the provider or writer cannot continue. User cancellation must not trigger another model request.
- Exercise affected modes and failure branches with meaningful local probes, including a permitted tool call, a real refusal, an approval transport failure and continuation after failure. Cover single/batch behavior and the bundled app-to-tool path when changed. Bind source, development output and staged runtime bytes before claiming delivery; distinguish local fixture, native startup and actual provider/task acceptance.
- Audit new permission conditions, hidden token/time/count limits and terminal transitions as product behavior. Do not add speculative restrictions or an automatic retry that changes authority. Report what changed, why it is authorized, which layer refused the original call and how continuation was verified.

## Project scope and UI routing

- Use the owning project's nearest `AGENTS.md`, current contracts and validation commands. CLI phase documents, learning-directory migration scopes and CLI gate commands below apply only to their CLI work; they are not prerequisites for Desktop, mobile or website tasks.
- For UI implementation, component extraction or wiring review, read [UI maintainability](references/ui-maintainability.md). This covers screen composition and controller bindings as well as rendered components.
- Owner decision, 2026-11-09: every UI change must keep Code and Work synchronized. Inspect both real callers, update the shared implementation and any missing wiring in the same task, and verify both modes. Do not deliver one updated mode while leaving the equivalent capability on an older UI. See the mandatory parity gate in the UI reference; truthful domain data differences do not justify duplicate interfaces or merging execution/permission owners.
- Review the responsibility being changed and any new coupling it introduces. Record unrelated existing hotspots without turning a focused task into a product-wide rewrite. A skill update or assessment does not itself authorize a refactor, a new state owner or a product-mechanism change.
- Owner decision, 2026-11-08: standalone Desktop UI splitting is deferred; learning-system work takes priority. Apply maintainability rules preventively within authorized changes. Do not adopt the isolated UI candidate or reopen a separate cleanup effort without a later owner request.
- This engineering skill is read through project instructions. Do not copy it into user `.trylo/skills`, activate a runtime learning asset, or revive retired Agent instruction directories to make it discoverable.

## Module layout and concise comments

Owner decision, 2026-11-08: organize code module by module so maintainers can follow it without reading a wall of statements.

- Use blank lines to separate module declarations and meaningful phases inside a function: validation, preparation, execution, and result or cleanup. Keep related declarations and a value's immediate validation together; do not insert a blank line after every statement.
- Expand crowded same-line statements with whitespace when needed. Keep existing token order, literals, and automatic-semicolon-insertion behavior intact.
- Prefer concise English comments for module responsibilities, state ownership, non-obvious invariants, protocol quirks, and recovery or permission boundaries. Preserve useful existing comments; avoid narrating obvious syntax or adding repetitive section banners.
- For a layout-and-comments-only request, preserve all executable tokens, types, imports, public contracts, and runtime behavior. Do not rename, extract, move, redesign, or fix nearby code as part of the cleanup.
- For layout-and-comments-only changes, compare against the working files captured at task start, including existing uncommitted edits. Verify syntax and emitted JavaScript equivalence in addition to formatting and type checks; protect compiler/tool directives and string/template contents. Keep temporary helpers and raw reports under the repository `_workspace/`.

## Before changing code

1. Read the nearest `AGENTS.md` and owning project contracts. In the CLI, also read `docs/README.md`, the quality discipline, dependency policy and current phase specification.
2. State the behavior contract, affected boundaries, invariants, failure modes, and verification plan.
3. Inspect adjacent implementation and tests. Reuse an existing concept only when it has the same semantics and lifecycle owner.
4. Reject scope that bypasses the current phase exit criteria or creates a second source of truth.

## 禁止防御性编程

Owner decision, 2026-11-07: do not make normal authorized work unusable by inventing conservative execution restrictions.

- Do not silently introduce default cumulative token/cost budgets, request/iteration counts, wall-clock deadlines, retry/compaction counts, or per-response generation caps. A limit needs an actual provider/protocol constraint or an explicit owner/caller requirement, recorded at its owning boundary.
- Distinguish a provider's single-response limit from completion of the user's task. A recoverable output truncation must preserve durable progress and continue the same task; it must not be reported as task failure or fake success.
- Recovery is judged by observed progress and the actual error, not an arbitrary "at most N times this turn" counter. Repeated identical failures without progress remain explicit failures; do not disguise them with an endless retry.
- A server/proxy must preserve an omitted generation allowance. Do not inject a "safe" max_tokens default or a smaller ceiling than a verified model capability; preserve explicit caller limits without silently clamping them.
- Observation waits, pagination, output display windows and background-job polling must not cancel otherwise healthy work or silently discard its durable output.
- Keep explicit user budgets, cancellation, authorization and concrete protocol/data validation authoritative. These are not permission to add unrelated speculative guardrails or to weaken existing permission boundaries.
- Before proposing a new limit, show what real failure it addresses, why continuation/backpressure/progress checks are insufficient, who owns it, and how normal long tasks remain usable. Add regression evidence for work exceeding the former arbitrary limit.

Audit every change for hidden defaults and premature terminal states. Passing a fixture that fits under a cap does not validate long-task usability.

## Learning subsystem organization

The owner confirmed this grouping on 2026-11-03: User Learning and Agent Learning are peer product domains. Agent Learning has one subsystem container, with each subsystem's own implementation inside its own directory. User Learning must not become an Agent Learning subsystem.

Use this target directory convention for the approved grouping; it describes the destination, not the current migration status:

```text
src/internal/learning/
  agent/
    subsystems/
      method/    # method-learning implementation and its local modules
      tool/      # tool-learning implementation and its local modules
```

- Keep each subsystem's learning policy, internal orchestration, asset handling, subsystem-specific ports/adapters, and associated tests together. Split modules within that directory according to responsibility; do not replace dispersed code with one oversized file. A directory containing only re-exports while its implementation remains scattered does not satisfy this rule.
- Keep dependency direction inside each subsystem: domain logic depends on its contracts/ports; adapters depend on the domain, not the reverse. Directory proximity does not authorize domain code to import provider, filesystem, process, CLI, or UI implementations.
- Shared Board persistence, Permission, canonical execution contracts, generic tool/sandbox/provider infrastructure, and UI remain with their existing owners. A subsystem uses those facilities through boundaries; it does not copy them or acquire a second writer. Classify existing tool adapters by actual ownership and callers before moving them; a name containing `tool` alone is not evidence of tool-learning ownership.
- CLI/Desktop composition roots and execution-side bridges may stay in their host layers as thin adapters. Keep subsystem business logic in the subsystem directory and expose cohesive public entrypoints for its consumers. Subsystems must not deep-import a sibling's private implementation.
- Keep old-path compatibility modules only where existing callers need them. They must delegate or re-export the new implementation, contain no duplicated learning logic, and record their remaining consumers and removal condition. Preserve historical evidence/source snapshots in place.

### Current migration scope

The owner's current relocation scope is **existing method learning and tool learning only**. This skill update itself does not move product code.

- Do not move or rewrite User Learning as part of this migration. Its existing paths remain unchanged; its peer relationship to Agent Learning is a domain boundary, not authorization for another relocation.
- **Do not move, rename, refactor, or edit the five new subsystems: skill, workflow, check, routing, and collaboration**, including their dedicated integration and UI modules. Their later, separately assigned tasks will adopt this organization. Their current paths are an explicit temporary exception, not a reason to expand this migration.
- If one of those five imports a method/tool path being moved, preserve a thin compatibility entry at that old path rather than editing the protected consumer. Shared host-file edits are limited to method/tool import or wiring changes and must preserve the other subsystems' behavior and concurrent edits.
- Before moving files, record the source-to-destination mapping, ownership, direct consumers, retained compatibility entries, and affected path-sensitive build/architecture checks. Then perform the authorized relocation; the grouping above does not require another approval. A newly discovered change to a learning mechanism, public behavior, or state ownership must be discussed with the owner before implementation.
- Preserve learning algorithms, public commands/interfaces, runtime data locations, asset identities, persisted schemas, permissions, and current UI behavior. A source-directory cleanup does not authorize data migration, new functionality, a new framework, or moving unrelated infrastructure.

### Verification for a relocation

Use compilation/import resolution, the affected existing contract/regression tests, and necessary path-sensitive architecture/build checks. Update path rules to preserve the same ownership and coverage; do not bypass them with broad exclusions. Once those checks pass, repeat or broaden them only for a demonstrated issue. Directory relocation does not call for paid model runs, learning-effect benchmarks, prolonged endurance tests, or tests that merely assert folder names. Report unrelated existing failures without claiming they passed or absorbing them into an unrequested redesign.

## While designing

1. Keep the core dependent on ports and canonical contracts, never on provider, storage, terminal, Desktop, or UI event details.
2. Give every contractually observable state transition one owner and one canonical event; learning persistence still obeys the collection and retention policy.
3. Prefer small cohesive modules, explicit names, immutable inputs, typed/result-style failures, and pure transformations at boundaries.
4. Replace boolean combinations with explicit states. Make cancellation, timeout, retry, partial delivery, and stale-generation behavior visible.
5. Follow current owner decisions and the authority order in `docs/README.md`; do not treat superseded P00/ADR prerequisites as current learning requirements. Discuss unapproved core learning mechanisms and consequential technical choices with the owner before implementation. An approved directory migration is not approval to redesign those mechanisms.
6. Keep the core PermissionGate independent from every learning hypothesis. Learning can never grant permission or initiate approval; any proposed learned blocker or repair power requires an explicit product decision and contract test.
7. Do not add a dependency until its runtime/development closure, final-artifact placement, A–E architecture tier, notice obligations, type leakage, and replacement path pass the project's license policy. Apache-2.0 is allowed in approved non-core tiers and is not an automatic failure.

## While implementing

1. Keep functions at one level of abstraction and extract policy from mechanics.
2. Comment intent, invariants, protocol quirks, and non-obvious tradeoffs; do not narrate obvious syntax.
3. Avoid hidden global state, ambient mutable configuration, implicit retries, catch-all errors, unbounded queues, and time-dependent tests.
4. Every `catch` needs a terminal branch — rethrow, a typed failure, or a comment stating the cleanup contract. An `instanceof`-narrowed catch that lets other exception types vanish is structurally legal error-swallowing (the 2026-09 mcp-http incident); check siblings for drift and extract shared failure vocabulary instead of writing it twice.
5. Ambient sources (clock, randomness, process surfaces) appear only as injection-seam defaults (`options.now ?? Date.now`) or in gate-allowlisted files; `as unknown as` only at allowlisted persistence boundaries — verify step 3 rejects the rest.
6. Validate all external input at the boundary and convert it once into canonical domain values; persistence read boundaries validate payload shapes at runtime (guard + fail-closed), never a blind cast.
7. Preserve causal identifiers, version hashes, cancellation tokens, and terminal states across adapters.
8. Add tests at the lowest meaningful layer. Use contract and integration tests for process, provider, protocol, persistence, and recovery boundaries. A new regression test must have been shown red against the unfixed code.

## Mandatory self-review

Review the diff in this order and report findings even when the list is empty:

1. Permissions: does the affected chain preserve the user's selected mode and scope through host, CLI, tool and operating system, with refusal and failure returned to the model instead of silently terminating the turn?
2. Readability: can a new maintainer explain control flow, state ownership, and failure behavior without reconstructing intent?
3. Maintainability: is there one extension point, no duplication of policy, and no speculative abstraction?
   For UI, did both Code and Work adopt the change through their real callers, with paired verification and any genuine mode-only data differences stated?
4. Architecture: are dependency directions and loop/periphery boundaries intact? For learning work, is each subsystem's implementation colocated under its own directory, with shared owners preserved and the current migration exclusions respected?
5. Correctness: do success, failure, cancellation, retry, timeout, and stale events satisfy the contract?
6. Safety: can learned policy or model output expand permissions or bypass approval?
7. Supply chain: are exact versions, source provenance, and the transitive license closure acceptable?
8. Evidence: do checks prove the behavior instead of merely executing code?

## Stop conditions

Do not mark work complete when any of the following holds:

- a public contract changed without a compatibility decision and contract test;
- a new dependency lacks a recorded transitive-license decision;
- a file owns unrelated responsibilities because splitting it was deferred;
- a test asserts implementation details while the externally visible invariant remains untested;
- success is inferred from process exit or agent self-report without the required verification;
- documentation and phase evidence are missing.

## Required handoff

Report changed contracts, architectural impact, checks run, evidence locations, remaining risks, and whether the readability/maintainability gate passed. Keep formal decisions and concise acceptance summaries under the current phase folder in `docs/02-分期工程产出/`; all new raw logs, trial data, screenshots, generated reports and candidate builds belong in the repository `_workspace/`, linked from that summary. The owner's repository layout decision on 2026-11-07 supersedes older raw-evidence output conventions without changing product runtime paths.

For learning-directory migrations, also report the final directory tree, source-to-destination mapping, remaining compatibility entries and their consumers, and confirmation that the five excluded subsystems and User Learning were left in place.
