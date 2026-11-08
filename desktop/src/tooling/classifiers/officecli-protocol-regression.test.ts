import { describe, expect, it } from 'vitest';

import { classifyOfficecli, OFFICECLI_TOOL_NAME } from './officecli-classifier';
import type { ToolRiskContext } from '../tool-risk-classifier';

function context(command: unknown, permissionLevel: ToolRiskContext['permissionLevel'] = 'unrestricted'): ToolRiskContext {
  return {
    profileId: 'work.core.v1', packageId: 'officecli', toolName: OFFICECLI_TOOL_NAME,
    input: { command }, permissionLevel, projectRoot: 'D:/work/proj',
    conversationId: 'protocol-regression', at: 1,
  };
}

describe('OfficeCLI shipped MCP command contract', () => {
  it('accepts the argv form advertised by tools/list, preserving empty values', () => {
    const decision = classifyOfficecli(context(['officecli', 'set', '.trylo/out/report.docx', '/body/p[1]', '--prop', 'text=']));
    expect(decision.behavior).toBe('auto_allow');
  });

  it('loads bundled skills and references without treating skill names as document paths', () => {
    for (const command of ['load_skill pptx', 'skill word', 'skills list', 'load_skill pptx --path references/layout.md']) {
      const decision = classifyOfficecli(context(command, 'read_only'));
      expect(decision.behavior).toBe('auto_allow');
      if (decision.behavior === 'auto_allow') expect(decision.risk).toBe('read');
    }
  });

  it('supports the shipped document commands through the existing write policy', () => {
    for (const verb of ['swap', 'refresh', 'add-part', 'open', 'save', 'close']) {
      expect(classifyOfficecli(context(`${verb} .trylo/out/report.docx /body/p[1] /body/p[2]`)).behavior).toBe('auto_allow');
      expect(classifyOfficecli(context(`${verb} .trylo/out/report.docx`, 'read_only')).behavior).toBe('deny');
    }
    expect(classifyOfficecli(context('raw-set .trylo/out/report.docx /document --xpath //w:p --action remove')).behavior).toBe('auto_allow');
    expect(classifyOfficecli(context('raw-set .trylo/out/report.docx /document --xpath //w:p --action remove', 'workspace_write')).behavior).toBe('prompt');
  });

  it('classifies dump output as a write while allowing a stdout dump in read-only mode', () => {
    expect(classifyOfficecli(context('dump docs/report.docx /body', 'read_only')).behavior).toBe('auto_allow');
    expect(classifyOfficecli(context('dump docs/report.docx /body --out .trylo/out/replay.json', 'read_only')).behavior).toBe('deny');
    expect(classifyOfficecli(context('dump docs/report.docx /body --out .trylo/out/replay.json', 'workspace_write')).behavior).toBe('auto_allow');
  });

  it('keeps CSV import source paths within the authorized workspace', () => {
    expect(classifyOfficecli(context(['import', '.trylo/out/report.xlsx', '/Sheet1', 'data/input.csv'])).behavior).toBe('auto_allow');
    const decision = classifyOfficecli(context(['import', '.trylo/out/report.xlsx', '/Sheet1', 'D:/private/input.csv']));
    expect(decision.behavior).toBe('deny');
    expect(decision.reasonCode).toBe('path_outside_workspace');
  });

  it('handles text batch files with the same policy as JSON batch input files', () => {
    expect(classifyOfficecli(context(['batch', '.trylo/out/report.pptx', '--from', 'replay.txt'])).behavior).toBe('auto_allow');
    expect(classifyOfficecli(context(['batch', '.trylo/out/report.pptx', '--from', 'replay.txt'], 'workspace_write')).behavior).toBe('prompt');
    expect(classifyOfficecli(context(['batch', '.trylo/out/report.pptx', '--from', '../replay.txt'])).behavior).toBe('deny');
  });

  it('allows authorized batch recovery while validating an explicit journal path', () => {
    expect(classifyOfficecli(context('batch .trylo/out/report.pptx --resume --force-resume')).behavior).toBe('auto_allow');
    expect(classifyOfficecli(context('batch .trylo/out/report.pptx --resume replay.json', 'workspace_write')).behavior).toBe('prompt');
    expect(classifyOfficecli(context('batch .trylo/out/report.pptx --resume ../replay.json')).behavior).toBe('deny');
  });

  it('accepts global discovery and JSON flags from the CLI grammar', () => {
    for (const command of ['--version', '--help', '--json get docs/report.docx /body']) {
      expect(classifyOfficecli(context(command, 'read_only')).behavior).toBe('auto_allow');
    }
  });

  it('rejects malformed argv and still enforces path and permission denials', () => {
    for (const command of [[], ['view', 42], ['view', null], {}]) {
      expect(classifyOfficecli(context(command)).behavior).toBe('deny');
    }
    expect(classifyOfficecli(context(['set', '../secret.docx', '/', '--prop', 'text='])).behavior).toBe('deny');
    expect(classifyOfficecli(context(['set', 'report.docx', '/', '--prop', 'text='], 'read_only')).behavior).toBe('deny');
  });
});
