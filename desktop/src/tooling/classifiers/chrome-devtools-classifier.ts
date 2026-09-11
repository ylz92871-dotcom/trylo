// Trylo Desktop — Chrome DevTools MCP risk classifier.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §6.5 (action table) ×
// §6.3 (permission matrix) / §6.2 (URL + audit rules) / §4.1
// (work.browser-debug.v1 — Playwright REPLACED, never co-resident).
//
// The pinned 1.8.0 surface exposes exactly 29 tools (manifest pins the set;
// verified by the PR-7 tools/list smoke). The server's annotations are
// HINTS ONLY (§6.2) — `get_network_request` claims non-read-only because it
// can write files; Trylo's own table decides, every call.
//
// Policy (§6.5 semantics mapped onto the pinned CDP tool names):
//   list/select pages, console, network LIST, insight analysis, wait,
//   resize                          → read, auto at every level
//   take_snapshot / take_screenshot / get_network_request
//                                   → WITHOUT a path param: read, auto.
//                                     WITH one: FILE WRITE (the server
//                                     bounds writes to the OS temp dir —
//                                     verified in the pinned build:
//                                     McpContext#validatePath allows only
//                                     os.tmpdir() when no MCP roots are
//                                     negotiated, which the Trylo CLI never
//                                     does). read_only denies; ask /
//                                     workspace_write approve; unrestricted
//                                     auto (§6.3 write rules).
//   navigate_page / new_page        → §6.5 origin flow: URL parsed
//                                     (http/https only, no credentials),
//                                     blocked origins deny, non-empty
//                                     allowlist + outside → prompt without
//                                     lease; read_only/ask approve;
//                                     workspace_write first-visit approves
//                                     AND grants the SHORT ORIGIN LEASE
//                                     (§6.5, shared store with Playwright —
//                                     same human decision, same surface
//                                     class); leased / unrestricted auto.
//   close_page                      → approval (page state loss).
//   click / drag / hover / fill / fill_form / press_key / type_text /
//   handle_dialog                   → approval at every level ≥ ask, DENIED
//                                     read_only (§6.3 点击/输入拒绝).
//                                     Targets are opaque snapshot uids —
//                                     element effects are NOT determinable
//                                     from input, so these never auto-allow.
//                                     No scoped lease in v1 (§6.5 lease is a
//                                     navigation concept here).
//   upload_file                     → strict path defense (PR-3 rules:
//                                     control chars / UNC / device /
//                                     drive-relative / `..` / outside
//                                     workspace all deny); uploading a
//                                     workspace file is local data leaving
//                                     to the page → sensitive approval.
//   evaluate_script                 → sensitive, 始终审批 (§6.5: code
//                                     execution in the page; read_only
//                                     deny). A filePath ride-along never
//                                     upgrades it to an auto-allow.
//   emulate / performance traces / lighthouse_audit
//                                   → approval at ask / workspace_write,
//                                     automatic at unrestricted (§6.3
//                                     普通操作可自动 — page-local
//                                     measurement/modification, no user
//                                     data mutation). Trace collection
//                                     sends data off-page? The CrUX egress
//                                     is disabled in the manifest argv.
//
// Path rules follow the PR-2/PR-3 strict reading on every path-shaped input:
// control chars, UNC/device paths, drive-relative forms, `..` segments and
// (for uploads) paths outside the workspace are denied.

import type { ApprovalPreview } from '../../approval/approval-preview';
import { parseBrowserOrigin } from './playwright-classifier';
import type { BrowserOriginLeases } from './playwright-classifier';
import type {
  PackageRiskClassifier,
  SafeAudit,
  ToolRiskContext,
  ToolRiskDecision,
} from '../tool-risk-classifier';
import { inputDigestOf } from '../input-digest';

export const CHROME_DEVTOOLS_SERVER_NAME = 'trylo-chrome';

/** §6.5 lease TTL — the same 5-minute default the playwright origin lease
 *  uses; the two classifiers SHARE one store instance (App wires it), so a
 *  user-approved origin covers both browser surfaces in one conversation. */
export const CHROME_DEVTOOLS_LEASE_TTL_MS = 5 * 60 * 1000;

/** Inputs above this canonical-JSON size are never auto-allowed (§14.2). */
const MAX_INPUT_JSON_LENGTH = 256 * 1024;

// ── pinned tool surface (verified by the PR-7 tools/list smoke; the
// cross-package test pins this list against the manifest) ─────────────

export const CHROME_DEVTOOLS_TOOL_NAMES = Object.freeze([
  'list_pages',
  'select_page',
  'new_page',
  'close_page',
  'navigate_page',
  'wait_for',
  'take_snapshot',
  'take_screenshot',
  'evaluate_script',
  'get_console_message',
  'list_console_messages',
  'get_network_request',
  'list_network_requests',
  'performance_start_trace',
  'performance_stop_trace',
  'performance_analyze_insight',
  'lighthouse_audit',
  'take_heapsnapshot',
  'click',
  'drag',
  'hover',
  'fill',
  'fill_form',
  'press_key',
  'type_text',
  'handle_dialog',
  'upload_file',
  'resize_page',
  'emulate',
]);

/** Full `mcp__trylo-chrome__<tool>` names — the exact set both the manifest
 *  and the router must agree on (cross-package test pins it). */
export const CHROME_DEVTOOLS_EXPECTED_TOOLS: readonly string[] =
  CHROME_DEVTOOLS_TOOL_NAMES.map((tool) => `mcp__${CHROME_DEVTOOLS_SERVER_NAME}__${tool}`);

const READ_TOOLS = new Set<string>([
  'list_pages',
  'select_page',
  'wait_for',
  'get_console_message',
  'list_console_messages',
  'list_network_requests',
  'performance_analyze_insight',
  'resize_page',
  // Dual tools: these are READS unless the input carries an explicit file
  // path (checked earlier via the FILE_WRITE analysis). Without one, the
  // result comes back inline — no bytes leave the page.
  'take_snapshot',
  'take_screenshot',
  'get_network_request',
]);

/** Tools whose input may carry an explicit file-WRITE path (pinned 1.8.0
 *  schemas). The server bounds these writes to the OS temp directory when
 *  no MCP roots are negotiated — a WRITE outside every Trylo-controlled
 *  zone, so the §6.3 write rules apply regardless of destination. */
const FILE_WRITE_TOOLS = new Set<string>([
  'take_snapshot',
  'take_screenshot',
  'get_network_request',
  'evaluate_script',
  'performance_start_trace',
  'performance_stop_trace',
  'take_heapsnapshot',
]);

/** The path-shaped fields per file-write tool (pinned 1.8.0 schemas). */
const FILE_WRITE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  take_snapshot: ['filePath'],
  take_screenshot: ['filePath'],
  get_network_request: ['requestFilePath', 'responseFilePath'],
  evaluate_script: ['filePath'],
  performance_start_trace: ['filePath'],
  performance_stop_trace: ['filePath'],
  take_heapsnapshot: ['filePath'],
});

const NAVIGATION_TOOLS = new Set<string>(['navigate_page', 'new_page']);

const INTERACTION_TOOLS = new Set<string>([
  'click',
  'drag',
  'hover',
  'fill',
  'fill_form',
  'press_key',
  'type_text',
  'handle_dialog',
  'upload_file',
]);

const HEAVY_TOOLS = new Set<string>([
  'emulate',
  'lighthouse_audit',
  'performance_start_trace',
  'performance_stop_trace',
  // The schema requires a filePath for a heap snapshot; without one the
  // server errors anyway — the honest decision is a heavy-operation
  // approval, never unknown_tool.
  'take_heapsnapshot',
]);

/** Fields whose VALUES the model authored and that may carry credentials —
 *  escalated in the preview reason only (never echoed). The decision for
 *  interaction tools is an approval either way. */
const VALUE_FIELDS = ['value', 'text', 'keys'] as const;

const CREDENTIAL_VALUE_PATTERNS = [
  /\bpassword\b/i,
  /密码/,
  /口令/,
  /\bcredential/i,
  /\bapi[ -]?key\b/i,
  /\btoken\b/i,
] as const;

// ── lexical helpers (PR-2/PR-3 strict reading) ───────────────────────

const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function inputJsonLength(input: Readonly<Record<string, unknown>>): number {
  try {
    return JSON.stringify(input).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** A file-write path: `..`, UNC/device/drive-relative and control chars are
 *  denied outright. Absolute paths are ALLOWED here (the server restricts
 *  them to the OS temp dir and errors otherwise — fail-closed at runtime);
 *  the decision still follows the §6.3 write rules. */
function unsafeWritePath(value: string): string | null {
  if (hasControlChars(value)) return 'invalid_path';
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('//./') || normalized.startsWith('//?/')) return 'device_path';
  if (normalized.startsWith('//')) return 'unc_path';
  if (/^[a-zA-Z]:(?![/\\]|$)/.test(value)) return 'drive_relative_path';
  const segments = normalized.split('/').filter((s) => s !== '');
  if (segments.some((s) => RESERVED_DEVICE_NAME.test(s))) return 'reserved_device_name';
  if (segments.some((s) => s === '..')) return 'dotdot_segment';
  return null;
}

/** Upload paths follow the STRICTER playwright rule: they must live inside
 *  the workspace (local data offered to a page is a governance decision,
 *  not a temp-dir write). */
function unsafeUploadPath(value: string): string | null {
  const problem = unsafeWritePath(value);
  if (problem) return problem;
  return null; // containment against projectRoot happens below
}

function isInsideWorkspace(raw: string, canonicalRoot: string): boolean {
  const normalized = raw.replace(/\\/g, '/');
  const isAbsolute = /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/');
  // A relative upload path resolves against the workspace root.
  if (!isAbsolute) return true;
  const lower = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
  const root = lower(canonicalRoot);
  const path = lower(normalized);
  return path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
}

/** Upload path fields of the pinned 1.8.0 schema. */
function uploadPathsOf(input: Readonly<Record<string, unknown>>): readonly string[] {
  const paths = input['filePaths'];
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths)) return [];
  return paths.filter((p): p is string => typeof p === 'string');
}

function hasCredentialValue(input: Readonly<Record<string, unknown>>): boolean {
  for (const field of VALUE_FIELDS) {
    const value = input[field];
    if (typeof value !== 'string') continue;
    for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
      if (pattern.test(value)) return true;
    }
  }
  return false;
}

// ── decision plumbing ────────────────────────────────────────────────

const DENY_MESSAGES: Readonly<Record<string, string>> = {
  malformed_input:
    'Denied: the browser debug tool input could not be parsed safely. Send the tool its documented string/number fields.',
  unknown_tool:
    'Denied: this tool is not part of the pinned Chrome DevTools tool set.',
  invalid_url:
    'Denied: navigation requires a valid http(s) URL. file:, javascript:, data: and other schemes are not allowed.',
  url_with_credentials:
    'Denied: URLs carrying embedded credentials are not allowed.',
  origin_blocked:
    'Denied: this origin is on the package blocked list.',
  invalid_path: 'Denied: the path value contains control characters.',
  unc_path: 'Denied: UNC paths are not allowed in browser tool input.',
  device_path: 'Denied: device-namespace paths are not allowed in browser tool input.',
  drive_relative_path: 'Denied: drive-relative paths are not allowed; use a full path.',
  reserved_device_name: 'Denied: the path uses a reserved Windows device name.',
  dotdot_segment: "Denied: '..' segments are not allowed in browser tool paths.",
  path_outside_workspace:
    'Denied: the upload path resolves outside the workspace root; files offered to the browser must live inside the workspace.',
  interaction_denied_read_only:
    'Denied: this conversation is read-only. Browser clicks, typing and dialogs are unavailable.',
  code_denied_read_only:
    'Denied: this conversation is read-only. Browser script evaluation is unavailable.',
  file_write_denied_read_only:
    'Denied: this conversation is read-only. Saving browser output to a file is a write and is unavailable.',
};

function denyMessage(reasonCode: string): string {
  return DENY_MESSAGES[reasonCode] ?? `Denied: ${reasonCode}.`;
}

interface CdpAnalysis {
  readonly problem: string | null;
  readonly oversized: boolean;
  readonly origin: string | null;
  readonly outsideAllowlist: boolean;
  readonly writesFile: boolean;
  readonly uploads: boolean;
  readonly credentialValue: boolean;
}

function analyzeCdpInput(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  blockedOrigins: readonly string[],
  allowedOrigins: readonly string[],
  canonicalRoot: string,
): CdpAnalysis {
  const base: CdpAnalysis = {
    problem: null,
    oversized: inputJsonLength(input) > MAX_INPUT_JSON_LENGTH,
    origin: null,
    outsideAllowlist: false,
    writesFile: false,
    uploads: false,
    credentialValue: false,
  };
  if (!isPlainRecord(input)) return { ...base, problem: 'malformed_input' };

  if (NAVIGATION_TOOLS.has(toolName)) {
    const url = input['url'];
    if (url === undefined || url === null) {
      // new_page without a url opens a blank page — nothing external.
      return base;
    }
    if (typeof url !== 'string') return { ...base, problem: 'invalid_url' };
    const parsed = parseBrowserOrigin(url);
    if (parsed.kind === 'invalid') return { ...base, problem: parsed.reasonCode };
    if (blockedOrigins.some((o) => o.toLowerCase() === parsed.origin.toLowerCase())) {
      return { ...base, origin: parsed.origin, problem: 'origin_blocked' };
    }
    if (allowedOrigins.length > 0 && !allowedOrigins.some((o) => o.toLowerCase() === parsed.origin.toLowerCase())) {
      return { ...base, origin: parsed.origin, outsideAllowlist: true };
    }
    return { ...base, origin: parsed.origin };
  }

  if (FILE_WRITE_TOOLS.has(toolName)) {
    for (const field of FILE_WRITE_FIELDS[toolName] ?? []) {
      const value = input[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') return { ...base, problem: 'malformed_input' };
      const problem = unsafeWritePath(value);
      if (problem) return { ...base, problem };
      return { ...base, writesFile: true };
    }
    return base;
  }

  if (toolName === 'upload_file') {
    const paths = uploadPathsOf(input);
    const rawPaths = input['filePaths'];
    if (rawPaths !== undefined && rawPaths !== null && !Array.isArray(rawPaths)) {
      return { ...base, problem: 'malformed_input' };
    }
    for (const raw of paths) {
      const problem = unsafeUploadPath(raw);
      if (problem) return { ...base, problem };
      if (!isInsideWorkspace(raw, canonicalRoot)) return { ...base, problem: 'path_outside_workspace' };
    }
    return { ...base, uploads: paths.length > 0 };
  }

  if (INTERACTION_TOOLS.has(toolName)) {
    return { ...base, credentialValue: hasCredentialValue(input) };
  }

  return base;
}

function buildAudit(
  context: ToolRiskContext,
  analysis: CdpAnalysis,
  behavior: SafeAudit['behavior'],
  risk: SafeAudit['risk'],
  reasonCode: string,
): SafeAudit {
  const pathZones: { field: string; zone: string }[] = [];
  if (analysis.writesFile) pathZones.push({ field: 'filePath', zone: 'os-temp' });
  if (analysis.uploads) pathZones.push({ field: 'filePaths', zone: 'workspace' });
  return {
    at: context.at,
    profileId: context.profileId,
    packageId: context.packageId,
    toolName: context.toolName,
    behavior,
    risk,
    reasonCode,
    inputDigest: inputDigestOf(context.input),
    pathZones,
  };
}

// ── the §6.5 × §6.3 matrix ───────────────────────────────────────────

export function classifyChromeDevtoolsTool(
  context: ToolRiskContext,
  options: {
    readonly leases?: BrowserOriginLeases | null;
    readonly blockedOrigins?: readonly string[];
    readonly allowedOrigins?: readonly string[];
  } = {},
): ToolRiskDecision {
  const blocked = options.blockedOrigins ?? [];
  const allowed = options.allowedOrigins ?? [];
  const canonicalRoot = context.projectRoot.replace(/[\\/]+$/, '');
  const shortName = context.toolName.split('__').pop() ?? context.toolName;
  const analysis = analyzeCdpInput(shortName, context.input, blocked, allowed, canonicalRoot);

  const deny = (reasonCode: string): ToolRiskDecision => ({
    behavior: 'deny',
    reasonCode,
    userMessage: denyMessage(reasonCode),
    audit: buildAudit(context, analysis, 'deny', null, reasonCode),
  });
  const prompt = (
    risk: 'external' | 'sensitive' | 'destructive',
    reasonCode: string,
    reasonText: string,
    lease?: { kind: 'browser-origin'; origin: string; actionClass: 'navigate'; conversationId: string; ttlMs: number },
  ): ToolRiskDecision => ({
    behavior: 'prompt',
    risk,
    reasonCode,
    preview: buildChromeDevtoolsApprovalPreview(context, reasonText),
    ...(lease ? { lease } : {}),
    audit: buildAudit(context, analysis, 'prompt', risk, reasonCode),
  });
  const autoAllow = (reasonCode: string, risk: 'read' | 'workspace-write' = 'read'): ToolRiskDecision => ({
    behavior: 'auto_allow',
    risk,
    reasonCode,
    audit: buildAudit(context, analysis, 'auto_allow', risk, reasonCode),
  });

  if (analysis.problem) return deny(analysis.problem);
  if (analysis.oversized && context.permissionLevel !== 'unrestricted') {
    return prompt('sensitive', 'input_too_large', '输入超过自动分类上限，需人工确认');
  }

  // Code execution — 即使 unrestricted 也不放行（安全底线）
  if (shortName === 'evaluate_script') {
    if (context.permissionLevel === 'read_only') return deny('code_denied_read_only');
    return prompt('sensitive', 'evaluate_requires_approval', '浏览器内执行脚本：始终需要审批');
  }

  // §6.3 write rules: the server bounds explicit filePath writes to the OS
  // temp dir, but a write is a write (§6.2 path rules — the destination is
  // outside .trylo/out and the runtime dir either way).
  if (analysis.writesFile) {
    if (context.permissionLevel === 'read_only') return deny('file_write_denied_read_only');
    if (context.permissionLevel === 'unrestricted') {
      return autoAllow('unrestricted_file_write', 'workspace-write');
    }
    return prompt('external', 'file_write_requires_approval', '将把输出写入文件（服务器限制在系统临时目录），需审批');
  }

  if (READ_TOOLS.has(shortName)) {
    return autoAllow('cdp_read');
  }

  if (NAVIGATION_TOOLS.has(shortName)) {
    // new_page without a url opens a blank local page — nothing external
    // (navigate_page without a url is a server-side schema error; auto is
    // harmless because the server rejects it).
    if (analysis.origin === null) {
      return autoAllow('new_blank_page');
    }
    const origin = analysis.origin;
    if (context.permissionLevel === 'unrestricted' && !analysis.outsideAllowlist) {
      return autoAllow('unrestricted_navigate');
    }
    if (!analysis.outsideAllowlist && options.leases?.active(origin, context.conversationId, context.at)) {
      return autoAllow('origin_leased');
    }
    if (context.permissionLevel === 'workspace_write' && !analysis.outsideAllowlist) {
      return prompt(
        'external',
        'navigate_new_origin',
        `首次访问 ${origin || '该域'} 需审批；批准后将获得 5 分钟同域导航授权`,
        { kind: 'browser-origin', origin, actionClass: 'navigate', conversationId: context.conversationId, ttlMs: CHROME_DEVTOOLS_LEASE_TTL_MS },
      );
    }
    return prompt('external', 'navigate_requires_approval', `导航到 ${origin || '外部站点'} 需审批`);
  }

  if (shortName === 'close_page') {
    if (context.permissionLevel === 'unrestricted') return autoAllow('unrestricted_close');
    return prompt('external', 'page_close', '关闭页面需确认（可能丢失未保存状态）');
  }

  if (analysis.uploads) {
    if (context.permissionLevel === 'unrestricted') return autoAllow('unrestricted_upload', 'workspace-write');
    return prompt('sensitive', 'uploads_local_file', '将把本地文件提供给网页（数据离开工作区），需审批');
  }

  if (INTERACTION_TOOLS.has(shortName)) {
    if (context.permissionLevel === 'read_only') return deny('interaction_denied_read_only');
    if (context.permissionLevel === 'unrestricted') return autoAllow('unrestricted_interaction');
    return prompt(
      'external',
      analysis.credentialValue ? 'credential_value_typed' : 'interaction_requires_approval',
      analysis.credentialValue
        ? '输入内容疑似凭据，强制审批（内容不会显示在预览中）'
        : '浏览器交互操作（点击/输入/对话框）需审批',
    );
  }

  if (HEAVY_TOOLS.has(shortName)) {
    if (context.permissionLevel === 'unrestricted') return autoAllow('unrestricted_heavy_operation');
    return prompt('external', 'heavy_operation_requires_approval', '性能/审计/仿真操作需审批');
  }

  // A tool the manifest pins but this classifier does not know: fail closed.
  return deny('unknown_tool');
}

// ── safe preview ─────────────────────────────────────────────────────

/** What the preview may echo. Typed values (fill/type_text), evaluated
 *  script text and dialog payloads are NEVER echoed (§6.2). Opaque snapshot
 *  uids, origins (query stripped by the URL parser) and file names are. */
function targetSummary(toolName: string, input: Readonly<Record<string, unknown>>): string {
  const uid = typeof input['uid'] === 'string' ? `元素 ${input['uid']}` : null;
  switch (toolName) {
    case 'navigate_page':
    case 'new_page': {
      const url = input['url'];
      if (typeof url === 'string') {
        const parsed = parseBrowserOrigin(url);
        return parsed.kind === 'ok' ? parsed.origin : '无效 URL';
      }
      return toolName === 'new_page' ? '空白页' : '当前页';
    }
    case 'take_screenshot':
      return input['filePath'] !== undefined && input['filePath'] !== null ? '屏幕截图 → 写文件' : '屏幕截图';
    case 'take_snapshot':
      return input['filePath'] !== undefined && input['filePath'] !== null ? '页面快照 → 写文件' : '页面快照';
    case 'evaluate_script':
      return input['filePath'] !== undefined && input['filePath'] !== null ? '脚本执行 → 写文件' : '脚本执行';
    case 'get_network_request':
      return '网络请求详情';
    case 'performance_start_trace':
    case 'performance_stop_trace':
      return '性能追踪';
    case 'lighthouse_audit':
      return 'Lighthouse 审计';
    case 'take_heapsnapshot':
      return '堆快照 → 写文件';
    case 'upload_file':
      return `上传 ${uploadPathsOf(input).length} 个本地文件`;
    case 'emulate':
      return '页面仿真';
    case 'handle_dialog':
      return '对话框处理';
    default:
      return uid ?? toolName;
  }
}

/**
 * Safe, redacted ApprovalPreview for a Chrome DevTools request. Shows the
 * action class and the target shape (origin / uid / file-write intent). It
 * never echoes typed values, evaluated scripts or dialog payloads (§6.2).
 */
export function buildChromeDevtoolsApprovalPreview(
  context: Pick<ToolRiskContext, 'toolName' | 'input'>,
  reasonText?: string,
): ApprovalPreview {
  try {
    const shortName = context.toolName.split('__').pop() ?? context.toolName;
    const input = isPlainRecord(context.input) ? context.input : {};
    return {
      kind: 'summary',
      title: '浏览器调试',
      target: targetSummary(shortName, input),
      reason: reasonText ?? defaultRiskText(shortName),
    };
  } catch {
    return {
      kind: 'summary',
      title: '浏览器调试',
      target: 'chrome-devtools',
      reason: '未能解析此请求的参数',
    };
  }
}

function defaultRiskText(shortName: string): string {
  if (shortName === 'evaluate_script') return '浏览器内脚本执行';
  if (INTERACTION_TOOLS.has(shortName)) return '浏览器交互操作';
  if (NAVIGATION_TOOLS.has(shortName)) return '页面导航';
  if (FILE_WRITE_TOOLS.has(shortName)) return '输出写入文件';
  if (HEAVY_TOOLS.has(shortName)) return '性能/审计操作';
  return 'Chrome DevTools 工具调用';
}

/** The classifier registered by the router (manifest twin: classifierId
 *  `chrome-devtools`, server `trylo-chrome`, the 29 pinned tools). */
export const chromeDevtoolsClassifier: PackageRiskClassifier = {
  id: 'chrome-devtools',
  serverName: CHROME_DEVTOOLS_SERVER_NAME,
  expectedTools: CHROME_DEVTOOLS_EXPECTED_TOOLS,
  classify: (context) => classifyChromeDevtoolsTool(context),
};

export default chromeDevtoolsClassifier;

/**
 * Production constructor: App wires the SAME browser origin-lease store the
 * playwright classifier uses (a user-approved origin covers both browser
 * surfaces in one conversation — one human decision, one surface class)
 * plus the manifest's origin lists (§8.2 / PR-3 偏差④收口).
 */
export function createChromeDevtoolsClassifier(
  options: {
    readonly leases?: BrowserOriginLeases | null;
    readonly blockedOrigins?: readonly string[];
    readonly allowedOrigins?: readonly string[];
  } = {},
): PackageRiskClassifier {
  return {
    id: 'chrome-devtools',
    serverName: CHROME_DEVTOOLS_SERVER_NAME,
    expectedTools: CHROME_DEVTOOLS_EXPECTED_TOOLS,
    classify: (context) => classifyChromeDevtoolsTool(context, options),
  };
}
