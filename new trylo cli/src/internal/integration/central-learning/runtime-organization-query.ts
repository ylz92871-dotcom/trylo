import { contentHashOf } from "../../learning/control/hash.js";
import type { CentralDeliberationRequest, CentralLearningIntentDraft, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { OrganizationRecallQuery } from "../../learning/central/organization/contracts.js";
import { isCentralOriginalContextMaterial } from "./runtime-context-materials.js";
import { projectContentSourceText } from "../learning-content/sources/source-text-view.js";
import { readOrganizationQuerySource } from "./organization-query-source.js";
import { centralJudgmentControlRefs } from "../../learning/central/runtime/judgment.js";

const unique = (refs: readonly string[]) => [...new Set(refs)];
const excerpt = (text: string, maximum: number) => text.length <= maximum ? text
  : `${text.slice(0, maximum)} [retrieval context excerpt; original source references remain readable]`;
const original = (refs: readonly string[]) => refs.filter(ref => !ref.startsWith("organization-")
  && !ref.startsWith("central-runtime-purpose-") && !ref.startsWith("central-organization-"));
const keys = (intent: CentralLearningIntentDraft) => [`plane:${intent.subject.plane}`,
  ...(intent.subject.plane === "agent" ? [`domain:${intent.subject.domain}`] : []),
  ...intent.conditions.map(condition => `condition:${contentHashOf(condition)}`)];

/** Current actual source text participates even before a native issue or learning
 * agenda exists. These excerpts navigate organization hypotheses; they do not
 * replace the original source, prove applicability or create business evidence. */
export function buildCentralOrganizationRecallQuery(input: Pick<CentralDeliberationRequest, "state" | "opportunities">
  & { readonly materials?: readonly CentralRuntimeMaterial[] },
  trusted: { readonly scope: string; readonly secrets?: readonly string[] } = { scope: input.state.scope }): OrganizationRecallQuery {
  if (input.state.scope !== trusted.scope) throw new Error("organization_scope_mismatch");

  // A query is public navigation prose, not the source owner's structural
  // metadata. Project complete text before excerpting; retain the original
  // materials and exact references without changing an already delivered packet.
  const publicText = (text: string, ref: string) => projectContentSourceText({ ref, runId: ref,
    sequence: 0, scope: trusted.scope, origin: "model_proposal", text }, trusted.secrets ?? []).record.text;
  const active = input.state.intents.filter(intent => intent.continuation.kind !== "ended");
  const activeIds = new Set(active.map(intent => intent.intentId));
  const judgmentRefs = centralJudgmentControlRefs([...(input.materials ?? []), ...input.state.materials]);
  const actual = (input.materials ?? []).filter(material => isCentralOriginalContextMaterial(material, judgmentRefs));
  const purposes = excerpt(publicText([...active.map(intent => [intent.goal, ...intent.conditions, ...intent.residual].join("\n")),
    ...input.opportunities.map(item => item.description)].join("\n"), "organization-retrieval-purpose"), 1700);
  const current = excerpt(actual.slice(0, 4).map(material => excerpt(publicText(
    readOrganizationQuerySource(material, trusted.scope)?.text ?? material.text, material.ref), 900)).join("\n"), 1900);
  const purpose = [purposes, current].filter(text => text.trim().length > 0).join("\n")
    || "Organize the remaining authorized learning purposes.";

  return { purpose, conditionKeys: unique([...active.flatMap(keys),
    ...input.opportunities.map(item => `plane:${item.subject.plane}`),
    ...input.opportunities.flatMap(item => item.subject.plane === "agent" ? [`domain:${item.subject.domain}`] : [])]).slice(0, 32),
  sourceRefs: unique(original([...active.flatMap(intent => intent.continuation.kind === "ready" ? intent.continuation.operation.sourceRefs
    : intent.continuation.kind === "waiting" ? intent.continuation.wait.sourceRefs : []),
    ...input.state.completed.filter(row => activeIds.has(row.intentId)).flatMap(row => row.resultRefs),
    ...actual.flatMap(material => [material.ref, ...material.sourceRefs]),
    ...active.flatMap(intent => intent.sourceRefs), ...input.opportunities.map(item => item.sourceRef)]))
    .filter(ref => !judgmentRefs.has(ref)).slice(0, 64),
  maximumEntries: 8, maximumCharacters: 24000 };
}
