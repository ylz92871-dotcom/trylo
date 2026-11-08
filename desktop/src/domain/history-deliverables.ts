// Read-only presentation-delivery snapshots from existing conversation history.
// Rendering these records does not restart their former workflow or infer new facts.

export type PresentationBriefStatus = "collecting" | "ready" | "confirmed";

export interface PresentationBrief {
  readonly purpose?: string;
  readonly audience?: string;
  readonly durationMinutes?: number;
  /** The USER'S requested page count — never the actual
   *  count (spec §8.4). */
  readonly requestedSlideCount?: number;
  readonly tone?: string;
  readonly language?: string;
  readonly status: PresentationBriefStatus;
}

export type PresentationSourceStatus =
  | "queued"
  | "reading"
  | "used"
  | "failed";

export interface PresentationSource {
  readonly id: string;
  readonly label: string;
  readonly uri?: string;
  readonly status: PresentationSourceStatus;
  readonly citationCount?: number;
}

export type PresentationOutlineStatus =
  | "draft"
  | "awaiting_review"
  | "approved"
  | "superseded";

export interface PresentationOutlineSlide {
  readonly index: number;
  readonly title: string;
  readonly intent?: string;
}

export interface PresentationOutline {
  readonly version: number;
  readonly status: PresentationOutlineStatus;
  readonly slides: readonly PresentationOutlineSlide[];
}

export type PresentationVisualMode =
  | "work"
  | "editorial"
  | "playful"
  | "premium"
  | "technical";

export type PresentationImagePolicy =
  | "none"
  | "placeholders"
  | "reuse"
  | "generate"
  | "mixed";

export interface PresentationVisualDirection {
  readonly mode?: PresentationVisualMode;
  readonly templateName?: string;
  readonly brandName?: string;
  readonly imagePolicy?: PresentationImagePolicy;
  readonly status: "draft" | "selected";
}

/** Honest unit status ladder (spec §8.4 / §8.5 E): a unit
 *  only moves forward on real facts. `generating` is the
 *  ceiling while the whole-deck generator runs without a
 *  per-page callback — no `4 / 10` fiction. */
export type PresentationSlideStatus =
  | "queued"
  | "content_ready"
  | "visual_ready"
  | "generating"
  | "rendered"
  | "validated"
  | "issue";

export interface PresentationSlideUnit {
  readonly index: number;
  readonly title: string;
  readonly status: PresentationSlideStatus;
  readonly previewPath?: string;
  readonly issues?: readonly string[];
}

export type DeliverableValidationStatus =
  | "pending"
  | "running"
  | "passed"
  | "warning"
  | "failed"
  /** The check needs a capability (a renderer) that is not
   *  packaged — it was NEVER run. Never displayed green
   *  (spec §8.5 G-8 / §16-14). */
  | "not_run";

export interface DeliverableValidationEntry {
  readonly id: string;
  readonly label: string;
  readonly status: DeliverableValidationStatus;
  readonly evidence?: string;
}

export interface PresentationExport {
  readonly format: "pptx" | "pdf" | "preview";
  readonly path: string;
}

/** The live projection of ONE presentation deliverable
 *  (spec §8.4). Immutable; the reducer returns fresh
 *  copies. */
export interface PresentationWorkflowProjection {
  readonly kind: "presentation";
  readonly deliverableId: string;
  readonly brief: PresentationBrief;
  readonly sources: readonly PresentationSource[];
  readonly outline?: PresentationOutline;
  readonly visualDirection?: PresentationVisualDirection;
  readonly slides: readonly PresentationSlideUnit[];
  readonly validation: readonly DeliverableValidationEntry[];
  readonly exports: readonly PresentationExport[];
  /** True while the whole-deck generator call is in
   *  flight. The panel may only say "正在生成 N 页" — page
   *  progress stays hidden until real per-page facts
   *  arrive (spec §8.5 E). */
  readonly generating: boolean;
  /** Revision linkage (spec §8.5 H): a follow-up "change
   *  page 4" run revises the same deliverable. */
  readonly revisionOf?: string;
  readonly outlineVersion?: number;
  readonly artifactVersion?: number;
}


export type WorkDeliverableKind =
  | "presentation"
  | "document"
  | "spreadsheet"
  | "website"
  | "research"
  | "generic";

/** One stage on the deliverable axis (spec §8.1). */
export interface DeliverableMilestoneDefinition {
  readonly id: string;
  readonly label: string;
}

/** A user-decision node (spec §8.8): content direction,
 *  NOT a permission approval. */
export interface DeliverableCheckpointDefinition {
  readonly id: string;
  readonly label: string;
  /** Which milestone the checkpoint gates. */
  readonly afterMilestone: string;
}

/** A QA capability (spec §8.5 G). */
export interface DeliverableValidatorDefinition {
  readonly id: string;
  readonly label: string;
  /** `structure` = parse/zip-level checks we can always
   *  run; `visual` = needs a real renderer — without one
   *  the result MUST be `not_run`. */
  readonly kind: "structure" | "visual";
}

export type DeliverablePreviewStrategy =
  | "none"
  | "file"
  | "thumbnail-grid"
  | "browser";

/** Spec §8.4: what a deliverable family promises. The UI
 *  renders from this + the projection; it never hardcodes
 *  a per-kind layout (§8.9 "禁止每种交付物各写一套"). */
export interface DeliverableWorkflowDefinition {
  readonly kind: WorkDeliverableKind;
  readonly milestones: readonly DeliverableMilestoneDefinition[];
  readonly unitType?: "slide" | "section" | "sheet" | "page" | "record";
  readonly checkpoints: readonly DeliverableCheckpointDefinition[];
  readonly validators: readonly DeliverableValidatorDefinition[];
  readonly previewStrategy: DeliverablePreviewStrategy;
}


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


export function countSlidesAtLeast(
  p: PresentationWorkflowProjection,
  status: PresentationSlideUnit["status"],
): number {
  const rank: Record<PresentationSlideUnit["status"], number> = {
    queued: 0,
    content_ready: 1,
    visual_ready: 2,
    generating: 3,
    rendered: 4,
    validated: 5,
    issue: -1,
  };
  return p.slides.filter((s) => rank[s.status] >= rank[status]).length;
}

/** The REAL page count the UI may display: the approved
 *  outline length or the established unit list — NEVER the
 *  requested count (spec §8.4). Undefined = nothing real
 *  yet; the panel must not print any number. */
export function realSlideCount(
  p: PresentationWorkflowProjection,
): number | undefined {
  if (p.slides.length > 0) return p.slides.length;
  if (p.outline && p.outline.slides.length > 0) return p.outline.slides.length;
  return undefined;
}

/** True when the projection carries enough facts to show a
 *  per-page `N / M` progress. Requires real units AND a
 *  per-page fact source (at least one unit past the
 *  `generating` ceiling). */
export function hasRealPageProgress(
  p: PresentationWorkflowProjection,
): boolean {
  if (p.slides.length === 0) return false;
  return p.slides.some(
    (s) => s.status === "rendered" || s.status === "validated" || s.status === "issue",
  );
}
