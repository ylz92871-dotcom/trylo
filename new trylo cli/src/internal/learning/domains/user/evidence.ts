import { hashUserText } from "../shared/privacy.js";
import { shortId, sha256Hex } from "../shared/hash.js";
import {
  unansweredFiveQuestions,
  type EvidenceEventKind,
  type EvidenceSourceFacts,
  type InformednessStage,
  type UserEvidence,
} from "./contracts.js";

export type ExtractEvidenceInput = {
  readonly text: string;
  readonly eventKind?: EvidenceEventKind;
  readonly source: EvidenceSourceFacts;
  readonly informedness?: InformednessStage;
  readonly durability?: UserEvidence["durability"];
  readonly signalKind?: UserEvidence["signalKind"];
  readonly now?: number;
};

const CORRECTION_MARK = /你理解错|不是这个意思|我说的是|改成|纠正|你搞错|重做/;
const CHOICE_MARK = /就选|用这个方案|定这个/;
const APPROVAL_MARK = /可以|同意|就这样定|批准/;
const INTERVENTION_MARK = /停一下|先停|别继续|等一下再/;
const OFF_TOPIC_MARK = /吃|电影|音乐|天气|午饭/;

function claimFor(eventKind: EvidenceEventKind, text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const head = trimmed.slice(0, 180);

  switch (eventKind) {
    case "correction":
      return `用户明确纠正当前理解：${head}`;
    case "choice":
      return `用户在当前任务中做了选择：${head}`;
    case "approval":
      return `用户认可了当前做法：${head}`;
    case "rejection":
      return `用户拒绝了当前做法：${head}`;
    case "override":
    case "intervention":
      return `用户在执行过程中进行了干预：${head}`;
    case "explicit_statement":
      return `用户表达了协作偏好：${head}`;
  }
}

function eventKindFor(text: string, hint?: EvidenceEventKind): EvidenceEventKind {
  if (hint !== undefined) {
    return hint;
  }

  if (CORRECTION_MARK.test(text)) {
    return "correction";
  }

  if (CHOICE_MARK.test(text)) {
    return "choice";
  }

  if (INTERVENTION_MARK.test(text)) {
    return "intervention";
  }

  if (APPROVAL_MARK.test(text)) {
    return "approval";
  }

  return "explicit_statement";
}

function governanceFor(kind: EvidenceEventKind): 1 | 2 {
  switch (kind) {
    case "correction":
    case "explicit_statement":
    case "override":
    case "intervention":
      return 2;
    case "choice":
    case "approval":
    case "rejection":
      return 1;
  }
}

function semanticFor(kind: EvidenceEventKind): number {
  switch (kind) {
    case "correction":
    case "explicit_statement":
    case "override":
    case "intervention":
      return 0.9;
    case "choice":
    case "approval":
    case "rejection":
      return 0.55;
  }
}

/**
 * 从一条用户原文抽取证据快照。
 *
 * Raw/Inferred 分离是硬边界：`rawText` 逐字保存原文，`claim` 是解读；
 * 两者是两个字段，永不合并。五问逐项可答，答不上来就保持 null，
 * 不许拿别项的分数来填。返回 null 表示"连证据都抽不出来"
 * （空文本，或与工程协作明显无关），不是"证据很弱"。
 */
export function extractEvidence(input: ExtractEvidenceInput): UserEvidence | null {
  const rawText = input.text.trim();
  if (rawText.length === 0) {
    return null;
  }

  if (OFF_TOPIC_MARK.test(rawText)) {
    return null;
  }

  const eventKind = eventKindFor(rawText, input.eventKind);
  const claim = claimFor(eventKind, rawText);
  if (claim === null) {
    return null;
  }

  const textHash = hashUserText(rawText);
  const sourceHash = `sh_${sha256Hex(
    [input.source.sessionId, input.source.turnId ?? "", input.source.actionId ?? "", rawText].join(""),
  )}`;
  const now = input.now ?? Date.now();

  return {
    id: shortId("ev", [sourceHash, textHash]),
    rawText,
    claim,
    eventKind,
    durability: input.durability ?? "session_local",
    signalKind: input.signalKind ?? "task_requirement",
    answers: {
      ...unansweredFiveQuestions(),
      semantic: semanticFor(eventKind),
      relevance: 0.86,
      contextInformedness: input.informedness ?? "unknown",
      governance: governanceFor(eventKind),
    },
    source: input.source,
    sourceHash,
    textHash,
    createdAt: now,
  };
}
