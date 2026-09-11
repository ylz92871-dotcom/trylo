// Trylo Work — Deliverable descriptor registry.
//
// 2026-08-29 (Work end-to-end workflow redesign spec §8.4,
// §8.9): ONE generic registry of deliverable definitions.
// PPT ships the full milestone/checkpoint/validator set;
// the other families register their axes so the SAME
// DeliverableProgressPanel renders them without a second
// UI stack (§8.9 "禁止每种交付物各写一套").
//
// Detection is deterministic and conservative (spec §8.7
// step 1): tool name first, then file extension, then a
// short intent keyword pass. Nothing here parses model
// prose for progress or structure.

import type {
  DeliverableWorkflowDefinition,
  WorkDeliverableKind,
} from "./deliverable-domain.js";

/** Tools the vendor daemon exposes for deliverable
 *  generation (spec §8.3 audit of document-tools.js).
 *  Keyed verbatim on the upstream tool identifiers. */
const PRESENTATION_TOOLS: ReadonlySet<string> = new Set([
  "generate_presentation",
  "create_presentation",
]);
const DOCUMENT_TOOLS: ReadonlySet<string> = new Set([
  "generate_document",
  "create_document",
]);
const SPREADSHEET_TOOLS: ReadonlySet<string> = new Set([
  "generate_spreadsheet",
  "create_spreadsheet",
]);

const PRESENTATION_EXTENSIONS: ReadonlySet<string> = new Set([
  "pptx", "ppt", "key",
]);
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  "docx", "doc", "md", "pdf",
]);
const SPREADSHEET_EXTENSIONS: ReadonlySet<string> = new Set([
  "xlsx", "xls", "csv",
]);

/** Spec §8.5 G: the PPT milestone axis. Labels are the
 *  user-facing Chinese copy; ids are stable. */
const PRESENTATION_DEFINITION: DeliverableWorkflowDefinition = {
  kind: "presentation",
  unitType: "slide",
  milestones: [
    { id: "brief", label: "简报" },
    { id: "sources", label: "资料" },
    { id: "outline", label: "大纲" },
    { id: "visual", label: "视觉" },
    { id: "generate", label: "页级生成" },
    { id: "preview", label: "预览" },
    { id: "qa", label: "质检" },
    { id: "export", label: "导出" },
  ],
  checkpoints: [
    {
      id: "outline_review",
      label: "大纲确认",
      afterMilestone: "outline",
    },
  ],
  validators: [
    { id: "structure", label: "文件结构与页数", kind: "structure" },
    { id: "resources", label: "图片与资源可用", kind: "structure" },
    { id: "visual_overflow", label: "文字溢出与版式", kind: "visual" },
  ],
  previewStrategy: "thumbnail-grid",
};

const GENERIC_MILESTONES = (labels: readonly string[]) =>
  labels.map((label, i) => ({ id: `m${i + 1}`, label }));

const DOCUMENT_DEFINITION: DeliverableWorkflowDefinition = {
  kind: "document",
  unitType: "section",
  milestones: GENERIC_MILESTONES([
    "简报", "来源", "章节结构", "分节草稿", "排版", "页级预览", "校对", "导出",
  ]),
  checkpoints: [
    { id: "structure_review", label: "结构确认", afterMilestone: "m3" },
  ],
  validators: [
    { id: "structure", label: "文件结构与章节", kind: "structure" },
  ],
  previewStrategy: "file",
};

const SPREADSHEET_DEFINITION: DeliverableWorkflowDefinition = {
  kind: "spreadsheet",
  unitType: "sheet",
  milestones: GENERIC_MILESTONES([
    "目标", "数据源", "schema", "清洗", "公式", "图表", "数据验证", "导出",
  ]),
  checkpoints: [],
  validators: [
    { id: "structure", label: "工作簿结构", kind: "structure" },
    { id: "data", label: "数据维度合法", kind: "structure" },
  ],
  previewStrategy: "file",
};

const WEBSITE_DEFINITION: DeliverableWorkflowDefinition = {
  kind: "website",
  unitType: "page",
  milestones: GENERIC_MILESTONES([
    "需求", "信息架构", "页面/组件", "本地预览", "检查", "构建产物",
  ]),
  checkpoints: [
    { id: "ia_review", label: "信息架构确认", afterMilestone: "m2" },
  ],
  validators: [
    { id: "build", label: "构建成功", kind: "structure" },
  ],
  previewStrategy: "browser",
};

const RESEARCH_DEFINITION: DeliverableWorkflowDefinition = {
  kind: "research",
  unitType: "record",
  milestones: GENERIC_MILESTONES([
    "问题", "来源策略", "资料收集", "证据矩阵", "综合分析", "引用核验", "报告",
  ]),
  checkpoints: [],
  validators: [
    { id: "citations", label: "引用可核验", kind: "structure" },
  ],
  previewStrategy: "file",
};

const GENERIC_DEFINITION: DeliverableWorkflowDefinition = {
  kind: "generic",
  milestones: GENERIC_MILESTONES(["理解", "执行", "交付"]),
  checkpoints: [],
  validators: [],
  previewStrategy: "none",
};

const REGISTRY: ReadonlyMap<WorkDeliverableKind, DeliverableWorkflowDefinition> =
  new Map([
    ["presentation", PRESENTATION_DEFINITION],
    ["document", DOCUMENT_DEFINITION],
    ["spreadsheet", SPREADSHEET_DEFINITION],
    ["website", WEBSITE_DEFINITION],
    ["research", RESEARCH_DEFINITION],
    ["generic", GENERIC_DEFINITION],
  ]);

/** The definition for a family. Unknown kinds fall back to
 *  `generic` so the panel always has an axis to render. */
export function getDeliverableDefinition(
  kind: WorkDeliverableKind | string | undefined,
): DeliverableWorkflowDefinition {
  if (kind !== undefined) {
    const def = REGISTRY.get(kind as WorkDeliverableKind);
    if (def) return def;
  }
  return GENERIC_DEFINITION;
}

/** Detect the family from a daemon tool name (spec §8.7
 *  step 1: the generator tool call is the strongest
 *  signal). Returns undefined for non-deliverable tools. */
export function detectDeliverableKindFromTool(
  tool: string | undefined,
): WorkDeliverableKind | undefined {
  if (!tool) return undefined;
  const t = tool.toLowerCase();
  if (PRESENTATION_TOOLS.has(t)) return "presentation";
  if (DOCUMENT_TOOLS.has(t)) return "document";
  if (SPREADSHEET_TOOLS.has(t)) return "spreadsheet";
  return undefined;
}

/** Detect the family from an artifact path extension. */
export function detectDeliverableKindFromPath(
  filePath: string | undefined,
): WorkDeliverableKind | undefined {
  if (!filePath) return undefined;
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return undefined;
  const ext = filePath.slice(dot + 1).toLowerCase();
  if (PRESENTATION_EXTENSIONS.has(ext)) return "presentation";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  if (SPREADSHEET_EXTENSIONS.has(ext)) return "spreadsheet";
  if (ext === "html" || ext === "htm") return "website";
  return undefined;
}

/** Cheap intent keyword pass (spec §8.7 step 1). Only
 *  used when no tool / extension signal exists — it never
 *  overrides a real fact. */
export function detectDeliverableKindFromText(
  text: string | undefined,
): WorkDeliverableKind | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  if (/(ppt|幻灯片|演示文稿|演示|slides?|presentation|deck)/.test(t)) {
    return "presentation";
  }
  // research first: "调研报告" / "研究报告" contain "报告" and
  // would otherwise match the document pass.
  if (/(调研|研究报告|research)/.test(t)) {
    return "research";
  }
  if (/(报告|文档|word|docx|document|write-up)/.test(t)) {
    return "document";
  }
  if (/(表格|excel|xlsx|spreadsheet|数据表)/.test(t)) {
    return "spreadsheet";
  }
  if (/(网页|网站|website|landing page)/.test(t)) return "website";
  return undefined;
}
