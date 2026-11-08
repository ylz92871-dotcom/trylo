import {
  submitDraftCommand,
  submitWithdrawCommand,
  type BoardCommandDraft,
} from "../shared/board-command.js";
import { shortId } from "../shared/hash.js";
import { hashUserText } from "../shared/privacy.js";
import {
  domainFailure,
  DRAFT_STATUS,
  type DomainFailure,
  type DraftStatus,
  type Provenance,
  type Scope,
} from "../shared/types.js";
import { decideScope, type ScopeInput } from "./scope.js";
import {
  detectSpeechAct,
  detectsPermissionLanguage,
  isPermissionOnly,
  residualPreference,
  type UserSpeechAct,
} from "./speech-act.js";
import type {
  EligibilityClass,
  EligibilityDecision,
  EligibilityRoute,
  UserEvidence,
} from "./contracts.js";
import { classifyEligibility } from "./eligibility.js";
import { extractEvidence } from "./evidence.js";
import { classifyUserSignal } from "./evidence-grounding.js";

export type UserRuleDraft = {
  readonly kind: "user_rule";
  readonly status: DraftStatus;
  readonly id: string;
  readonly ruleText: string;
  readonly textHash: string;
  readonly scope: Scope;
  /**
   * 浅层言语行为检测的记录（诊断用）。真正的准入闸是资格分类，
   * not_explicit 的输入只要被深链判为 personalization_candidate
   * 同样可以进规则——见 buildImplicit。
   */
  readonly speechAct: UserSpeechAct;
  readonly permissionClaim: false;
  readonly capabilityGranted: "never";
  readonly permissionLanguageDetected: boolean;
  readonly appliesToCurrentTask: boolean;
  readonly diagnostics: {
    readonly scope: Scope;
    readonly conflictWithCurrent: boolean;
    readonly permissionLanguageDetected: boolean;
  };
  readonly provenance: Provenance;
  readonly command: BoardCommandDraft;
};

export type WithdrawCommandDraft = {
  readonly kind: "withdraw";
  readonly status: DraftStatus;
  readonly id: string;
  readonly targetHintHash: string;
  readonly command: BoardCommandDraft;
};

export type UserBuildResult =
  | { readonly kind: "draft"; readonly draft: UserRuleDraft }
  | { readonly kind: "withdraw"; readonly draft: WithdrawCommandDraft }
  | { readonly kind: "routed"; readonly routed: UserRoutedDecision }
  | DomainFailure;

/** 快路径输入：ScopeInput + 可选的证据身份（缺省走 fast-path 本地身份）。 */
export type UserRuleInput = ScopeInput & {
  readonly sessionId?: string;
  readonly turnId?: string;
};

/**
 * 资格闸没过的"该去哪"决定：只产决定，不产规则，不接任何执行终点。
 * 调用方按 route 分发：session_intent → 会话、quality_repair → 当场修、
 * permission_service → 权限、drop_insufficient → 丢弃。
 */
export type UserRoutedDecision = {
  readonly kind: "routed";
  readonly route: EligibilityRoute;
  readonly classification: EligibilityClass;
  readonly evidence: UserEvidence | null;
  readonly eligibility: EligibilityDecision | null;
  readonly rationale: string;
};

function routed(
  route: EligibilityRoute,
  classification: EligibilityClass,
  evidence: UserEvidence | null,
  eligibility: EligibilityDecision | null,
  rationale: string,
): UserBuildResult {
  return { kind: "routed", routed: { kind: "routed", route, classification, evidence, eligibility, rationale } };
}

export function buildUserRule(input: UserRuleInput): UserBuildResult {
  // A permission-only request cannot become a learned preference.
  if (isPermissionOnly(input.text)) {
    return domainFailure(
      "permission_claim_rejected",
      "user text asked for a capability; learning cannot grant permission",
    );
  }

  const speechAct = detectSpeechAct(input.text);
  if (speechAct === "not_explicit") {
    return buildImplicit(input);
  }

  if (speechAct === "withdraw") {
    const id = shortId("uw", [hashUserText(input.text)]);
    return {
      kind: "withdraw",
      draft: {
        kind: "withdraw",
        status: DRAFT_STATUS,
        id,
        targetHintHash: hashUserText(input.text),
        command: submitWithdrawCommand("user_rule", id),
      },
    };
  }

  const permissionLanguageDetected = detectsPermissionLanguage(input.text);
  const ruleText = residualPreference(input.text);
  const scopeDecision = decideScope(input, speechAct);
  if (scopeDecision.kind === "too_broad") {
    return domainFailure(
      "scope_too_broad",
      "a single complaint cannot become a user-global rule",
      ["user_global"],
    );
  }

  // D3 硬门：先落证据、先过资格闸，只有 personalization_candidate 才进规则。
  const gate = passEligibilityGate(input, speechAct, ruleText);
  if (gate.kind === "routed") {
    return gate;
  }

  return finishDraft(input, speechAct, scopeDecision.scope, ruleText, permissionLanguageDetected);
}

function finishDraft(
  input: UserRuleInput,
  speechAct: UserSpeechAct,
  scope: Scope,
  ruleText: string,
  permissionLanguageDetected: boolean,
): UserBuildResult {
  const conflictWithCurrent =
    input.currentInstruction !== undefined &&
    currentInstructionWins(input.currentInstruction, ruleText).conflict;
  const id = shortId("ur", [hashUserText(ruleText), scope.kind, scope.id]);
  const draft: UserRuleDraft = {
    kind: "user_rule",
    status: DRAFT_STATUS,
    id,
    ruleText,
    textHash: hashUserText(input.text),
    scope,
    speechAct,
    permissionClaim: false,
    capabilityGranted: "never",
    permissionLanguageDetected,
    appliesToCurrentTask: conflictWithCurrent === false,
    diagnostics: {
      scope,
      conflictWithCurrent,
      permissionLanguageDetected,
    },
    provenance: {
      source: "user_explicit",
      observationRefs: [id],
      createdBy: "user_builder",
    },
    command: submitDraftCommand("user_rule", id),
  };

  return { kind: "draft", draft };
}

export function currentInstructionWins(
  currentInstruction: string,
  historicalRule: string,
): {
  readonly winner: "current_instruction";
  readonly conflict: boolean;
} {
  return {
    winner: "current_instruction",
    conflict: currentInstruction.trim() !== historicalRule.trim(),
  };
}

/**
 * 无明确言语行为的输入：先走一遍证据 + 资格。
 * 判为 personalization_candidate（对象行为明确的持久偏好，只是没套
 * "以后都这样"句式）→ 同样进规则；其他类别按类路由；
 * 抓不住（insufficient 或连证据都抽不出）才维持旧的 not_explicit。
 */
function buildImplicit(input: UserRuleInput): UserBuildResult {
  const scopeDecision = decideScope(input, "not_explicit");
  if (scopeDecision.kind === "too_broad") {
    return domainFailure(
      "scope_too_broad",
      "a single complaint cannot become a user-global rule",
      ["user_global"],
    );
  }

  const evidence = extractFastEvidence(input, "not_explicit");
  if (evidence === null) {
    return domainFailure("not_explicit", "no explicit correction, confirm, withdraw, or future directive");
  }

  const eligibility = classifyEligibility({ evidence, speechAct: "not_explicit" });
  if (eligibility.classification === "personalization_candidate") {
    return finishDraft(
      input,
      "not_explicit",
      scopeDecision.scope,
      residualPreference(input.text),
      detectsPermissionLanguage(input.text),
    );
  }

  if (eligibility.classification === "insufficient_information") {
    return domainFailure("not_explicit", "no explicit correction, confirm, withdraw, or future directive");
  }

  return routed(eligibility.route, eligibility.classification, evidence, eligibility, eligibility.rationale);
}

/** D3 硬门：显式言语行为也必须先过资格闸。 */
function passEligibilityGate(
  input: UserRuleInput,
  speechAct: Exclude<UserSpeechAct, "withdraw" | "not_explicit">,
  residualText: string,
): UserBuildResult | { readonly kind: "pass" } {
  const evidence = extractFastEvidence(input, speechAct);
  if (evidence === null) {
    return routed(
      "drop_insufficient",
      "insufficient_information",
      null,
      null,
      "no evidence could be extracted; nothing enters the rule path",
    );
  }

  const eligibility = classifyEligibility({ evidence, speechAct, residualText });
  if (eligibility.classification !== "personalization_candidate") {
    return routed(eligibility.route, eligibility.classification, evidence, eligibility, eligibility.rationale);
  }

  return { kind: "pass" };
}

function extractFastEvidence(
  input: UserRuleInput,
  speechAct: UserSpeechAct,
): UserEvidence | null {
  const eventKind = speechAct === "correction" ? "correction" : "explicit_statement";
  const signal = classifyUserSignal(input.text, eventKind);

  return extractEvidence({
    text: input.text,
    eventKind,
    source: {
      sessionId: input.sessionId ?? "fast-path",
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    },
    durability: signal.durability,
    signalKind: signal.signalKind,
  });
}
