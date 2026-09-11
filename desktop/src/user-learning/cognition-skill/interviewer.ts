/**
 * Fifth-mode interviewer. Speaks like a colleague, not a form.
 * QUESTION_BANK is an outline the interviewer consults — it is never
 * played back as a questionnaire.
 */
import { dimensionLabel } from '../labels';
import { activeRecords } from '../store';
import type { AnswerResolution } from './answer-resolution';
import type {
  CognitionChatMessage,
  CognitionSession,
  PolicyDimension,
  UserLearningSnapshot,
} from '../types';
import { QUESTION_BANK } from './map';

function outlineState(
  snapshot: UserLearningSnapshot,
): readonly { dimension: PolicyDimension; state: 'missing' | 'conflict' | 'ok' }[] {
  const models = activeRecords(snapshot.userModels);
  const conclusions = activeRecords(snapshot.conclusions);
  return QUESTION_BANK.map((question) => {
    const dim = question.dimension;
    const model = models.find((item) => item.dimension === dim);
    const related = conclusions.filter((item) => item.dimension === dim);
    if (
      related.some((item) => item.temporal.state === 'disputed')
      || snapshot.conclusionRelations.some((rel) => (
        rel.type === 'contradicts'
        && related.some((item) => item.id === rel.fromId || item.id === rel.toId)
      ))
    ) {
      return { dimension: dim, state: 'conflict' as const };
    }
    if (!model || model.confidence.band === 'low') {
      return { dimension: dim, state: 'missing' as const };
    }
    return { dimension: dim, state: 'ok' as const };
  });
}

const MAX_CHAT_ANSWERS = 4;

export function sessionMessages(session: CognitionSession): readonly CognitionChatMessage[] {
  if (session.messages && session.messages.length > 0) return session.messages;
  const out: CognitionChatMessage[] = [];
  session.questions.forEach((q, i) => {
    out.push({ id: `q-${q.id}`, role: 'assistant', text: q.prompt, at: session.createdAt + i });
    const answer = session.answers[i];
    if (answer) out.push({ id: `a-${q.id}`, role: 'user', text: answer.text, at: answer.at });
  });
  return out;
}

function knownStatements(snapshot: UserLearningSnapshot): readonly string[] {
  return activeRecords(snapshot.userModels)
    .slice(0, 4)
    .map((m) => m.statement.replace(/用户/g, '你').slice(0, 80));
}

/** Whether the user has given essentially no Work-surface preferences yet
 *  (TRYLO-DUAL-SURFACE-SPEC §3.2/§3.3). True = none of the Work dimensions is
 *  modelled (nor any Work-scoped model). Shared by the interviewer and the
 *  in-task trigger so Work-thin routing is one decision, not two. */
export function workIsThin(snapshot: UserLearningSnapshot): boolean {
  const models = activeRecords(snapshot.userModels);
  return !models.some((m) => (
    m.dimension === 'work_artifact_workflow'
    || m.dimension === 'tool_workflow'
    || m.dimension === 'product_ux_acceptance'
    || m.scope.product === 'work'
  ));
}

export function openingMessage(snapshot: UserLearningSnapshot): string {
  const known = knownStatements(snapshot);
  const map = outlineState(snapshot);
  const missing = map.filter((item) => item.state === 'missing' || item.state === 'conflict');
  const lines: string[] = [
    '这轮只聊你怎么跟我干活，不写代码、也不改文件。你可以直接说习惯，也可以让我问。',
  ];
  if (known.length > 0) {
    lines.push(`我现在比较有把握的是：${known[0]}`);
  } else {
    lines.push('我对你的工作习惯几乎还不了解。');
  }
  if (workIsThin(snapshot)) {
    lines.push('做报告、改文档、操作电脑或浏览器时你希望我怎么拿捏，我几乎还没听你说过。');
  } else if (missing.length > 0) {
    lines.push(`还比较空的是「${dimensionLabel(missing[0]!.dimension)}」这一块。`);
  }
  lines.push('你想先说哪一块？');
  return lines.join('\n\n');
}

export function recapFromSnapshot(
  snapshot: UserLearningSnapshot,
  evidenceIds: readonly string[],
): string {
  const claims = snapshot.evidence
    .filter((e) => evidenceIds.includes(e.id) || e.origin.channel === 'cognition')
    .slice(-6)
    .map((e) => e.inference.claim.replace(/^用户/, '你'));
  const models = activeRecords(snapshot.userModels).slice(0, 5);
  const bullets = models.length > 0
    ? models.map((m) => `· ${m.statement.replace(/用户/g, '你')}`)
    : claims.slice(0, 4).map((c) => `· ${c}`);
  if (bullets.length === 0) {
    return '这轮先停在这里。你之后在真实任务里纠正我，我也会慢慢学。随时可以再来改。';
  }
  return `我之后会按这些来做：\n${bullets.join('\n')}\n\n随时可以改。`;
}

function nextOutlineDimension(
  snapshot: UserLearningSnapshot,
  except?: PolicyDimension,
): PolicyDimension | null {
  const map = outlineState(snapshot);
  const ranked = [...map].sort((a, b) => {
    const order = { conflict: 0, missing: 1, ok: 2 };
    return order[a.state] - order[b.state];
  });
  if (workIsThin(snapshot)) {
    const workHit = ranked.find((item) => (
      item.dimension !== except
      && item.state !== 'ok'
      && (
        item.dimension === 'work_artifact_workflow'
        || item.dimension === 'tool_workflow'
        || item.dimension === 'product_ux_acceptance'
      )
    ));
    if (workHit) return workHit.dimension;
  }
  const hit = ranked.find((item) => item.dimension !== except && item.state !== 'ok');
  if (hit) return hit.dimension;
  return null;
}

function followUpFor(dimension: PolicyDimension): string {
  const q = QUESTION_BANK.find((item) => item.dimension === dimension);
  switch (dimension) {
    case 'work_artifact_workflow':
      return '做 PPT 或报告的时候，你是希望我先出一版再改，还是正式材料必须先给你看结构？';
    case 'tool_workflow':
      return '操作电脑或浏览器时，低风险的点击你希望我自己做，还是每步都先问你？账号和登录呢？';
    case 'product_ux_acceptance':
      return '成品看起来怎样算过关？干净克制就行，还是要更正式、更接近对外方案的样子？';
    case 'reporting_information_density':
      return '干活的时候你更想看到结论和产物，还是希望我把过程也讲清楚？';
    default:
      return q
        ? `关于「${dimensionLabel(dimension)}」，${q.prompt.split('？')[0]}？`
        : `关于「${dimensionLabel(dimension)}」，你希望我怎么做？`;
  }
}

export function isGracefulClose(text: string): boolean {
  return /^(先这样|够了|先到这|先到这里|就这样|聊完了|返回|好了|可以了)([。.!！])?$/i.test(text.trim());
}

export function isPositiveBoundary(text: string): boolean {
  const t = text.trim();
  if (/不|别|除外|核心|保留|不行/.test(t) && !/不是不行/.test(t)) return false;
  return /^(是|对|嗯|好|可以|同样|适用|仍按|一样)/.test(t) || /同样适用|仍按同一|也按这个/.test(t);
}

export function isNegativeBoundary(text: string): boolean {
  const t = text.trim();
  return /不适用于核心|核心.*除外|核心.*保留|不要放宽|不行|别放/.test(t)
    || /^(不|不是|不行|不要)/.test(t);
}

export function nextInterviewerReply(input: {
  readonly snapshot: UserLearningSnapshot;
  readonly session: CognitionSession;
  readonly lastUserText: string;
  readonly resolution: AnswerResolution;
}): { readonly reply: string; readonly stop: boolean; readonly recap?: string } {
  const { snapshot, session, lastUserText, resolution } = input;
  if (resolution.followUp === 'reask') {
    return {
      reply: '这一句有点宽。能说得具体一点吗？比如普通报告和对外方案，要求一样吗？',
      stop: false,
    };
  }
  if (resolution.followUp === 'confirm_scope') {
    return {
      reply: `你刚才说「${lastUserText.slice(0, 40)}」。如果这意味着对核心链路或账号/数据路径也放松，你还是按同一原则吗？核心路径我可以继续留严格基线。`,
      stop: false,
    };
  }

  const heard = resolution.candidates[0]?.claim.replace(/^用户/, '你')
    ?? `你刚说的「${lastUserText.slice(0, 48)}」`;
  const answers = session.answers.length + 1;
  const nextDim = nextOutlineDimension(snapshot, session.dimension);
  if (answers >= MAX_CHAT_ANSWERS || nextDim === null) {
    const recap = recapFromSnapshot(snapshot, session.evidenceIds);
    return {
      reply: `记下了：${heard}\n\n${recap}`,
      stop: true,
      recap,
    };
  }
  return {
    reply: `记下了：${heard}\n\n${followUpFor(nextDim)}`,
    stop: false,
  };
}
