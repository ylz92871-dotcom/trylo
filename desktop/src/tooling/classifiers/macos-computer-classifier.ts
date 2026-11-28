import { MACOS_COMPUTER_ID, MACOS_COMPUTER_SERVER, MACOS_COMPUTER_TOOLS } from '../../../../desktop-services/src/tooling/macos-computer-contract.mjs';
import { inputDigestOf } from '../input-digest';
import type { PackageRiskClassifier, SafeAudit, ToolRiskContext, ToolRiskDecision } from '../tool-risk-classifier';

const OBSERVATION_TOOLS = new Set(['list_apps', 'list_windows', 'list_ax_windows', 'inspect', 'ax_find', 'ax_read_text', 'screenshot', 'read_window_text']);
const BACKGROUND_AX_TOOLS = new Set(['ax_perform', 'ax_set_value']);
const KEYBOARD_TOOLS = new Set(['press_key', 'hotkey', 'type_text']);

function safeBundleId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9.-]+$/.test(value) ? value : undefined;
}

function safePidLabel(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? `PID ${value}` : undefined;
}

function classify(context: ToolRiskContext): ToolRiskDecision {
  const shortName = context.toolName.slice(`mcp__${MACOS_COMPUTER_SERVER}__`.length);
  const audit: SafeAudit = {
    at: context.at, profileId: context.profileId, packageId: context.packageId, toolName: context.toolName,
    inputDigest: inputDigestOf(context.input), pathZones: [],
    behavior: 'prompt', risk: 'sensitive', reasonCode: 'macos_desktop_requires_approval',
  };
  if (shortName === 'status') {
    const reasonCode = 'macos_computer_status';
    return { behavior: 'auto_allow', risk: 'read', reasonCode, audit: { ...audit, behavior: 'auto_allow', risk: 'read', reasonCode } };
  }
  if (context.permissionLevel === 'read_only') {
    const reasonCode = 'read_only';
    return { behavior: 'deny', reasonCode, userMessage: '只读会话无法查看或操作 macOS 桌面。', audit: { ...audit, behavior: 'deny', risk: null, reasonCode } };
  }
  if (OBSERVATION_TOOLS.has(shortName)) {
    const target = safePidLabel(context.input.pid ?? context.input.expectedPid ?? context.input.appPid);
    return {
      behavior: 'prompt', risk: 'sensitive', reasonCode: audit.reasonCode,
      preview: {
        kind: 'summary',
        title: '后台观察 macOS 窗口',
        reason: '此工具在后台读取 macOS 窗口或控件信息，不会切换当前前台窗口。',
        ...(target === undefined ? {} : { target }),
      },
      audit,
    };
  }
  if (shortName === 'open_app') {
    const target = safeBundleId(context.input.bundleId);
    const activates = context.input.activate === true;
    return {
      behavior: 'prompt', risk: 'sensitive', reasonCode: audit.reasonCode,
      preview: {
        kind: 'summary',
        title: activates ? '打开并切换到 macOS 应用' : '后台打开 macOS 应用',
        reason: activates ? '此工具会启动并切换到前台显示已安装的应用。' : '此工具在后台启动已安装的应用，不会抢占当前窗口焦点。',
        ...(target === undefined ? {} : { target }),
      },
      audit,
    };
  }
  if (shortName === 'activate_app') {
    const target = safeBundleId(context.input.bundleId) ?? safePidLabel(context.input.pid);
    return {
      behavior: 'prompt', risk: 'sensitive', reasonCode: audit.reasonCode,
      preview: {
        kind: 'summary',
        title: '切换前台 macOS 应用',
        reason: '此工具会将目标应用切换到前台并接管当前窗口焦点。',
        ...(target === undefined ? {} : { target }),
      },
      audit,
    };
  }
  if (shortName === 'ax_perform' && context.input.action === 'AXRaise') {
    const target = safePidLabel(context.input.pid);
    return {
      behavior: 'prompt', risk: 'sensitive', reasonCode: audit.reasonCode,
      preview: {
        kind: 'summary',
        title: '将 macOS 窗口置前',
        reason: '此辅助功能操作会将目标窗口置前，可能改变当前焦点。',
        ...(target === undefined ? {} : { target }),
      },
      audit,
    };
  }
  if (BACKGROUND_AX_TOOLS.has(shortName) || (shortName === 'click' && context.input.foreground !== true)) {
    const action = typeof context.input.action === 'string' && /^[A-Za-z]+$/.test(context.input.action) ? context.input.action : undefined;
    const target = action ?? safePidLabel(context.input.pid ?? context.input.expectedPid);
    return {
      behavior: 'prompt', risk: 'sensitive', reasonCode: audit.reasonCode,
      preview: {
        kind: 'summary',
        title: '后台操作 macOS 控件',
        reason: '此工具通过辅助功能在后台向目标控件提交操作，保留鼠标位置。',
        ...(target === undefined ? {} : { target }),
      },
      audit,
    };
  }
  if ((KEYBOARD_TOOLS.has(shortName) || shortName === 'scroll') && context.input.background !== false) {
    const target = safePidLabel(context.input.expectedPid);
    return {
      behavior: 'prompt', risk: 'sensitive', reasonCode: audit.reasonCode,
      preview: {
        kind: 'summary',
        title: shortName === 'scroll' ? '后台滚动 macOS 窗口' : '后台发送键盘输入',
        reason: shortName === 'scroll'
          ? '此工具将滚动事件定向发送到目标进程，不会移动鼠标或切换当前前台窗口。'
          : '此工具将键盘事件定向发送到目标进程，不会切换当前前台窗口。',
        ...(target === undefined ? {} : { target }),
      },
      audit,
    };
  }
  return {
    behavior: 'prompt', risk: 'sensitive', reasonCode: audit.reasonCode,
    preview: {
      kind: 'summary',
      title: '前台操作 macOS 桌面',
      reason: '此工具需要前台窗口并会移动光标或发送桌面输入。',
    },
    audit,
  };
}

export const macosComputerClassifier: PackageRiskClassifier = {
  id: MACOS_COMPUTER_ID, serverName: MACOS_COMPUTER_SERVER,
  expectedTools: MACOS_COMPUTER_TOOLS.map(name => `mcp__${MACOS_COMPUTER_SERVER}__${name}`), classify,
};
