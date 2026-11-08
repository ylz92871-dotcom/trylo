import type { ResolvedToolRuntime, ToolUnavailableCapability } from '../services-host/methods';

export interface BuiltinToolRunContext {
  readonly runtime: ResolvedToolRuntime | null;
  readonly computerUse?: boolean;
}

const RECOVERY = '仅在当前任务确实需要未就绪的工具且现有能力不能完成时，向用户说明恢复路径：在「设置 → 工具」检查选用状态、重新检测或重载工具服务；未安装的扩展按需安装，内置工具异常时修复或更新 Trylo，并按需准备对应软件。';
const FRESHNESS = '以本轮配置和实际发现为准；历史某轮未就绪或一次搜索无匹配，不能直接推成当前未挂载。';
const DISCOVERY = 'mcp_search_tools({}) 列当前状态；mcp_search_tools({"query":"浏览器截图"}) 按关键词跨实际已配置 server 发现 schema，带精确 server 可限定范围。再用 mcp_call_tool 按返回的精确 name/arguments 调用，不猜参数；加载 schema 不授予权限。';

const BUILTINS = [
  { id: 'office', label: 'OfficeCLI', packages: ['officecli'], servers: ['trylo-office'] },
  { id: 'browser', label: '浏览器', packages: ['playwright', 'chrome-devtools'], servers: ['trylo-browser', 'trylo-chrome'] },
  { id: 'windows', label: '电脑控制', packages: ['windows-mcp'], servers: ['trylo-windows'] },
] as const;

function usage(id: typeof BUILTINS[number]['id'], chrome: boolean): string {
  if (id === 'office') return 'OfficeCLI：只有 officecli 这一个 MCP 入口，command 按实际 schema 使用 string 或 argv array；load_skill、help、dump 都放在 command 内（例如 ["load_skill","pptx"]），不是独立工具，也不要虚构按 verb 拆开的字段。';
  if (id === 'windows') return '电脑控制：先用发现到的 Snapshot/Screenshot 读取状态，再按实际动作 schema 操作；位置、坐标空间和缩放来自最新观测，不猜单位、通用 action 或参数字段。';
  const pages = chrome ? 'Chrome DevTools 先 list_pages 或读取 new_page 返回目录取得真实数值 pageId，页面工具按 schema 填该 id，不猜 0/active；' : 'Playwright 使用本 server 返回的 browser_* 工具及其 schema；';
  return `浏览器：${pages}工作区 file:/// HTML（含 .trylo/out）由 Trylo 转为受控 HTTP 预览，不是一律禁用 file。只需看图可用 inline 返回；落盘按当前 schema 使用 filePath/filename（Chrome filePath 支持相对或绝对），写入仍受当前权限约束。`;
}

function safeReason(reason: string): string {
  return /^[a-z0-9_-]+$/.test(reason) ? reason : 'unavailable';
}

function reasonMessage(reason: string): string {
  if (reason === 'runtime_changed') return '运行环境在检查后发生变化，请重新检测或重载工具服务。';
  if (reason === 'not_installed') return '当前运行环境未就绪，请在工具设置检查；内置工具异常应修复或更新 Trylo。';
  if (reason === 'input_runtime_low_integrity' || reason === 'input_permission_probe_failed') return '当前电脑控制运行环境未通过访问检查，请在工具设置查看原因。';
  return '当前工具未就绪，请在工具设置重新检测或查看恢复指引。';
}

function failureLine(label: string, values: readonly string[]): string {
  const reasons = [...new Set(values.map(safeReason))];
  return `${label}：未就绪（${reasons.map(reason => `reasonCode=${reason}；${reasonMessage(reason)}`).join('；')}）。`;
}

function append(base: string | undefined, lines: readonly string[]): string {
  return [base, lines.join('\n')].filter(Boolean).join('\n\n');
}

/** The legacy availability-only call remains a safe projection for its callers. */
function availabilityOnly(
  base: string | undefined,
  unavailable: readonly ToolUnavailableCapability[],
): string | undefined {
  const names = [...new Set(unavailable.filter(item => item.type === 'package')
    .map(item => item.displayName ?? item.id))];
  if (names.length === 0) return base;
  return [base, [
    '## 本轮工具可用性',
    `当前未就绪的工具：${names.join('、')}。这些能力存在，但本轮不能调用。`,
    '当前可用能力以本轮实际工具目录和工具发现结果为准；使用已有能力继续完成能完成的部分。',
    '普通任务使用当前已有能力继续，不要在每轮开头主动重复报告缺失工具。',
    RECOVERY,
    '未暴露或用户关闭的工具不可调用；不得自动启用、安装或切换工具，不得绕过用户权限与审批。',
    '不得声称已经使用未就绪的扩展。',
  ].join('\n')].filter(Boolean).join('\n\n');
}

function unavailableList(value: readonly ToolUnavailableCapability[] | BuiltinToolRunContext): value is readonly ToolUnavailableCapability[] {
  return Array.isArray(value);
}

/** One pure, per-run projection. Configuration never substitutes for live discovery or approval. */
export function toolAvailabilitySystemPrompt(
  base: string | undefined,
  context: readonly ToolUnavailableCapability[] | BuiltinToolRunContext = [],
): string | undefined {
  if (unavailableList(context)) return availabilityOnly(base, context);
  const lines = ['## 本轮内置工具', FRESHNESS];
  const runtime = context.runtime;
  if (!runtime) return append(base, [...lines,
    '本轮工具配置快照缺失，无法据此确认 OfficeCLI、浏览器、电脑控制是否挂载；这不是用户禁用，也不是三项已就绪。',
    '若当前目录提供 mcp_search_tools，可先查看实际配置；不要把旧轮次状态当作本轮事实。']);

  lines.push('以下是本轮已解析的配置，不是连接成功证明；最终以实际目录、连接结果和当前权限为准。');
  const guidance: string[] = [];
  let unready = false;
  for (const builtin of BUILTINS) {
    if (builtin.id === 'windows' && context.computerUse === false) {
      lines.push(`${builtin.label}：本轮明确未选用（computerUse=false），不推断是谁关闭。`);
      continue;
    }
    const packages = new Set<string>(builtin.packages);
    const failures = runtime.unavailableCapabilities.filter(item => item.type === 'package' && packages.has(item.id));
    const unhealthy = runtime.packageHealth.filter(item => packages.has(item.id) && !item.available);
    if (failures.length || unhealthy.length) {
      unready = true;
      // Raw detail/userMessage can contain private executable paths; use fixed safe recovery text.
      lines.push(failureLine(builtin.label, [...failures.map(item => item.reasonCode),
        ...unhealthy.map(item => item.reasonCode ?? item.state)]));
      continue;
    }
    const servers = new Set<string>([...builtin.servers,
      ...runtime.packageHealth.filter(item => packages.has(item.id)).map(item => item.serverName)]);
    const configured = runtime.serverNames.filter(server => servers.has(server));
    if (!configured.length) {
      lines.push(`${builtin.label}：本轮未挂载，原因未确认；不等同于禁用或未安装。`);
      continue;
    }
    lines.push(`${builtin.label}：本轮已配置（${configured.map(server => `server=${server}`).join('，')}），按需发现连接。`);
    guidance.push(usage(builtin.id, configured.includes('trylo-chrome') || runtime.packageHealth.some(item => item.id === 'chrome-devtools' && configured.includes(item.serverName))));
  }
  const optionalFailures = runtime.unavailableCapabilities.filter(item => item.type === 'package'
    && !BUILTINS.some(builtin => builtin.packages.some(id => id === item.id)));
  for (const id of new Set(optionalFailures.map(item => item.id))) {
    unready = true;
    const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) ? id : 'unknown-package';
    lines.push(failureLine(`扩展 ${safeId}`, optionalFailures.filter(item => item.id === id).map(item => item.reasonCode)));
  }
  if (guidance.length) lines.push(DISCOVERY, ...guidance);
  if (unready) lines.push(RECOVERY);
  lines.push('不主动重复宣告缺失；未挂载或未就绪的能力不虚称已使用，也不自动启用、安装、改权限或重放业务调用。');
  return append(base, lines);
}
