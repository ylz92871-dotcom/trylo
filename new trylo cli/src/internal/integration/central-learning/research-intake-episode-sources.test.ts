import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { buildContentDomainFeedbackBasisRecord } from "../learning-content/sources/domain-feedback-basis.js";
import { centralMaterialFromPage } from "./deliberation-material.js";
import { centralResearchReadSourceSignatures } from "./research-intake-episode-sources.js";

const scope = "workspace:source-signatures";

test("business manifest JSON retains actual source identity instead of being classified by words in its body", () => {
  const body = canonicalJson({ role: "manifest", files: ["business.json"] });
  const page = { ref: "session:business", originalRef: "session:business", originalScope: scope,
    origin: "execution_result" as const, owner: "session" as const, coordinate: { runId: "business:run", sequence: 1 },
    start: 0, end: body.length, totalChars: body.length, text: body, sourceHash: contentHashOf(body) };
  const first = centralResearchReadSourceSignatures([centralMaterialFromPage(page)], scope);
  const later = centralResearchReadSourceSignatures([centralMaterialFromPage({ ...page, coordinate: { ...page.coordinate, sequence: 2 } })], scope);

  assert.equal(first.length, 1);
  assert.equal(later.length, 1);
  assert.notDeepEqual(first, later);
});

test("canonical host basis remains navigation both as a complete read and as source pages", () => {
  const basis = buildContentDomainFeedbackBasisRecord({ sourceRef: "owner:current-frame", sourceRefs: Array.from({ length: 256 }, (_value, i) => `native:reference:${i}`),
    records: [] }, "issue:owner", scope);
  const page = { ref: basis.ref, originalRef: basis.ref, originalScope: scope, origin: basis.origin, owner: "board" as const,
    coordinate: { runId: basis.runId, sequence: basis.sequence }, start: 0, end: basis.text.length, totalChars: basis.text.length,
    text: basis.text, sourceHash: contentHashOf(basis.text) };
  const complete = centralMaterialFromPage(page), prefix = centralMaterialFromPage({ ...page, text: basis.text.slice(0, 200), end: 200 });
  const suffix = centralMaterialFromPage({ ...page, start: 200, text: basis.text.slice(200) });

  assert.deepEqual(centralResearchReadSourceSignatures([complete], scope), []);
  assert.deepEqual(centralResearchReadSourceSignatures([prefix, suffix], scope), []);
});
