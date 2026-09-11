// Person seat output parser tests (PR-5, spec §10.3).
// Fixtures derive from person.ts / work person.ts required output format.

import { describe, expect, it } from 'vitest';
import { isVetoActive, parsePersonSeatOutput } from './person-output';

const IDEAL = `看了合同和入口文件。

### Intent
- explicit: 导出函数必须保留验收步骤
- inferred: 保留轻量扩展点 (conf 0.76)
- unknown: 验收标准是行为还是截图

### Veto
\`none\`

### User questions
- 验收标准是行为还是截图？
- 需要兼容旧调用方吗？

### Representation notes
用户在意扩展点与验收步骤；避免大范围重构。`;

const VETO_BOLD = `### **Intent**
- explicit: none stated
- inferred: none
- unknown: 验收标准

### **Veto**
方案删掉了用户明确要求的验收步骤。来源: explicit.acceptance

### **User questions**
none

### **Representation notes**
先确认验收形态再继续。`;

describe('parsePersonSeatOutput', () => {
  it('parses the ideal person.ts output shape', () => {
    const out = parsePersonSeatOutput(IDEAL);
    expect(out).not.toBeNull();
    expect(out!.intent.explicit).toContain('验收步骤');
    expect(out!.intent.inferred).toContain('0.76');
    expect(out!.intent.unknown).toContain('行为还是截图');
    expect(out!.veto).toEqual({ active: false });
    expect(out!.userQuestions).toHaveLength(2);
    expect(out!.representationNotes).toContain('避免大范围重构');
    expect(isVetoActive(out!)).toBe(false);
  });

  it('parses bold-drift veto with contract field', () => {
    const out = parsePersonSeatOutput(VETO_BOLD);
    expect(out).not.toBeNull();
    expect(out!.veto.active).toBe(true);
    if (out!.veto.active) {
      expect(out!.veto.contractField).toBe('explicit.acceptance');
      expect(out!.veto.reason).toContain('验收步骤');
    }
    expect(out!.userQuestions).toEqual([]);
    expect(isVetoActive(out!)).toBe(true);
  });

  it('veto reason is capped at 240 chars', () => {
    const long = `${VETO_BOLD.split('### **User questions**')[0]}${'很'.repeat(400)}`;
    const withLongReason = `${long}\n### **User questions**\nnone\n\n### **Representation notes**\nn`;
    const out = parsePersonSeatOutput(withLongReason);
    expect(out!.veto.active).toBe(true);
    if (out!.veto.active) expect(out!.veto.reason.length).toBeLessThanOrEqual(240);
  });

  it('field = x form is recognized as contractField', () => {
    const text = VETO_BOLD.replace('来源: explicit.acceptance', 'field=baseline');
    const out = parsePersonSeatOutput(text);
    if (out!.veto.active) expect(out!.veto.contractField).toBe('baseline');
  });

  it('uses the LAST Intent heading when repeated', () => {
    const doubled = `${IDEAL}\n\n## Intent\n- explicit: 最终确认的版本\n- inferred: none\n- unknown: none`;
    const out = parsePersonSeatOutput(doubled);
    expect(out!.intent.explicit).toBe('最终确认的版本');
  });

  it('no bullets in questions → whole paragraph as one question', () => {
    const text = IDEAL.replace('- 验收标准是行为还是截图？\n- 需要兼容旧调用方吗？', '需要兼容旧调用方吗');
    const out = parsePersonSeatOutput(text);
    expect(out!.userQuestions).toEqual(['需要兼容旧调用方吗']);
  });

  it('any missing heading fails closed to null (never a veto)', () => {
    expect(parsePersonSeatOutput(IDEAL.replace(/### Representation notes[\s\S]*$/, ''))).toBeNull();
    expect(parsePersonSeatOutput(IDEAL.replace(/### Veto[\s\S]*?### User questions/, '### User questions'))).toBeNull();
    expect(parsePersonSeatOutput('随便一段输出，没有标题')).toBeNull();
  });

  it('empty / none question blocks yield []', () => {
    for (const marker of ['none', 'Empty', '']) {
      const text = IDEAL.replace(
        '- 验收标准是行为还是截图？\n- 需要兼容旧调用方吗？',
        marker,
      );
      expect(parsePersonSeatOutput(text)!.userQuestions).toEqual([]);
    }
  });
});
