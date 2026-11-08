import type { Envelope } from "../../protocol/envelope.js";
import type { LearningPortShape } from "../user-learning/port.js";
import type { MethodEventSink } from "../../learning/agent/subsystems/method/index.js";
import { LEARNING_FENCE } from "../../learning/agent/subsystems/method/index.js";
import { DEFAULT_METHOD_GRANT } from "../../learning/agent/subsystems/method/index.js";
import { prepareCommonTopicPrompt } from "../../learning/domains/shared/topics/submission.js";
import { readTopicSubmission } from "../../learning/domains/shared/topics/submission.js";
import type { LearningDomain } from "../../learning/control/contracts.js";
import type { TopicLearningSystem } from "./system.js";
import type { ReadRoutingOpportunity } from "../../ports/read-routing.js";
import type { createDefaultReadTopicConfiguration } from "../../learning/agent/subsystems/tool/read-strategy/index.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { createPersistentTopicIntake } from "./intake.js";
import { createTopicEvidenceBuffer, TopicEvidenceError, type TopicSemanticEvidenceProjector } from "./evidence.js";
import { isRedactedTopicData } from "./confidentiality.js";

type Report = Parameters<LearningPortShape["observe"]>[0];

type Frame = { readonly beat: number; readonly windowJson: string; readonly prompt: string; readonly version: number };

type RuntimeState = { readonly phase: "idle" | "closed" | "suspended" }
  | { readonly phase: "ready" | "served"; readonly frame: Frame };

type RuntimeControlSystem = Pick<TopicLearningSystem, "invoke" | "hasOpportunity" | "descriptors">
  & Partial<Pick<TopicLearningSystem, "semanticEvidence">>;

type RuntimeOptions = { readonly boardRoot: string; readonly scope: string; readonly sessionId: string; readonly turnId: string;
  readonly enabled: () => boolean; readonly emit: MethodEventSink;
  readonly secrets?: readonly string[];
  readonly projectEvidence?: TopicSemanticEvidenceProjector;
  readonly offerReadOpportunity?: (opportunity: ReadRoutingOpportunity) => void;
  readonly bindReadRuntime?: (runtime: Parameters<ReturnType<typeof createDefaultReadTopicConfiguration>["bindRuntime"]>[0]) => void;
  readonly control?: { readonly system: RuntimeControlSystem; readonly requestId: string; readonly totalQuota: number } };

const MAX_PROMPT_CHARS = DEFAULT_METHOD_GRANT.slotChars;
const MAX_COMMON_PROPOSAL_CHARS = 1100;

/** One shared-stream semantic opportunity, followed by the existing central/domain budget boundary. */
export function createTopicLearningRuntime(options: RuntimeOptions) {
  const control = options.control;
  const secrets = Object.freeze([...(options.secrets ?? [])]);
  const evidence = createTopicEvidenceBuffer({ ...options,
    ...(control === undefined ? {} : { experiments: control.system.descriptors }) });
  const board = createRewardV2BoardPort(options.boardRoot, options.enabled);
  const intakes = new Map<LearningDomain, ReturnType<typeof createPersistentTopicIntake>>();
  const intakeFor = (domain: LearningDomain) => {
    let intake = intakes.get(domain);
    if (intake === undefined) {
      intake = createPersistentTopicIntake({ ...options, secrets, domain, algorithmVersion: "ws1-common-stream-v1" });
      intakes.set(domain, intake);
    }
    return intake;
  };
  let state: RuntimeState = { phase: "idle" };
  const emit = (decision: string, reason?: string) => {
    try {
      options.emit("observation", { component: "topic_learning", decision, ...(reason === undefined ? {} : { reason }) });
    } catch {
      // Observability can fail too. Suspend without recursively reporting to the broken sink or failing execution.
      state = { phase: "suspended" };
      evidence.clear();
    }
  };
  const suspend = (reason = "topic_runtime_unavailable") => {
    state = { phase: "suspended" };
    evidence.clear();
    emit("unavailable", reason);
  };
  const active = (turnId: string, beat: number) => options.enabled() && turnId === options.turnId
    && (state.phase === "ready" || state.phase === "served") && state.frame.beat === beat;
  const canPrepare = (turnId: string, beat: number) => options.enabled() && turnId === options.turnId
    && Number.isSafeInteger(beat) && beat >= 1 && (state.phase === "idle" || state.phase === "ready") && evidence.version > 0;

  async function consume(report: Report): Promise<boolean> {
    if (state.phase !== "served" || report.turnId !== options.turnId || state.frame.beat !== report.beat) return false;

    const frame = state.frame;
    state = { phase: "closed" };

    if (!options.enabled()) {
      evidence.clear();
      return true;
    }

    if (report.proposal === undefined) {
      emit("proposal_missing");
      return true;
    }

    if (report.proposal.length > MAX_COMMON_PROPOSAL_CHARS) {
      emit("proposal_rejected", "topic_common_proposal_size");
      return true;
    }

    try {
      const current = await board.read();
      const parsed = readTopicSubmission(report.proposal, frame.windowJson);
      const domain = parsed.ok && parsed.value.kind === "topic" ? parsed.value.topic.domain : "prompt";
      const result = await intakeFor(domain).ingest(report.proposal, frame.windowJson, current.revision);
      emit(`proposal_${result.status}`, result.status === "rejected" ? result.reason : undefined);
    } catch { suspend(); }

    return true;
  }

  async function prepareFrame(turnId: string, beat: number): Promise<void> {
    if (!canPrepare(turnId, beat)) return;
    try {
      if (state.phase === "ready" && state.frame.version === evidence.version) {
        state = { phase: "ready", frame: { ...state.frame, beat } };
        return;
      }

      if (evidence.version === 0) return;

      const basis = await board.read();
      const windowJson = evidence.snapshot(basis.revision, control?.system.descriptors(basis.facts),
        control?.system.semanticEvidence?.(basis.facts, basis.revision));

      if (!canPrepare(turnId, beat)) return;

      if (windowJson === undefined) return;

      if (!isRedactedTopicData(JSON.parse(windowJson) as unknown, secrets)) {
        suspend("topic_sensitive_content");
        return;
      }

      const fence = `\n正文守用户格式；另加宿主剥离块：\n\`\`\`${LEARNING_FENCE}\n<上述JSON>\n\`\`\`\n无题也交no_topic。`;
      const prepared = prepareCommonTopicPrompt(windowJson, MAX_PROMPT_CHARS - fence.length);
      if (!prepared.ok) {
        if (prepared.reason === "topic_input_size") {
          state = { phase: "closed" };
          emit("slot_skipped", "topic_prompt_capacity");
        }
        else suspend();
        return;
      }

      state = { phase: "ready", frame: { beat, windowJson: prepared.value.windowJson,
        prompt: `${prepared.value.prompt}${fence}`, version: evidence.version } };
    } catch { suspend(); }
  }

  return {
    capture(event: Envelope): void {
      if (!options.enabled() || state.phase === "closed" || state.phase === "suspended") return;
      try { evidence.capture(event); } catch (error) { suspend(error instanceof TopicEvidenceError ? error.reason : "topic_runtime_unavailable"); }
    },

    inspect: () => ({ phase: state.phase }),
    ownsReadRouting: control !== undefined && options.offerReadOpportunity !== undefined,
    bindReadRuntime(runtime: Parameters<ReturnType<typeof createDefaultReadTopicConfiguration>["bindRuntime"]>[0]): void {
      if (options.enabled()) options.bindReadRuntime?.(runtime);
    },

    offerReadOpportunity(opportunity: ReadRoutingOpportunity): void {
      if (!options.enabled()) return;
      try { options.offerReadOpportunity?.(opportunity); }
      catch { emit("opportunity_unavailable", "topic_read_opportunity_unavailable"); }
    },

    async finish(signal: AbortSignal) {
      if (control === undefined || !options.enabled() || signal.aborted || state.phase === "suspended") return undefined;
      if (!control.system.hasOpportunity()) return undefined;
      return control.system.invoke({ requestId: control.requestId, totalQuota: control.totalQuota }, signal);
    },

    attach(base: LearningPortShape | undefined): LearningPortShape {
      return {
        intentOn(turnId, beat) { return base?.intentOn(turnId, beat) === true || active(turnId, beat) || canPrepare(turnId, beat); },

        confirmIntent(turnId, beat) {
          if (base?.intentOn(turnId, beat) === true) return base.confirmIntent?.(turnId, beat) ?? true;
          return active(turnId, beat) && state.phase === "served";
        },

        async requestSlot(request) {
          const baseRequested = base?.intentOn(request.turnId, request.beat) === true;
          const existing = await base?.requestSlot(request);

          if (baseRequested || base?.intentOn(request.turnId, request.beat) === true) return existing;

          await prepareFrame(request.turnId, request.beat);

          if (!active(request.turnId, request.beat)) return existing;

          if (state.phase !== "ready" && state.phase !== "served") return existing;

          const content = existing === undefined ? state.frame.prompt : `${existing.message.content}\n${state.frame.prompt}`;
          if (content.length > MAX_PROMPT_CHARS) {
            // A previous compilation of this beat may have fitted. Confirmation belongs to THIS delivery.
            state = { phase: "ready", frame: state.frame };
            emit("slot_skipped", "topic_prompt_capacity");
            return existing;
          }

          state = { phase: "served", frame: state.frame };

          return { message: { role: "system", content }, receipts: existing?.receipts ?? [] };
        },

        async observe(report) {
          const consumed = await consume(report);
          if (consumed) {
            const { proposal: _proposal, ...facts } = report;
            await base?.observe(facts);
          }
          else await base?.observe(report);
          if (Number.isSafeInteger(report.beat) && report.beat >= 1) await prepareFrame(report.turnId, report.beat + 1);
        },

        async recordFielding(notice) { await base?.recordFielding(notice); },
        async recordFeedback(notice) { await base?.recordFeedback(notice); },

        async endTurn(turnId, signal) {
          if (turnId === options.turnId) {
            state = { phase: "closed" };
            evidence.clear();
          }
          await base?.endTurn(turnId, signal);
        },
      };
    },
  };
}

export type TopicLearningRuntime = ReturnType<typeof createTopicLearningRuntime>;
