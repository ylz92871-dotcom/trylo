import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REFINE_MAX_HISTORY } from "../domain/refine/constants.js";
import type { RefinementEntry, RefinementStore } from "../domain/refine/types.js";

/**
 * 覆盖层的本地存储（P05 工具学习规格 §6「覆盖层 store（本地 app-data）」）。
 *
 * 与工具账（`ledger-file.ts`）同一条边界：**`node:fs` 只允许出现在组合层**，
 * 学习层拿到的永远是一个端口形状。所以「文件还是内存」是这一层的决定，
 * A 描述精炼的语义（`learning/domains/tool/refine/`）对此一无所知。
 *
 * ## 为什么不是追加账
 *
 * 工具账是 NDJSON 追加的，因为它记的是**发生过的事**——一条 observation 写下了就不会变。
 * 覆盖层不是：`promote` 和 `rollback` 改的是一个工具的**当前状态**，追加账会让
 * 「这个工具现在到底是不是 enforced」变成一次从头 reduce。所以这里是一个 JSON 映射，
 * 每次变更重写整份。文件小（每个精炼过的工具一条），重写的代价可以忽略。
 *
 * ## 为什么全是同步 IO
 *
 * 注入点 `mount.ts::bindingForSpec` 是同步函数，所以覆盖层在挂载那一刻必须**已经在内存里**。
 * 一个异步的 store 会把它变成「挂载之前先 await 一次」，而那是一个比这里省下的几毫秒
 * 更贵的要求。于是这一层在构造时一次读进内存，之后每次 `save` 同步落盘——小文件 + 变更稀疏，
 * 这是把竞态换掉的正确价钱。
 */

export const REFINEMENT_STORE_FILE = "description-refinements.json";

/** 磁盘格式。`version` 留着，是为了将来改形状时能认出旧文件而不是当成坏文件丢掉。 */
type RefinementFile = {
  readonly version: 1;
  readonly entries: Record<string, RefinementEntry>;
};

/**
 * 打开一个覆盖层 store。
 *
 * 文件不存在 = 从没精炼过任何工具。这不是错误，是第一次跑——和工具账第一次跑时
 * 读不到文件是同一种情况，所以缺文件与空文件在这里汇成同一个空映射。
 *
 * 坏 JSON 也走同一条路：一份读不动的覆盖层文件如果让 CLI 起不来，代价是一个工具
 * **用不了**；而忽略它的代价只是回到原文。两者相权，回到原文。整体丢弃而不是逐条
 * 丢弃，是因为 JSON 是一个原子文档：能解析出来的半个文档意味着有人手工动过它，此时
 * 挑一半信一半比整体不信任更危险。
 */
export function createFileRefinementStore(root: string): RefinementStore {
  const file = path.join(root, REFINEMENT_STORE_FILE);
  const entries = readEntries(file);

  return {
    entryFor: (tool) => entries.get(tool),
    all: () => [...entries.values()],
    save: (entry) => {
      entries.set(entry.tool, entry);
      mkdirSync(root, { recursive: true });
      const payload: RefinementFile = {
        version: 1,
        entries: Object.fromEntries([...entries].map(([tool, value]) => [tool, trim(value)])),
      };

      writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    },
  };
}

function readEntries(file: string): Map<string, RefinementEntry> {
  let raw: string;

  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return new Map();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RefinementFile>;
    const record = parsed.entries;
    if (record === undefined || record === null || typeof record !== "object") {
      return new Map();
    }
    return new Map(Object.entries(record));
  } catch {
    return new Map();
  }
}

/** 落盘前把历史裁到上限：磁盘上不该留超过读者需要的东西。 */
function trim(entry: RefinementEntry): RefinementEntry {
  if (entry.history.length <= REFINE_MAX_HISTORY) {
    return entry;
  }
  return { ...entry, history: entry.history.slice(-REFINE_MAX_HISTORY) };
}
