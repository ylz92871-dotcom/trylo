import { REFINE_SIMILARITY_CONVERGED } from "./constants.js";

/**
 * 两版描述有多像。
 *
 * 规格 §6 的收敛判定来自 DRAFT（相似度 > 0.75 就别再改了），但**第一版没有嵌入**：
 * 引一个向量模型进来，只为判「这两句是不是几乎一样」，是拿一台起重机去拧一颗
 * 螺丝，而且它还会让这一层的输出依赖于一个外部服务。所以这里是**字符级**的：
 * 按词切分后取 Jaccard 交集比。
 *
 * 它的能力边界要说清楚，否则会被拿去干它干不了的事：它认得「两版几乎一模一样」
 * （精炼在原地打转），**认不出**「两版用词不同但错法一样」——那件事由 §6 的退化
 * 规则负责：只有出现**新的**失败证据才再提议一次。两条合起来才是完整的收敛判定。
 */

/** 切成词：非字母数字与下划线都当分隔符，全小写。 */
export function tokensOf(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 0);
}

/** 两版描述的相似度，0–1；两版都空算作 1（都是空，确实无从再改）。 */
export function similarityOf(a: string, b: string): number {
  const left = new Set(tokensOf(a));
  const right = new Set(tokensOf(b));
  if (left.size === 0 && right.size === 0) {
    return 1;
  }

  let shared = 0;

  for (const token of left) {
    if (right.has(token)) {
      shared += 1;
    }
  }

  return shared / (left.size + right.size - shared);
}

/** 两版是否已经收敛（再精炼只会在原地打转）。 */
export function converged(previous: string, next: string): boolean {
  return similarityOf(previous, next) > REFINE_SIMILARITY_CONVERGED;
}
