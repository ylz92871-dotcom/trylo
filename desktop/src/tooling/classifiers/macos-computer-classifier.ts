import { MACOS_COMPUTER_ID, MACOS_COMPUTER_SERVER, MACOS_COMPUTER_TOOLS } from '../../../../desktop-services/src/tooling/macos-computer-contract.mjs';
import { inputDigestOf } from '../input-digest';
import type { PackageRiskClassifier, SafeAudit, ToolRiskContext, ToolRiskDecision } from '../tool-risk-classifier';

function classify(context: ToolRiskContext): ToolRiskDecision {
  const status = context.toolName === `mcp__${MACOS_COMPUTER_SERVER}__status`;
  const audit: SafeAudit = {
    at: context.at, profileId: context.profileId, packageId: context.packageId, toolName: context.toolName,
    inputDigest: inputDigestOf(context.input), pathZones: [],
    behavior: 'prompt', risk: 'sensitive', reasonCode: 'macos_desktop_requires_approval',
  };
  if (status) {
    const reasonCode = 'macos_computer_status';
    return { behavior: 'auto_allow', risk: 'read', reasonCode, audit: { ...audit, behavior: 'auto_allow', risk: 'read', reasonCode } };
  }
  if (context.permissionLevel === 'read_only') {
    const reasonCode = 'read_only';
    return { behavior: 'deny', reasonCode, userMessage: '只读会话无法查看或操作 macOS 桌面。', audit: { ...audit, behavior: 'deny', risk: null, reasonCode } };
  }
  return { behavior: 'prompt', risk: 'sensitive', reasonCode: audit.reasonCode,
    preview: { kind: 'summary', title: 'macOS 电脑操作', reason: '此工具会读取或操作当前 macOS 桌面。' }, audit };
}

export const macosComputerClassifier: PackageRiskClassifier = {
  id: MACOS_COMPUTER_ID, serverName: MACOS_COMPUTER_SERVER,
  expectedTools: MACOS_COMPUTER_TOOLS.map(name => `mcp__${MACOS_COMPUTER_SERVER}__${name}`), classify,
};
