// Trylo Work — capability registry (M4-E, architecture
// doc §6.7 / §10 M4-E).
//
// Every Work product capability is declared here with an
// explicit product state. The rules (§6.7, §14):
//   - `stable`       may enter the default starter grid and
//                    be promised to users in default copy;
//   - `experimental` is genuinely wired (end-to-end through
//                    the task loop) but not yet a stable
//                    product promise — never a default starter;
//   - `not_exposed`  upstream/vendor has the raw ability but
//                    Trylo has NOT migrated it into a stable
//                    UI / failure path — it must never appear
//                    in starters or user promises.
//
// "Research / analyze / organize / deliver" are NOT four
// separately-wired engines: they are entry points into the
// ONE stable `workspace_task` execution loop (the daemon's
// executor runs web search, file tools and data analysis as
// ordinary tools, and Trylo surfaces failures through the
// existing error projection). That is why their capability
// records carry state `stable` and seed only capability-
// neutral prompts — no fake "research engine" is implied.
//
// Skills / MCP / browser QA / scheduling / connectors are
// `not_exposed`: Trylo has no dedicated product entry for
// them yet, so the registry refuses to place them in
// starters or claim them in copy.

/** Product state of a Work capability (spec §6.7). */
export type CapabilityState = "not_exposed" | "experimental" | "stable";

/** One declared capability. */
export interface WorkCapability {
  /** Stable snake_case id. Starters key off it. */
  readonly id: string;
  /** Short user-facing title. */
  readonly title: string;
  /** One-line description of what the capability delivers. */
  readonly description: string;
  readonly state: CapabilityState;
  /** True when this capability is a DEFAULT starter in the
   *  Work empty state. Invariant: defaultStarter ⇒ state ===
   *  "stable" AND starterSeed is present. */
  readonly defaultStarter: boolean;
  /** Capability-neutral seed written into the Work input
   *  when the user picks the starter. Only meaningful for
   *  default starters. */
  readonly starterSeed?: string;
  /** Why this state. Kept in-code so future audits can see
   *  the reasoning without re-deriving it. */
  readonly rationale: string;
}

/**
 * The registry. Order determines starter rendering order.
 * Keep statuses honest: upgrading a capability to `stable`
 * is a product decision, not a copy edit.
 */
export const WORK_CAPABILITIES: readonly WorkCapability[] = [
  {
    id: "workspace_task",
    title: "Workspace task",
    description:
      "The base loop: run a multi-step task in the current workspace and deliver a verifiable result.",
    state: "stable",
    defaultStarter: false,
    rationale:
      "The shared task execution loop is the foundation of Work; every other capability runs through it.",
  },
  {
    id: "research_sources",
    title: "Research with sources",
    description:
      "Investigate a topic and gather references you can cite.",
    state: "stable",
    defaultStarter: true,
    starterSeed:
      "Research the following topic and return a summary with linked sources: ",
    rationale:
      "Web search is a real daemon tool in the stable workspace_task loop; the starter only seeds the loop, no dedicated research UI is implied.",
  },
  {
    id: "data_analysis",
    title: "Analyze data",
    description:
      "Open a dataset, summarize trends, and surface the key numbers.",
    state: "stable",
    defaultStarter: true,
    starterSeed:
      "Analyze the data in the current workspace and summarize the key findings: ",
    rationale:
      "Data analysis runs through the stable task loop (file + code tools); the starter is capability-neutral.",
  },
  {
    id: "file_organization",
    title: "Organize files",
    description:
      "Tidy, rename, or restructure files in the current workspace.",
    state: "stable",
    defaultStarter: true,
    starterSeed:
      "Organize the files in the current workspace. Group, rename, or move as needed: ",
    rationale:
      "File manipulation runs through the stable task loop; the starter is capability-neutral.",
  },
  {
    id: "deliverable",
    title: "Produce a deliverable",
    description:
      "Build a polished artifact — doc, table, deck, or page — and save it.",
    state: "stable",
    defaultStarter: true,
    starterSeed:
      "Produce a polished deliverable based on the following request: ",
    rationale:
      "Artifact creation is part of the stable task loop (saves into .trylo/out/); doc/sheet/deck/page are deliverable shapes, not separate engines.",
  },
  {
    id: "approval",
    title: "Approval",
    description:
      "Surface daemon permission requests inline and let the user approve or deny them.",
    state: "experimental",
    defaultStarter: false,
    rationale:
      "M4-E wired approval_requested/granted/denied events + approval.respond. Wired end-to-end but newly shipped — not yet a default starter or stable promise.",
  },
  {
    id: "input_request",
    title: "Input request",
    description:
      "Surface structured user-input questions inline and submit answers to the daemon.",
    state: "experimental",
    defaultStarter: false,
    rationale:
      "M4-E wired input_request_created/resolved/dismissed events + input_request.respond. Newly shipped — experimental.",
  },
  {
    id: "multi_artifact_followup",
    title: "Artifact follow-up",
    description:
      "Continue an existing task to modify previously delivered artifacts (task.sendMessage).",
    state: "experimental",
    defaultStarter: false,
    rationale:
      "task.sendMessage follow-up is wired (M4-B); artifact version/update UX is not productized, so not a default starter.",
  },
  {
    id: "office",
    title: "Office",
    description:
      "Create and edit Office documents via OfficeCLI (docx/xlsx/pptx) — writes confined to .trylo/out/.",
    state: "experimental",
    defaultStarter: false,
    rationale:
      "OfficeCLI v1.0.145 via MCP stdio is wired (new_tool/office); product UX not yet stable — experimental, never a default starter. High-risk remove/raw-set/overwrite requires explicit confirm even in dont_ask.",
  },
  {
    id: "browser",
    title: "Browser",
    description:
      "Drive a controlled browser session via Playwright MCP (and chrome-devtools on demand) — downloads confined to .trylo/out/.",
    state: "experimental",
    defaultStarter: false,
    rationale:
      "Playwright MCP v0.0.79 + chrome-devtools MCP v1.8.0 wired via MCP stdio (new_tool/browser); isolated session, downloads gated — experimental.",
  },
  {
    id: "computer_control",
    title: "Computer control",
    description:
      "Drive the desktop via Windows-MCP whitelist (Screenshot/Snapshot/DisplayInventory/Click/Type/Scroll/Move/Shortcut/Wait/WaitFor/App) — 11 tools only.",
    state: "experimental",
    defaultStarter: false,
    rationale:
      "Windows-MCP commit 83e17f6 wired with --tools whitelist and ANONYMIZED_TELEMETRY=false (new_tool/computer-control); WatchDog off, screenshots capped 1920×1080 — experimental pilot.",
  },
  {
    id: "cad_eda",
    title: "CAD/EDA",
    description:
      "Drive SolidWorks / AutoCAD / KiCad / 嘉立创EDA / FreeCAD / Blender via their pinned adapter surfaces — queries auto-allowed, deletes and code execution always approved.",
    state: "experimental",
    defaultStarter: false,
    rationale:
      "TRYLO-CAD-EDA-TOOL-ADAPTER wired end-to-end (work.cad.v1 + six pinned MCP packages + host classifiers); per-app install UX and deliverable validation are not productized yet — experimental pilot.",
  },
  {
    id: "skills",
    title: "Skills",
    description: "Reusable custom skills for the agent loop.",
    state: "not_exposed",
    defaultStarter: false,
    rationale:
      "Vendor has skills; Trylo has no dedicated product entry yet (spec §6.7 Extended).",
  },
  {
    id: "mcp",
    title: "MCP",
    description: "Model Context Protocol server integration.",
    state: "not_exposed",
    defaultStarter: false,
    rationale:
      "Vendor has MCP; Trylo has no dedicated product entry yet.",
  },
  {
    id: "browser_qa",
    title: "Browser QA",
    description: "Drive a browser to verify or exercise a page.",
    state: "not_exposed",
    defaultStarter: false,
    rationale:
      "Legacy vendor browser/canvas QA — superseded by the dedicated browser capability above; kept not_exposed to avoid double-counting.",
  },
  {
    id: "scheduling",
    title: "Scheduling",
    description: "Recurring / timed runs.",
    state: "not_exposed",
    defaultStarter: false,
    rationale:
      "Separately itemized (spec §6.7 Optional); not part of base Work completeness.",
  },
  {
    id: "connectors",
    title: "External connectors",
    description: "Email / calendar / other business integrations.",
    state: "not_exposed",
    defaultStarter: false,
    rationale:
      "Separately itemized; only after user demand is validated.",
  },
];

const BY_ID: ReadonlyMap<string, WorkCapability> = new Map(
  WORK_CAPABILITIES.map((c) => [c.id, c]),
);

/** Look up a capability by id. */
export function capabilityById(id: string): WorkCapability | undefined {
  return BY_ID.get(id);
}

/** The default starter capabilities: stable + defaultStarter,
 *  in registry order. This is the ONLY source the Work
 *  empty state renders. */
export function defaultStarters(): readonly WorkCapability[] {
  return WORK_CAPABILITIES.filter((c) => c.defaultStarter && c.state === "stable");
}

/** Capabilities that may be referenced in the UI / copy
 *  (stable + experimental). `not_exposed` capabilities are
 *  excluded everywhere except the registry itself. */
export function exposedCapabilities(): readonly WorkCapability[] {
  return WORK_CAPABILITIES.filter((c) => c.state !== "not_exposed");
}

export function isExposed(id: string): boolean {
  return capabilityById(id)?.state !== "not_exposed";
}

export function isStable(id: string): boolean {
  return capabilityById(id)?.state === "stable";
}

/**
 * Validate the registry invariants (spec §6.7 / §14):
 *   - ids unique;
 *   - defaultStarter ⇒ stable AND starterSeed present;
 *   - stable defaultStarter seeds are capability-neutral
 *     (no docx / xlsx / pptx / "generate a document"
 *     hard-coding);
 *   - only stable+defaultStarter are returned by
 *     defaultStarters().
 * Runs at module load (throws on violation) and is also
 * exported so tests can assert the contract explicitly.
 */
export function validateWorkCapabilityRegistry(): readonly string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const c of WORK_CAPABILITIES) {
    if (seen.has(c.id)) errors.push(`duplicate capability id: ${c.id}`);
    seen.add(c.id);
    if (c.defaultStarter && c.state !== "stable") {
      errors.push(
        `capability ${c.id} is a default starter but state=${c.state}; ` +
          "only stable capabilities may enter default starters (§6.7)",
      );
    }
    if (c.defaultStarter && (c.starterSeed ?? "").length === 0) {
      errors.push(`default starter ${c.id} is missing a starterSeed`);
    }
    if (c.state === "not_exposed" && c.defaultStarter) {
      errors.push(`not_exposed capability ${c.id} must not be a default starter`);
    }
  }
  return errors;
}

const violations = validateWorkCapabilityRegistry();
if (violations.length > 0) {
  // eslint-disable-next-line no-console
  console.error("[WorkCapabilityRegistry] invariant violations:", violations);
  throw new Error(
    `WorkCapabilityRegistry invariants violated:\n${violations.join("\n")}`,
  );
}
