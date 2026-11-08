# Trylo UI maintainability

Owner decision, 2026-11-08: keep UI changes maintainable as features grow; evaluate component extraction separately from runtime or state-ownership changes.

## Current work scope

The owner subsequently deferred the standalone Desktop UI split and prioritized learning-system work. Keep the assessment and isolated candidate as reference only, not a pending implementation task. Apply these rules to prevent new coupling during authorized feature work; do not start a separate refactor or expand verification solely because an existing file is large. A later explicit request may reopen a bounded extraction.

## Mandatory Code / Work parity

Owner decision, 2026-11-09: UI work must update Code and Work together. A change is incomplete when the same capability has a new interface in one mode and an older interface in the other.

- Trace both production entry points before editing. Sharing a component name is insufficient: compare actual props, callbacks, scope keys, labels and state projection so one mode cannot silently miss the new behavior.
- Reuse the same component, view/controller boundary and interaction rules for equivalent capabilities: conversation/composer controls, results, files/previews, tools, configuration, errors, approvals and input requests. Repair both callers in the same task; do not create parallel UI copies or promise the other mode later.
- Preserve truthful domain differences such as Code Git/check facts and Work verification/version facts, but present them through the shared layout and behavior. A mode-only field is not an excuse to keep two versions of the same UI. Record genuinely inapplicable cases and their domain reason.
- Keep project/conversation/turn/mode identity, history access, keyboard/focus, cancellation and late-response handling consistent. UI parity must not merge result stores, attachment partitions, execution controllers or approval authorities, or expand permissions.
- Verify the affected scenario through both real callers or production composition. Cover relevant empty/running/waiting/failed/stopped/completed and navigation states; include theme, narrow layouts and long/many items when affected. Small shared copy/style changes still require a two-mode check, not an unrelated full regression.
- Before delivery, state what changed in each mode, which implementation is shared, what remains a justified domain difference and what the paired checks actually proved. Do not infer native or installed-package parity from isolated browser proof.

## Boundaries and ownership

- Identify the view's responsibility, authoritative state owner, persistence writer, direct consumers and lifetime before changing its structure. File size and growing counts of callbacks, effects or unrelated props trigger review; line counts alone do not prescribe a split.
- Keep screens focused on composing existing owners and views. Feature policy, protocol translation and persistence operations belong to their owning domain or host modules. Do not keep appending unrelated state, effects and business branches to a root screen because the first implementation happened there.
- Use specific readonly view data and semantic actions as typed props, or existing slots. Do not pass an entire App state, its setters, a controller registry or an unrelated callback bag into a child merely to move code out of sight.
- Keep derived views as projections. Reuse existing conversation, result, attachment, execution and permission owners; an extraction must not create synchronized state copies. A hook should bind one cohesive lifecycle rather than become a second large application controller.
- Reuse controls and domain components when their behavior and lifecycle match. Preserve established layout, theme, accessibility and interaction conventions. Share common semantics without forcing Code and Work policies into a universal component.

## Extraction and asynchronous wiring

- Classify the actual change: controlled presentation extraction; local display-state/subscription relocation; or domain state, persistence, host and execution-lifecycle changes. A large parent does not make an independent display component inherently high-risk.
- Preserve component keys, identity, controlled/uncontrolled behavior, slot absence and mounting rules. An element that returns `null` can differ from an absent slot when its parent wraps truthy slots. Check focus, scroll, drafts and expansion across navigation and remounts.
- Give listeners, subscriptions, timers and disposables one owner and matching cleanup. Moving a hook into a conditional panel changes its lifetime; confirm hidden/remounted views retain intended state. Avoid duplicate initialization and stale subscriptions.
- Bind asynchronous reads and writes to the original workspace, conversation, run and request identity. A delayed result updates its original target or is rejected as stale. Navigation must not retarget a write, discard a durable result or cancel healthy execution.
- Preserve existing execution/cancellation ownership. For Desktop, reuse `ConversationRunSupervisor`, result repositories/projectors, the attachment store and `RemoteController` at their established boundaries. React cleanup must not acquire a stop-all policy. Keep pending-send identity checks, permission snapshots and observer ordering intact.
- For an authorized refactor, extract one cohesive boundary at a time. Avoid giant `useApp` hooks, broad global contexts and frameworks that merely relocate the dependency graph. Discuss ownership or product-mechanism changes before implementing them; preserve the already authorized scope.

## Readability and prevention

- Separate declarations and meaningful validation, preparation, action and cleanup phases with blank lines. Keep a value next to its immediate validation. Expand crowded same-line statements without changing behavior.
- Prefer concise English comments explaining responsibility, ownership, non-obvious ordering and recovery. Preserve useful existing comments; avoid narrating syntax or adding repeated banners.
- Before finishing, check whether the change adds an independent reason to modify the parent, widens a child to unrelated responsibilities, duplicates state or introduces an effect with unclear ownership. Put new responsibilities at their owning boundaries during the authorized change.

## Evidence proportional to the boundary

- Inspect the actual caller and rendered slot. Use focused checks for callback routing, original-scope writes, late events, cancellation and cleanup when those boundaries change. A regression test must demonstrate the failure it detects, not merely count props or check filenames.
- Use real production components in small composition tests. Fixtures that copy App callbacks or replace every meaningful child cannot prove production wiring remains correct; record that coverage gap.
- For rendered changes, compare the real browser view and relevant states: empty/populated, loading/failure, navigation/remount, expansion, keyboard/focus and responsive layout as applicable. An isolated trial establishes feasibility; identify it as a candidate, not adoption.
- Browser evidence proves the view and interactions exercised. It does not prove native IPC, process cancellation, provider execution, persisted recovery or installed-package adoption. Add focused host/integration evidence for changed host boundaries. Presentation extraction does not automatically require a full native build, paid calls or full-system regression.
- Preserve permissions, approvals, learning mechanisms/switches, schemas and user runtime locations. Do not add execution budgets or unrelated restrictions during UI cleanup. Report changed boundaries, actual checks, uncertainty and a rollback path preserving pre-existing and parallel edits.
