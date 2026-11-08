/**
 * Advanced assistant modes ledger (WP19.3: A10 voice/assistant/Kairos/ultraplan).
 *
 * None of these modes is implemented here, and this ledger exists so that
 * fact stays visible: each entry names the legacy source, why it cannot be
 * claimed as done, and what would have to arrive first. A stub copied into
 * the tree would read as a feature in every listing that counts files — this
 * table reads as the absence it is.
 *
 * Paths are repo-relative to `D:/CC/trylo/trylo cli`, the only baseline this
 * package may draw these modes from.
 */

export const ADVANCED_MODE_EVIDENCE = {
  voiceCommand: "src/commands/voice/index.ts",
  assistantCommand: "src/commands/assistant/index.ts",
  assistantChooserStub: "src/assistant/AssistantSessionChooser.ts",
  // NOTE (F2 lesson): in this TypeScript baseline `.js` is the compiled name.
  // Judging existence by the compiled name (`Test-Path ultraplan.js` = False)
  // once mis-reported ultraplan as missing; the real source is below.
  ultraplanSource: "src/commands/ultraplan.tsx",
  ultraplanUtils: "src/utils/ultraplan/",
} as const;

export type AdvancedModeId = "voice_mode" | "assistant" | "kairos" | "ultraplan";

export type AdvancedModeStatus = {
  readonly id: AdvancedModeId;
  readonly available: false;
  readonly reason: "source_missing" | "conditionally_blocked";
  readonly blockedBy: string;
};

export function advancedAssistantStatus(): ReadonlyArray<AdvancedModeStatus> {
  return [
    {
      id: "voice_mode",
      available: false,
      reason: "conditionally_blocked",
      blockedBy:
        "legacy voice command needs VOICE_MODE + growthbook and a realtime audio backend with device authorization; the lifecycle gate exists (realtime-gate.ts), the backend does not",
    },
    {
      id: "assistant",
      available: false,
      reason: "source_missing",
      blockedBy: `legacy chooser is an explicit stub (${ADVANCED_MODE_EVIDENCE.assistantChooserStub}: returns null to bail out gracefully); a copied stub is not an implementation`,
    },
    {
      id: "kairos",
      available: false,
      reason: "conditionally_blocked",
      blockedBy: "legacy KAIROS entitlement + opt-in behind feature flags and a cloud backend; no local implementation exists in either baseline",
    },
    {
      id: "ultraplan",
      available: false,
      // WP19 复核订正 (F2): real 471-line implementation
      // (`ultraplan.tsx` + `utils/ultraplan/ccrSession,keyword,prompt`), gated
      // by the ULTRAPLAN feature flag and a remote first-party CCR backend —
      // so conditionally blocked, not source-missing.
      reason: "conditionally_blocked",
      blockedBy: `real implementation at ${ADVANCED_MODE_EVIDENCE.ultraplanSource} + ${ADVANCED_MODE_EVIDENCE.ultraplanUtils}, needs the ULTRAPLAN flag and a remote CCR backend with no local substitute`,
    },
  ];
}
