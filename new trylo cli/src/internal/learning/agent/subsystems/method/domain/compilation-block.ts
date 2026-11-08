import type { MethodExperienceFact } from "./experience-facts.js";

type BlockFact = Extract<MethodExperienceFact, { kind: "decision" }>;

type CompilationIdentity = { readonly versionId: string; readonly scopeId: string; readonly compilationId: string };

/** A previous block is context for the next adoption, not a synthetic failure
 * or a global prohibition. A defer does not certify that its cause was fixed.
 * A new compilation has its own identity and keeps the old block in history. */
export function compilationBlockFor(facts: readonly MethodExperienceFact[], identity: CompilationIdentity,
  features?: Readonly<Record<string, string>>): BlockFact | undefined {
  const pending: CompilationIdentity[] = [identity], seen = new Set<string>();

  // Exact bound dependencies can carry a prior warning without declaring the
  // composed program invalid. Bound traversal is contextual, never a new trial.
  while (pending.length > 0 && seen.size < 32) {
    const current = pending.shift()!;
    if (seen.has(current.compilationId)) continue;

    seen.add(current.compilationId);
    const block = [...facts].reverse().find((fact): fact is BlockFact => fact.kind === "decision" &&
      fact.versionId === current.versionId && fact.decision.scopeId === current.scopeId &&
      fact.decision.compilationId === current.compilationId && fact.decision.action === "block" &&
      (features === undefined || Object.entries(fact.context.features).every(([key, value]) =>
        Object.hasOwn(features, key) && features[key] === value)));
    if (block !== undefined) return block;

    const review = facts.find(fact => fact.kind === "review" && fact.factId === current.compilationId &&
      fact.versionId === current.versionId && fact.scopeId === current.scopeId);
    if (review?.kind === "review") for (const binding of review.relatedBindings ?? []) pending.push(binding);
  }

  return undefined;
}

/** Bounded reminder, charged with the whole delivered slot. Exact feature
 * agreement is not proof of an identical cause; the executor must assess it. */
export function renderCompilationBlock(fact: BlockFact | undefined, maxChars = Number.POSITIVE_INFINITY): string {
  if (fact === undefined) return "";
  const detail = JSON.stringify({ source: fact.versionId, step: fact.decision.step, reason: fact.decision.reason.slice(0, 36),
    ...(fact.decision.facts === undefined ? {} : { facts: fact.decision.facts.slice(0, 48) }) });
  const full = `\n[既往阻塞] ${detail}。采用理由须说明本次如何满足守卫；同样阻塞仍在则deviate并正常分析。`;
  return full.length <= maxChars ? full : "\n[既往阻塞] 采用前expand核对本编译或依赖的旧阻塞；同样阻塞仍在则deviate并正常分析。";
}
