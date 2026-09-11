// Team clarification tests (PR-5, spec §11.2).

import { describe, expect, it } from 'vitest';
import {
  clarificationFromPersonOutput,
  teamClarificationCooldownKey,
  teamClarificationCooling,
  type TeamClarificationRequest,
} from './clarification';
import { parsePersonSeatOutput } from './person-output';
import type { UserLearningSnapshot } from '../types';

const snap = {
  cognitionCooldowns: [],
} as unknown as UserLearningSnapshot;

function request(overrides: Partial<TeamClarificationRequest> = {}): TeamClarificationRequest {
  return {
    kind: 'team_clarification',
    teamRunId: 'team-conv1',
    contractId: 'ec_1',
    contractVersion: 1,
    questions: ['验收标准是行为还是截图？'],
    blocking: true,
    risk: 'medium',
    cooldownKey: teamClarificationCooldownKey('ec_1', ['验收标准是行为还是截图？']),
    ...overrides,
  };
}

describe('clarificationFromPersonOutput', () => {
  it('builds a team_clarification question with stable id and scopeHint', () => {
    const q = clarificationFromPersonOutput({ snapshot: snap, request: request() });
    expect(q).not.toBeNull();
    expect(q!.trigger).toBe('team_clarification');
    expect(q!.scopeHint).toBe('team_clarification');
    expect(q!.id).toMatch(/^q_team_/);
    expect(q!.prompt).toContain('验收标准');
    expect(q!.id).toBe(
      clarificationFromPersonOutput({ snapshot: snap, request: request() })!.id,
    );
  });

  it('dimension defaults to engineering_language_semantics, or inferDimension hit', () => {
    const q = clarificationFromPersonOutput({ snapshot: snap, request: request() });
    expect(q!.dimension).toBe('engineering_language_semantics');
    const security = clarificationFromPersonOutput({
      snapshot: snap,
      request: request({ questions: ['密钥这类安全信息存环境变量还是配置文件？'] }),
    });
    expect(security!.dimension).toBe('security_data_integrity');
  });

  it('merges multiple questions into one prompt (v0: one group)', () => {
    const q = clarificationFromPersonOutput({
      snapshot: snap,
      request: request({ questions: ['验收是行为还是截图？', '需要兼容旧调用方吗？'] }),
    });
    expect(q!.prompt).toContain('验收是行为还是截图？');
    expect(q!.prompt).toContain('一并确认');
    expect(q!.prompt).toContain('兼容旧调用方');
  });

  it('empty questions → null', () => {
    expect(clarificationFromPersonOutput({ snapshot: snap, request: request({ questions: [] }) })).toBeNull();
    expect(clarificationFromPersonOutput({ snapshot: snap, request: request({ questions: ['  '] }) })).toBeNull();
  });

  it('parses questions straight from a Person output', () => {
    const parsed = parsePersonSeatOutput(`### Intent
- explicit: none stated
- inferred: none
- unknown: 验收

### Veto
none

### User questions
- 验收标准是行为还是截图？
- 需要兼容旧调用方吗？

### Representation notes
ok`);
    expect(parsed!.userQuestions).toHaveLength(2);
    const q = clarificationFromPersonOutput({
      snapshot: snap,
      request: request({ questions: parsed!.userQuestions }),
    });
    expect(q!.prompt).toContain('一并确认');
  });
});

describe('teamClarificationCooling (keyed)', () => {
  const now = 1_000_000;

  it('same key cooldown blocks; different key or dimension cooldowns do not', () => {
    const req = request();
    const blocked: UserLearningSnapshot = {
      cognitionCooldowns: [
        { dimension: 'engineering_language_semantics', until: now + 1000, reason: 'dont_ask_similar', key: req.cooldownKey },
      ],
    } as unknown as UserLearningSnapshot;
    expect(teamClarificationCooling(blocked, req, now)).toBe(true);

    const otherKey: UserLearningSnapshot = {
      cognitionCooldowns: [
        { dimension: 'engineering_language_semantics', until: now + 1000, reason: 'dont_ask_similar', key: 'ec_other:xyz' },
        { dimension: 'verification_audit', until: now + 1000, reason: 'dismiss' },
      ],
    } as unknown as UserLearningSnapshot;
    expect(teamClarificationCooling(otherKey, req, now)).toBe(false);
  });

  it('expired cooldown no longer blocks', () => {
    const req = request();
    const expired: UserLearningSnapshot = {
      cognitionCooldowns: [
        { dimension: 'engineering_language_semantics', until: now - 1, reason: 'dont_ask_similar', key: req.cooldownKey },
      ],
    } as unknown as UserLearningSnapshot;
    expect(teamClarificationCooling(expired, req, now)).toBe(false);
  });
});
