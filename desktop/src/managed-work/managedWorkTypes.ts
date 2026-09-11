// Trylo Desktop — managed-work shared types (P3 §7.3).
//
// Desktop is a separate package from `trylo cli` (which owns the authoritative
// `ManagedChildBinding` contract in `src/tools/AgentTool/managed-work/`). This
// mirrors the minimal subset the desktop persistence/recovery layer needs, so
// the renderer never imports CLI internals.

export type ManagedWorkStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

/** Durable cross-runtime binding persisted by Desktop/Conversation history
 *  (P3 §7.3). Uniqueness: `managedSessionId`. Replaying a tool call with an
 *  existing `parentToolUseId` MUST return the original binding, never create a
 *  second session. */
export interface ManagedChildBinding {
  childId: string;
  projectKey: string;
  conversationId: string;
  parentRunId: string;
  parentToolUseId: string;
  managedSessionId: string;
  backingTaskId?: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}
