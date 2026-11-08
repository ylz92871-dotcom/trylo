import { identity, sequence } from "../../../validation/json-shape.js";

function address(text: string): string {
  if (text.length > 512) throw new Error("organization_evidence_address_capacity");
  return text;
}

export function organizationEvidenceReadRef(factId: string, asOfSequence: number, offset = 0): string {
  if (!identity(factId) || !sequence(asOfSequence) || !sequence(offset)) throw new Error("organization_evidence_address_invalid");
  return address(`central-organization-evidence:${asOfSequence}:${offset}:${encodeURIComponent(factId)}`);
}

export function readOrganizationEvidenceRef(ref: string): { readonly factId: string; readonly asOfSequence: number; readonly offset: number } | undefined {
  if (!ref.startsWith("central-organization-evidence:")) return undefined;
  const match = /^central-organization-evidence:(\d+):(\d+):(.+)$/.exec(ref);
  if (match === null) throw new Error("organization_evidence_address_invalid");
  const factId = decodeURIComponent(match[3]!), asOfSequence = Number(match[1]), offset = Number(match[2]);
  if (organizationEvidenceReadRef(factId, asOfSequence, offset) !== ref) throw new Error("organization_evidence_address_invalid");
  return { factId, asOfSequence, offset };
}

export function organizationKnowledgeHeadReadRef(factId: string, start = 0): string {
  if (!identity(factId) || !sequence(start)) throw new Error("organization_knowledge_address_invalid");
  return address(`central-organization-head:${encodeURIComponent(factId)}:${start}`);
}

export function readOrganizationKnowledgeHeadRef(ref: string): { readonly factId: string; readonly start: number } | undefined {
  if (!ref.startsWith("central-organization-head:")) return undefined;
  const match = /^central-organization-head:(.+):(\d+)$/.exec(ref);
  if (match === null) throw new Error("organization_knowledge_address_invalid");
  const factId = decodeURIComponent(match[1]!), start = Number(match[2]);
  if (organizationKnowledgeHeadReadRef(factId, start) !== ref) throw new Error("organization_knowledge_address_invalid");
  return { factId, start };
}
