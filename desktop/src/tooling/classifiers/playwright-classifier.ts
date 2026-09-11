// Trylo Desktop — Playwright MCP risk classifier.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §6.5 (action table) ×
// §6.3 (permission matrix) / §6.2 (URL + audit rules) / §13 PR-3.
//
// The pinned 0.0.79 surface exposes 24 tools. The server's own annotations
// are HINTS ONLY (§6.2): `browser_take_screenshot` claims read-only while
// writing files, and `browser_navigate`/`browser_click` correctly claim
// non-read-only — Trylo's own table decides, every call.
//
// Policy (§6.5 首版策略 mapped onto the pinned tool names):
//   snapshot / console / network / find / wait / hover / resize / close /
//   navigate_back            → read, auto at every level (screenshots and
//                               `filename` results land in the Trylo-
//                               controlled runtime dir, never the workspace)
//   navigate / tabs:new      → URL parsed (standard protocols only), origin
//                               checked against the manifest origin lists;
//                               read_only+ask → approval, workspace_write →
//                               first visit to a new origin is approved and
//                               grants a SHORT LEASE (origin + action class
//                               + conversation + 5 min TTL) that later
//                               in-origin navigations consume (§6.5 短期
//                               授权 lease；模型不能创建或扩大 lease),
//                               unrestricted → auto
//   click / type / press_key / fill_form / select_option / drag / drop /
//   upload / dialog          → ask: approval at every level ≥ ask, DENIED
//                               read_only (§6.3 点击/输入拒绝). A target
//                               whose description carries submit/send/
//                               publish/delete/purchase/pay/login/permission
//                               semantics escalates to `sensitive` (强制
//                               审批, bypass-immune). Element effects are
//                               NOT determinable from input, so these never
//                               auto-allow (§6.5).
//   evaluate / run_code_unsafe → sensitive, 始终审批 (read_only: deny)
//   download                  → no explicit tool in 0.0.79: downloads land
//                               in the runtime temp dir and reach .trylo/out
//                               only through the Artifact Promoter (§6.5).
//
// Path rules follow the PR-2 strict reading: `..` segments, absolute paths
// outside the workspace, UNC/device/drive-relative forms and reserved
// device names are denied. Upload paths are validated like any other path
// field — uploading a workspace file is still an approval (local data
// leaving to a remote page), never an auto-allow.

import type { ApprovalPreview } from '../../approval/approval-preview';
import { canonicalizeCwd } from '../runtime-fingerprint';
import type {
  PackageRiskClassifier,
  SafeAudit,
  ToolRiskContext,
  ToolRiskDecision,
} from '../tool-risk-classifier';
import { inputDigestOf, stableStringifyInput } from '../input-digest';

export const PLAYWRIGHT_SERVER_NAME = 'trylo-browser';

/** §6.5 lease TTL: 「默认 5 分钟」. */
export const BROWSER_LEASE_TTL_MS = 5 * 60 * 1000;

/** Inputs above this canonical-JSON size are never auto-allowed (§14.2). */
const MAX_INPUT_JSON_LENGTH = 256 * 1024;

const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** §6.5: 「包含 submit、send、publish、delete、purchase、pay、login、
 *  permission 等目标语义：强制审批」. Word-boundary matching over the
 *  model-authored element descriptions; a false positive only means one
 *  extra approval — the safe direction. */
const SENSITIVE_TARGET_PATTERNS = [
  /\bsubmit\b/i,
  /\bsend\b/i,
  /\bpublish\b/i,
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bpurchase\b/i,
  /\bpay(ment)?\b/i,
  /\bcheckout\b/i,
  /\blogin\b/i,
  /\bsign[ -]?in\b/i,
  /\bpermission\b/i,
  /\bpassword\b/i,
  /\bauthorize\b/i,
] as const;

// ── pinned tool surface (verified by the PR-3 tools/list smoke; the
// cross-package test pins this list against the manifest) ─────────────

export const PLAYWRIGHT_TOOL_NAMES = Object.freeze([
  'browser_snapshot',
  'browser_console_messages',
  'browser_network_requests',
  'browser_network_request',
  'browser_find',
  'browser_wait_for',
  'browser_take_screenshot',
  'browser_hover',
  'browser_resize',
  'browser_close',
  'browser_navigate_back',
  'browser_navigate',
  'browser_tabs',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_fill_form',
  'browser_select_option',
  'browser_drag',
  'browser_drop',
  'browser_file_upload',
  'browser_handle_dialog',
  'browser_evaluate',
  'browser_run_code_unsafe',
]);

/** Full `mcp__trylo-browser__<tool>` names — the exact set both the
 *  manifest and the router must agree on (cross-package test pins it). */
export const PLAYWRIGHT_EXPECTED_TOOLS: readonly string[] = PLAYWRIGHT_TOOL_NAMES.map(
  (tool) => `mcp__${PLAYWRIGHT_SERVER_NAME}__${tool}`,
);

const READ_TOOLS = new Set<string>([
  'browser_snapshot',
  'browser_console_messages',
  'browser_network_requests',
  'browser_network_request',
  'browser_find',
  'browser_wait_for',
  'browser_take_screenshot',
  'browser_hover',
  'browser_resize',
  'browser_close',
  'browser_navigate_back',
]);

const INTERACTION_TOOLS = new Set<string>([
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_fill_form',
  'browser_select_option',
  'browser_drag',
  'browser_drop',
  'browser_file_upload',
  'browser_handle_dialog',
]);

const CODE_TOOLS = new Set<string>(['browser_evaluate', 'browser_run_code_unsafe']);

/** Tools whose input may carry an explicit `filename`. VERIFIED against the
 *  pinned build's source: an explicit filename resolves against the server's
 *  workspace root (its cwd = the project root) — a WORKSPACE WRITE the
 *  model can aim at any relative path. Only auto attachments (page
 *  snapshots, downloads, no model-chosen path) land in `--output-dir`, the
 *  Trylo-controlled runtime dir. So a present `filename` is treated as a
 *  workspace write: denied read_only, an approval at ask/workspace_write,
 *  automatic only at unrestricted (still root-bounded by the server). */
const FILENAME_TOOLS = new Set<string>([
  'browser_snapshot',
  'browser_console_messages',
  'browser_network_requests',
  'browser_network_request',
  'browser_take_screenshot',
  'browser_evaluate',
  'browser_run_code_unsafe',
]);

/** Tools whose input may carry absolute upload paths. */
const UPLOAD_TOOLS = new Set<string>(['browser_file_upload', 'browser_drop']);

/** Free-text fields describing the element a tool targets. */
const TARGET_TEXT_FIELDS = ['element', 'startElement', 'endElement', 'target', 'startTarget', 'endTarget'] as const;

// ── origin leases (§6.5 短期授权) ────────────────────────────────────

export interface BrowserLeaseGrant {
  /** Discriminates the grant kind inside the shared registry plumbing. */
  readonly kind: 'browser-origin';
  /** Parsed origin, `scheme://host[:port]` — never a URL with a path. */
  readonly origin: string;
  readonly actionClass: 'navigate';
  readonly conversationId: string;
  readonly ttlMs: number;
}

const LEASE_LIMIT = 256;

/**
 * In-memory lease store. Deliberately part of the classifier instance:
 * classification stays synchronous (no I/O, no clock — `at` is injected),
 * and the state only ever EXPANDS auto-allow for an origin a human already
 * approved, TTL-bounded. The model has no path that creates a lease; only
 * a user approval through the permission registry does.
 */
export class BrowserOriginLeases {
  private readonly entries = new Map<string, number>();

  /** Record a user-approved lease. A re-approval resets the TTL — that is
   *  a fresh human decision, not the model expanding a lease. */
  grant(grant: BrowserLeaseGrant, at: number = Date.now()): void {
    this.prune(at);
    this.entries.set(leaseKey(grant), at + Math.max(0, grant.ttlMs));
    if (this.entries.size > LEASE_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** True when a live lease covers `origin` in this conversation. */
  active(origin: string, conversationId: string, at: number): boolean {
    const key = `${conversationId}::${origin}`;
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= at) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /** Drop ONE conversation's origin leases — the per-conversation
   *  emergency-stop path (§13 PR-6: stop 后无残留控制). Keys are
   *  `${conversationId}::${origin}`, so the prefix match drops every
   *  origin a stopped conversation had approved. */
  revokeConversation(conversationId: string): void {
    const prefix = `${conversationId}::`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /** Drop ALL origin leases immediately — the global emergency-stop path. */
  revokeAll(): void {
    this.entries.clear();
  }

  private prune(at: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= at) this.entries.delete(key);
    }
  }
}

function leaseKey(grant: Pick<BrowserLeaseGrant, 'origin' | 'conversationId'>): string {
  return `${grant.conversationId}::${grant.origin}`;
}

// ── lexical helpers ──────────────────────────────────────────────────

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

/**
 * §6.2: 「URL 只解析标准协议和 hostname，不做字符串前缀判断」. http/https
 * only; credentials in the URL are refused (they are secrets riding in a
 * navigable string); the returned origin is `scheme://host[:port]`.
 */
export function parseBrowserOrigin(raw: string): { kind: 'ok'; origin: string } | { kind: 'invalid'; reasonCode: string } {
  if (typeof raw !== 'string' || raw.trim() === '' || hasControlChars(raw)) {
    return { kind: 'invalid', reasonCode: 'invalid_url' };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { kind: 'invalid', reasonCode: 'invalid_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'invalid', reasonCode: 'invalid_url' };
  }
  if (!parsed.hostname) return { kind: 'invalid', reasonCode: 'invalid_url' };
  if (parsed.username || parsed.password) {
    return { kind: 'invalid', reasonCode: 'url_with_credentials' };
  }
  return { kind: 'ok', origin: parsed.origin };
}

/** A `filename` result field must stay inside the runtime outputDir. */
function unsafeFilename(value: string): string | null {
  if (hasControlChars(value)) return 'invalid_path';
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('//./') || normalized.startsWith('//?/')) return 'device_path';
  if (normalized.startsWith('//')) return 'unc_path';
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/')) return 'absolute_output_filename';
  const segments = normalized.split('/').filter((s) => s !== '');
  if (segments.some((s) => RESERVED_DEVICE_NAME.test(s))) return 'reserved_device_name';
  if (segments.some((s) => s === '..')) return 'dotdot_segment';
  return null;
}

function sensitiveTargetText(input: Readonly<Record<string, unknown>>): boolean {
  for (const field of TARGET_TEXT_FIELDS) {
    const value = input[field];
    if (typeof value !== 'string') continue;
    for (const pattern of SENSITIVE_TARGET_PATTERNS) {
      if (pattern.test(value)) return true;
    }
  }
  return false;
}

function inputJsonLength(input: Readonly<Record<string, unknown>>): number {
  try {
    return stableStringifyInput(input).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** The upload path fields of the pinned 0.0.79 schema. */
function uploadPathsOf(input: Readonly<Record<string, unknown>>): readonly string[] {
  const paths = input['paths'];
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths)) return [];
  return paths.filter((p): p is string => typeof p === 'string');
}

interface WorkspaceCheck {
  readonly inside: boolean;
  readonly display: string;
}

/** Same containment rule family as the officecli classifier (PR-2 strict
 *  reading): lexical, case-insensitive on Windows drive roots. */
function locateInWorkspace(raw: string, canonicalRoot: string): WorkspaceCheck {
  const normalized = raw.replace(/\\/g, '/');
  const isAbsolute = /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/');
  const segments = normalized.split('/').filter((s) => s !== '' && s !== '.');
  let full: string;
  if (!isAbsolute) {
    full = `${canonicalRoot}/${segments.join('/')}`;
  } else if (/^[a-zA-Z]:/.test(normalized)) {
    const drive = normalized.slice(0, 1).toLowerCase();
    const rest = segments.slice(1).join('/');
    full = rest ? `${drive}:/${rest}` : `${drive}:`;
  } else {
    full = `/${segments.join('/')}`;
  }
  const rootKey = canonicalRoot.toLowerCase();
  const fullKey = full.toLowerCase();
  const inside = fullKey === rootKey || fullKey.startsWith(`${rootKey}/`);
  const rel = inside ? full.slice(canonicalRoot.length).replace(/^\//, '') : normalized;
  return { inside, display: inside ? rel : rel };
}

// ── decision plumbing ────────────────────────────────────────────────

const DENY_MESSAGES: Readonly<Record<string, string>> = {
  malformed_input:
    'Denied: the browser tool input could not be parsed safely. Send the tool its documented string/number fields.',
  unknown_tool:
    'Denied: this tool is not part of the pinned Playwright tool set.',
  invalid_url:
    'Denied: navigation requires a valid http(s) URL. file:, javascript:, data: and other schemes are not allowed.',
  url_with_credentials:
    'Denied: URLs carrying embedded credentials are not allowed.',
  origin_blocked:
    'Denied: this origin is on the package blocked list.',
  invalid_path: "Denied: the '{field}' value contains control characters.",
  unc_path: 'Denied: UNC paths are not allowed in browser tool input.',
  device_path: 'Denied: device-namespace paths are not allowed in browser tool input.',
  drive_relative_path: 'Denied: drive-relative paths are not allowed; use a full workspace path.',
  reserved_device_name: 'Denied: the path uses a reserved Windows device name.',
  dotdot_segment: "Denied: '..' segments are not allowed in browser tool paths.",
  absolute_output_filename:
    "Denied: 'filename' must be a relative name; results are stored in the Trylo-controlled runtime output directory.",
  path_outside_workspace:
    'Denied: the path resolves outside the workspace root; files offered to the browser must live inside the workspace.',
  interaction_denied_read_only:
    'Denied: this conversation is read-only. Browser clicks, typing, uploads and dialogs are unavailable.',
  code_denied_read_only:
    'Denied: this conversation is read-only. Browser code evaluation is unavailable.',
  filename_denied_read_only:
    'Denied: this conversation is read-only. Saving a browser result to a workspace file is a write and is unavailable.',
  filename_writes_workspace:
    'Saving a browser result into the workspace needs approval (the file path is chosen by the tool input).',
};

function denyMessage(reasonCode: string): string {
  return DENY_MESSAGES[reasonCode] ?? `Denied: ${reasonCode}.`;
}

interface PlaywrightAnalysis {
  readonly problem: string | null;
  /** A prompt-without-lease: the origin is outside a configured allow list.
   *  Not a deny — the server filters requests, not navigations — but it is
   *  never auto-allowed and carries no lease. */
  readonly outsideAllowlist: boolean;
  readonly oversized: boolean;
  readonly origin: string | null;
  readonly hasSensitiveTarget: boolean;
  readonly uploadsWorkspace: boolean;
  /** A model-chosen `filename` is present → the call WRITES the workspace
   *  root (pinned-server behaviour, see FILENAME_TOOLS). */
  readonly writesWorkspace: boolean;
  readonly workspaceFile: string | null;
}

function analyzePlaywrightInput(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  manifestBlocked: readonly string[],
  manifestAllowed: readonly string[],
  canonicalRoot: string,
): PlaywrightAnalysis {
  const base: PlaywrightAnalysis = {
    problem: null,
    outsideAllowlist: false,
    oversized: inputJsonLength(input) > MAX_INPUT_JSON_LENGTH,
    origin: null,
    hasSensitiveTarget: false,
    uploadsWorkspace: false,
    writesWorkspace: false,
    workspaceFile: null,
  };
  if (!isPlainRecord(input)) return { ...base, problem: 'malformed_input' };

  if (toolName === 'browser_navigate' || toolName === 'browser_tabs') {
    let url: unknown = input['url'];
    if (toolName === 'browser_tabs') {
      const action = input['action'];
      if (typeof action !== 'string' || !['list', 'select', 'close', 'new'].includes(action.trim())) {
        return { ...base, problem: 'malformed_input' };
      }
      if (action.trim() !== 'new') return base;
      url = input['url'];
      if (url === undefined || url === null) return base; // blank tab
    }
    if (typeof url !== 'string') return { ...base, problem: 'invalid_url' };
    const parsed = parseBrowserOrigin(url);
    if (parsed.kind === 'invalid') return { ...base, problem: parsed.reasonCode };
    if (manifestBlocked.some((o) => o.toLowerCase() === parsed.origin.toLowerCase())) {
      return { ...base, origin: parsed.origin, problem: 'origin_blocked' };
    }
    if (manifestAllowed.length > 0 && !manifestAllowed.some((o) => o.toLowerCase() === parsed.origin.toLowerCase())) {
      // The server filters requests, not navigations; an origin outside a
      // configured allow list stays a human decision (never auto).
      return { ...base, origin: parsed.origin, outsideAllowlist: true };
    }
    return { ...base, origin: parsed.origin };
  }

  if (FILENAME_TOOLS.has(toolName)) {
    const filename = input['filename'];
    if (filename !== undefined && filename !== null) {
      if (typeof filename !== 'string') return { ...base, problem: 'malformed_input' };
      const problem = unsafeFilename(filename);
      if (problem) return { ...base, problem };
      // Safe relative name → the server writes it under the workspace root
      // (its cwd), NOT the runtime outputDir. Workspace write.
      return { ...base, writesWorkspace: true, workspaceFile: filename.trim() };
    }
  }

  if (UPLOAD_TOOLS.has(toolName)) {
    const paths = uploadPathsOf(input);
    const rawPaths = input['paths'];
    if (rawPaths !== undefined && rawPaths !== null && !Array.isArray(rawPaths)) {
      return { ...base, problem: 'malformed_input' };
    }
    for (const raw of paths) {
      if (hasControlChars(raw)) return { ...base, problem: 'invalid_path' };
      const normalized = raw.replace(/\\/g, '/');
      if (normalized.startsWith('//./') || normalized.startsWith('//?/')) return { ...base, problem: 'device_path' };
      if (normalized.startsWith('//')) return { ...base, problem: 'unc_path' };
      if (/^[a-zA-Z]:(?![/\\]|$)/.test(raw)) return { ...base, problem: 'drive_relative_path' };
      const segments = normalized.split('/').filter((s) => s !== '');
      if (segments.some((s) => RESERVED_DEVICE_NAME.test(s))) return { ...base, problem: 'reserved_device_name' };
      if (segments.some((s) => s === '..')) return { ...base, problem: 'dotdot_segment' };
      if (!locateInWorkspace(raw, canonicalRoot).inside) return { ...base, problem: 'path_outside_workspace' };
    }
    return { ...base, uploadsWorkspace: paths.length > 0, hasSensitiveTarget: sensitiveTargetText(input) };
  }

  return { ...base, hasSensitiveTarget: INTERACTION_TOOLS.has(toolName) ? sensitiveTargetText(input) : false };
}

function buildAudit(
  context: ToolRiskContext,
  analysis: PlaywrightAnalysis,
  behavior: SafeAudit['behavior'],
  risk: SafeAudit['risk'],
  reasonCode: string,
): SafeAudit {
  const pathZones: { field: string; zone: string }[] = [];
  if (analysis.uploadsWorkspace) pathZones.push({ field: 'paths', zone: 'workspace' });
  if (analysis.writesWorkspace) pathZones.push({ field: 'filename', zone: 'workspace' });
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

export function classifyPlaywrightTool(
  context: ToolRiskContext,
  options: {
    readonly leases?: BrowserOriginLeases | null;
    readonly blockedOrigins?: readonly string[];
    readonly allowedOrigins?: readonly string[];
  } = {},
): ToolRiskDecision {
  const blocked = options.blockedOrigins ?? [];
  const allowed = options.allowedOrigins ?? [];
  const canonicalRoot = canonicalizeCwd(context.projectRoot);
  const shortName = context.toolName.split('__').pop() ?? context.toolName;
  const analysis = analyzePlaywrightInput(shortName, context.input, blocked, allowed, canonicalRoot);

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
    lease?: BrowserLeaseGrant,
  ): ToolRiskDecision => ({
    behavior: 'prompt',
    risk,
    reasonCode,
    preview: buildPlaywrightApprovalPreview(context, reasonText),
    ...(lease ? { lease } : {}),
    audit: buildAudit(context, analysis, 'prompt', risk, reasonCode),
  });
  const autoAllow = (reasonCode: string, risk: 'read' | 'workspace-write' = 'read'): ToolRiskDecision => ({
    behavior: 'auto_allow',
    risk,
    reasonCode,
    audit: buildAudit(context, analysis, 'auto_allow', risk, reasonCode),
  });

  // A 完全自动：仅硬拒绝拦；oversized 在非完全自动下才卡
  if (analysis.problem) return deny(analysis.problem);
  if (analysis.oversized && context.permissionLevel !== 'unrestricted') {
    return prompt('sensitive', 'input_too_large', '输入超过自动分类上限，需人工确认');
  }

  // Code tools are bypass-immune — 始终审批（含 unrestricted，安全底线）
  if (CODE_TOOLS.has(shortName)) {
    if (context.permissionLevel === 'read_only') return deny('code_denied_read_only');
    return prompt('sensitive', 'evaluate_requires_approval', '浏览器内执行代码：始终需要审批');
  }

  // §6.3 workspace-write rule, verified against the pinned server source:
  // an explicit `filename` writes the WORKSPACE root, not the runtime
  // outputDir. read_only deny; ask/workspace_write approval; unrestricted
  // auto (the server still bounds the write inside its workspace root).
  if (analysis.writesWorkspace) {
    if (context.permissionLevel === 'read_only') return deny('filename_denied_read_only');
    if (context.permissionLevel === 'unrestricted') {
      return autoAllow('unrestricted_workspace_file', 'workspace-write');
    }
    return prompt('external', 'filename_writes_workspace', denyMessage('filename_writes_workspace'));
  }

  if (READ_TOOLS.has(shortName)) {
    return autoAllow('browser_read');
  }

  if (shortName === 'browser_navigate' || shortName === 'browser_tabs') {
    if (shortName === 'browser_tabs') {
      const action = isPlainRecord(context.input) ? String(context.input['action'] ?? '').trim() : '';
      if (action === 'list' || action === 'select') return autoAllow('browser_read');
      if (action === 'close') {
        if (context.permissionLevel === 'unrestricted') return autoAllow('unrestricted_tab_close');
        return prompt('external', 'tab_close', '关闭浏览器标签页需确认');
      }
      // action 'new': with a URL it is a navigation; without one it is a
      // blank tab (no origin, nothing external).
      if (!isPlainRecord(context.input) || context.input['url'] == null) {
        return autoAllow('new_tab');
      }
    }
    const origin = analysis.origin ?? '';
    if (context.permissionLevel === 'unrestricted') {
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
        { kind: 'browser-origin', origin, actionClass: 'navigate', conversationId: context.conversationId, ttlMs: BROWSER_LEASE_TTL_MS },
      );
    }
    return prompt('external', 'navigate_requires_approval', `导航到 ${origin || '外部站点'} 需审批`);
  }

  if (INTERACTION_TOOLS.has(shortName)) {
    if (context.permissionLevel === 'read_only') return deny('interaction_denied_read_only');
    if (context.permissionLevel === 'unrestricted') return autoAllow('unrestricted_interaction');
    const typedSubmit =
      shortName === 'browser_type' && isPlainRecord(context.input) && context.input['submit'] === true;
    if (analysis.hasSensitiveTarget || typedSubmit) {
      return prompt('sensitive', 'sensitive_target', '目标元素包含提交/发送/删除/支付/登录等敏感语义，强制审批');
    }
    if (analysis.uploadsWorkspace) {
      return prompt('sensitive', 'uploads_local_file', '将把本地文件提供给网页（数据离开工作区），需审批');
    }
    return prompt('external', 'interaction_requires_approval', '浏览器交互操作（点击/输入/对话框）需审批');
  }

  // A tool the manifest pins but this classifier does not know: fail closed.
  return deny('unknown_tool');
}

// ── safe preview ─────────────────────────────────────────────────────

/**
 * Safe, redacted ApprovalPreview for a browser request. Shows the action,
 * the origin (query/hash stripped — URLs can carry tokens) and the element
 * DESCRIPTION. It never echoes typed text, form values, evaluated code,
 * dialog prompt text or drop payloads (§6.2: no 键入文本 in previews).
 */
export function buildPlaywrightApprovalPreview(
  context: Pick<ToolRiskContext, 'toolName' | 'input'>,
  reasonText?: string,
): ApprovalPreview {
  try {
    const shortName = context.toolName.split('__').pop() ?? context.toolName;
    const input = isPlainRecord(context.input) ? context.input : {};
    let target = shortName;

    if (shortName === 'browser_navigate' || (shortName === 'browser_tabs' && input['url'] != null)) {
      const parsed = parseBrowserOrigin(String(input['url'] ?? ''));
      if (parsed.kind === 'ok') {
        let path = '';
        try {
          const u = new URL(String(input['url']).trim());
          // Show the path shape only — query strings can carry tokens.
          path = u.pathname === '/' ? '' : `${u.pathname}（参数已隐藏）`;
        } catch {
          path = '';
        }
        target = `${parsed.origin}${path}`;
      } else {
        target = '（无效 URL）';
      }
    } else if (shortName === 'browser_tabs') {
      target = `标签页 · ${String(input['action'] ?? '?')}`;
    } else if (shortName === 'browser_file_upload' || shortName === 'browser_drop') {
      const paths = uploadPathsOf(input);
      const shown = paths.slice(0, 3).map((p) => p.split(/[\\/]/).pop() ?? p);
      const more = paths.length > shown.length ? ` 等 ${paths.length} 个文件` : '';
      target = `${shown.join('、')}${more}`;
    } else if (CODE_TOOLS.has(shortName)) {
      target = '（脚本内容已隐藏）';
    } else if (shortName === 'browser_handle_dialog') {
      target = input['accept'] === true ? '对话框 · 接受' : '对话框 · 取消';
    } else {
      const filename = typeof input['filename'] === 'string' && input['filename'].trim() !== ''
        ? input['filename'].trim()
        : null;
      const element = TARGET_TEXT_FIELDS.map((f) => input[f])
        .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
        .at(0);
      target = filename
        ? `保存到工作区 · ${filename}`
        : (element?.trim().slice(0, 80) ?? shortName);
    }

    return {
      kind: 'summary',
      title: '浏览器操作',
      target,
      reason: reasonText ?? defaultRiskText(shortName),
    };
  } catch {
    return {
      kind: 'summary',
      title: '浏览器操作',
      target: 'browser',
      reason: '未能解析此请求的参数',
    };
  }
}

function defaultRiskText(shortName: string): string {
  if (CODE_TOOLS.has(shortName)) return '浏览器内执行代码（sensitive）';
  if (INTERACTION_TOOLS.has(shortName)) return '浏览器交互操作';
  if (READ_TOOLS.has(shortName)) return '浏览器读取操作';
  return 'Playwright MCP 工具调用';
}

/** The classifier registered by the router (manifest twin: classifierId
 *  `playwright`, server `trylo-browser`, the 24 pinned tools). */
export const playwrightClassifier: PackageRiskClassifier = {
  id: 'playwright',
  serverName: PLAYWRIGHT_SERVER_NAME,
  expectedTools: PLAYWRIGHT_EXPECTED_TOOLS,
  classify: (context) => classifyPlaywrightTool(context),
};

export default playwrightClassifier;

/**
 * Production constructor: App wires the SAME lease store into the
 * classifier and the permission registry's `onLeaseGrant`, so a user
 * approval of one navigation unlocks in-origin navigations for the lease
 * TTL (§6.5). Manifest origin lists ride along verbatim.
 */
export function createPlaywrightClassifier(
  options: {
    readonly leases?: BrowserOriginLeases | null;
    readonly blockedOrigins?: readonly string[];
    readonly allowedOrigins?: readonly string[];
  } = {},
): PackageRiskClassifier {
  return {
    id: 'playwright',
    serverName: PLAYWRIGHT_SERVER_NAME,
    expectedTools: PLAYWRIGHT_EXPECTED_TOOLS,
    classify: (context) => classifyPlaywrightTool(context, options),
  };
}
