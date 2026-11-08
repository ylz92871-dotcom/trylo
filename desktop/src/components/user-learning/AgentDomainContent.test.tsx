import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDomainContent } from './AgentDomainContent';
afterEach(cleanup);
describe('domain learning content', () => {
  it('renders actual method hint, conditions and feedback without inventing steps', () => {
    render(<AgentDomainContent domain="method" content={{ card: { hint: '保留合法零金额行', appliesWhen: { tools: ['read_file'] }, lineage: { createdFrom: { turnId: 'turn-2', beat: 3 } } }, ledger: { uses: 2, supports: 1 } }}
      related={[{ turnId: 'turn-3', helped: false, recordedAt: '2026-11-04T01:00:00Z' }]} />);
    expect(screen.getByText('保留合法零金额行')).toBeTruthy();expect(screen.getByText('read_file')).toBeTruthy();
    expect(screen.getByText('反馈：未帮助')).toBeTruthy();expect(screen.queryByText('步骤与产物')).toBeNull();
  });
  it('renders both actual workflow step schemas, preserving input, output and failure behavior', () => {
    const { rerender } = render(<AgentDomainContent domain="workflow" content={{ nodes: [{ id: 'check', input: 'source.csv', output: 'checked.json', check: '核对行数', dependsOn: [] }] }} />);
    expect(screen.getByText('source.csv')).toBeTruthy();expect(screen.getByText('checked.json')).toBeTruthy();
    rerender(<AgentDomainContent domain="workflow" content={{ proposal: { procedure: { steps: [{ id: 'sum', action: '按项目汇总', inputs: ['checked.json'], outputs: ['report.md'], verify: '金额合计一致', onFailure: { action: 'goto', target: 'check', maxAttempts: 2, reason: '字段缺失' } }] } } }} />);
    expect(screen.getByText('按项目汇总')).toBeTruthy();expect(screen.getByText('report.md')).toBeTruthy();
    expect(screen.getByText(/返回 check，至多 2 次/)).toBeTruthy();expect(screen.queryByText('source.csv')).toBeNull();
  });
});
