import {
  FAILURE_FAMILIES,
  MAX_GLOSS_CHARS,
  MAX_LABEL_ADDITIONS,
  MAX_VOCABULARY,
  isLabelId,
  type LabelAddition,
  type LabelId,
  type LabelVocabulary,
  type VariantRecord,
} from "./contracts.js";

/**
 * 标签词表：受控子集，可追加，不自由派。
 *
 * 词表存在的理由是「索引与度量必须可比」：如果模型每次都能造新词，`labels` 就
 * 退化成一个字符串数组，既不能做候选过滤，也不能做记账时的同类判断。所以出卡
 * 只能在**当前词表**里选词，想要新词必须申请追加，而追加要带释义、有上限。
 *
 * 它的落盘地点是档本身，不是第二个文件：`known` 由已入档的变体派生
 * （`vocabularyOf`），所以「词表」与「变体档案」不会有第二份真相。追加在卡被
 * 门接纳的那一拍生效——卡进不去，词也进不去；这正是 §4.3 的「当拍即入词表」，
 * 而它不需要额外的写路径。
 *
 * 词表种子就是失败族闭集（`SEED_LABELS`）：那六个数已经在 M2 自己的合同里，
 * 用它当种子意味着模型第一枪就有话说，而不是先申请再说话。
 *
 * 初版**只增不减**：一旦进过档的词就是已知词，包括只被 archived 变体用过的。
 * 膨胀上限、同义合并、删除权属是 `OPEN-M2-3`，本包只保证「能用、能加、不自由派」。
 */

/** 种子标签：失败族闭集。 */
export const SEED_LABELS: ReadonlyArray<LabelId> = [...FAILURE_FAMILIES];

export function emptyVocabulary(): LabelVocabulary {
  return { known: [...SEED_LABELS], pending: [] };
}

/**
 * 档 + 这一拍刚接纳的追加 → 当前词表。
 *
 * 顺序是确定的：种子在前，然后按**档内次序**首次出现的标签。确定的顺序是可测
 * 的事实（词表会进提示词，也会进日志），而不是装饰。
 */
export function vocabularyOf(
  variants: ReadonlyArray<VariantRecord>,
  pending: ReadonlyArray<LabelAddition> = [],
): LabelVocabulary {
  const known: LabelId[] = [...SEED_LABELS];
  const seen = new Set<string>(known);

  for (const variant of variants) {
    for (const label of variant.card.labels) {
      if (seen.has(label) || known.length >= MAX_VOCABULARY) {
        continue;
      }
      seen.add(label);
      known.push(label);
    }
  }

  for (const addition of pending) {
    if (seen.has(addition.id) || known.length >= MAX_VOCABULARY) {
      continue;
    }
    seen.add(addition.id);
    known.push(addition.id);
  }

  return { known, pending };
}

export function isKnown(vocabulary: LabelVocabulary, id: LabelId): boolean {
  return vocabulary.known.includes(id);
}

/**
 * 这一拍真正能进词表的追加：形状合规、还没在词表里、且**放得下**。
 *
 * 放不下的申请（词表已到 `MAX_VOCABULARY`）在这里被静默丢弃，不是被吞掉：
 * 调用方随后会发现卡上的那个标签不在生效词表里，于是整张卡被拒。拒卡这个
 * 结果由「标签不在词表内」说出，比多一个「词表满了」的拒绝码更接近事实——
 * 对出卡的模型来说，两者的后果与补救动作是同一个。
 */
export function acceptedAdditions(
  vocabulary: LabelVocabulary,
  additions: ReadonlyArray<LabelAddition>,
): ReadonlyArray<LabelAddition> {
  const accepted: LabelAddition[] = [];
  const seen = new Set<string>(vocabulary.known);

  for (const addition of additions) {
    if (accepted.length >= MAX_LABEL_ADDITIONS) {
      break;
    }

    if (!isWellFormed(addition) || seen.has(addition.id)) {
      continue;
    }

    if (vocabulary.known.length + accepted.length >= MAX_VOCABULARY) {
      break;
    }

    seen.add(addition.id);
    accepted.push(addition);
  }

  return accepted;
}

/** 一个追加项的形状：可作 LabelId 的 id，加一句不超过上限的释义。 */
function isWellFormed(addition: LabelAddition): boolean {
  return (
    isLabelId(addition.id) &&
    addition.gloss.trim().length > 0 &&
    addition.gloss.length <= MAX_GLOSS_CHARS
  );
}

/**
 * 把追加折进词表。
 *
 * 只在卡被门接纳之后调用一次，产出的是**这一拍生效**的词表：它是 `known`
 * 加上这一拍的新词。写进档的说法是「这些词已经是已知词了」，所以折进来之后
 * `pending` 清空——申请已经兑现，继续挂着会让下一次读档的人以为还有一笔在途。
 */
export function withAdditions(
  vocabulary: LabelVocabulary,
  accepted: ReadonlyArray<LabelAddition>,
): LabelVocabulary {
  if (accepted.length === 0) {
    return vocabulary;
  }
  return { known: [...vocabulary.known, ...accepted.map((item) => item.id)], pending: [] };
}

/**
 * 打给模型的词表全量。
 *
 * 全量而不是「最近用过的几个」：模型要在**受控**的范围里选词，范围本身必须
 * 完整可见，否则它会用一个看起来合理、其实不在表里的词，然后被门拒掉——
 * 那是把一次可避免的失败当成学习机会。
 */
export function vocabularyPrompt(vocabulary: LabelVocabulary): string {
  return vocabulary.known.join(", ");
}
