import type { ExpertConfiguration, ExpertOrigin, ExpertRequestAssociation } from "./contracts.js";

/** Transport payloads contain no authority context. Host supplies that separately. */
export type ExpertCommand =
  | { readonly operation: "query"; readonly text?: string }
  | { readonly operation: "get"; readonly expertId: string; readonly version?: number }
  | { readonly operation: "requests" }
  | { readonly operation: "request"; readonly requestId: string }
  | { readonly operation: "submit"; readonly origin: ExpertOrigin; readonly instruction: string; readonly expertId?: string; readonly requestId?: string; readonly association?: ExpertRequestAssociation }
  | { readonly operation: "build" | "authorize_creation"; readonly requestId: string }
  | { readonly operation: "edit"; readonly requestId: string; readonly edits: Partial<ExpertConfiguration> }
  | { readonly operation: "retain"; readonly requestId: string;
      readonly result: { readonly kind: "save" | "temporary" } | { readonly kind: "revise"; readonly feedback: string } }
  | { readonly operation: "archive"; readonly expertId: string }
  | { readonly operation: "draft_revision"; readonly expertId: string; readonly requestId?: string };
