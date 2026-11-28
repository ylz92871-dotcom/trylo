import { MACOS_COMPUTER_ID, MACOS_COMPUTER_SERVER, MACOS_COMPUTER_TOOLS } from '../../../../desktop-services/src/tooling/macos-computer-contract.mjs';
import { inputDigestOf } from '../input-digest';
import type { PackageRiskClassifier, SafeAudit, ToolRiskContext, ToolRiskDecision } from '../tool-risk-classifier';

const PREVIEWS: Record<string, { title: string; reason: string }> = {
  inspect: { title: '观察 macOS 前台窗口', reason: '读取当前前台应用的辅助功能控件信息。' },
  screenshot: { title: '截取 macOS 屏幕', reason: '截取所选显示器，可能包含其他应用的内容。' },
  click: { title: '点击 macOS 前台应用', reason: '移动鼠标并点击当前前台应用中的指定位置。' },
  press_key: { title: '向 macOS 前台应用发送按键', reason: '向已确认的当前前台应用发送导航或编辑按键。' },
  type_text: { title: '向 macOS 前台应用输入文字', reason: '向已确认的当前前台应用发送文字。' },
};

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
  const preview = PREVIEWS[shortName];
  if (!preview) {
    const reasonCode = 'unknown_tool';
    return { behavior: 'deny', reasonCode, userMessage: '不支持的 macOS 电脑工具。', audit: { ...audit, behavior: 'deny', risk: null, reasonCode } };
  }
  const pid = context.input.expectedPid;
  const target = typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? `PID ${pid}` : undefined;
  return {
    behavior: 'prompt', risk: 'sensitive', reasonCode: audit.reasonCode,
    preview: { kind: 'summary', ...preview, ...(target ? { target } : {}) }, audit,
  };
}

export const macosComputerClassifier: PackageRiskClassifier = {
  id: MACOS_COMPUTER_ID, serverName: MACOS_COMPUTER_SERVER,
  expectedTools: MACOS_COMPUTER_TOOLS.map(name => `mcp__${MACOS_COMPUTER_SERVER}__${name}`), classify,
};
