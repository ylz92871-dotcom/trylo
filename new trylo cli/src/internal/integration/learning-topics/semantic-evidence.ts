import { isTopicSemanticText, type TopicSemanticEvidenceProjector } from "./evidence.js";
import { redactText } from "../../credentials/redact.js";
import { redactJsonValue } from "../../protocol/redact.js";

/**
 * Reuses the host's explicit user-collection gate. A statement is evidence of
 * what the user said, never a checker verdict, causal conclusion or permission.
 * Long statements are omitted rather than silently changing their meaning.
 */
export function createUserStatementTopicProjector(options: {
  readonly collect: () => boolean;
  readonly secrets: readonly string[];
}): TopicSemanticEvidenceProjector {
  const secrets = Object.freeze([...options.secrets]);
  return event => {
    if (!options.collect() || (event.kind !== "turn_start" && event.kind !== "user_correction")) return undefined;
    const source = event.payload.text;
    if (typeof source !== "string" || source.length > 8192 || source.trim().length === 0) return undefined;
    const text = redactJsonValue(redactText(source, secrets));
    if (!isTopicSemanticText(text)) return undefined;
    return Object.freeze({ origin: "user_statement", text });
  };
}
