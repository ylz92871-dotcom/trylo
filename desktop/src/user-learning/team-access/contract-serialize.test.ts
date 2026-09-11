// EngineeringContract serialization tests (PR-1, vitest side).
//
// The CLI copy (the Trylo CLI's team-roster 
// engineering-contract.test.ts`) runs the same scenarios under bun:test
// against its own module copy — desktop must not import CLI sources.

import { describe, expect, it } from 'vitest';
import {
  CONTRACT_TAG,
  type EngineeringContract,
} from './contract-types';
import {
  extractContractFromPrompt,
  parseContractJson,
  serializeContract,
} from './contract-serialize';

function fixtureContract(): EngineeringContract {
  return {
    schemaVersion: 1,
    contractId: 'ec_test_1',
    version: 1,
    product: 'code',
    workspaceId: 'ws:abc',
    projectId: 'proj:x:1234',
    personConversationId: 'conv-1',
    task: {
      title: '实现最小抽象',
      goal: '给导出函数补一个稳定入口',
      oneLiner: '给导出函数补一个稳定入口，不扩散改动',
    },
    authority: {
      explicit: [
        { id: 'cl_1', authority: 'explicit', text: '不要改动数据库 schema。', field: 'prohibited' },
      ],
      inferred: [
        {
          id: 'cl_2',
          authority: 'inferred',
          text: '保留轻量扩展点',
          field: 'architecture',
          confidence: 0.76,
          uncertainty: 'medium',
          sourceUserModelIds: ['um_1'],
        },
      ],
      baseline: [
        {
          id: 'cl_3',
          authority: 'baseline',
          text: '个性化不得降低安全、数据完整性或不可逆操作的工程底线。',
          field: 'security',
        },
      ],
      recommendation: [],
    },
    provenance: {
      compiledAt: 1700000000000,
      compiler: 'deterministic_fallback',
      userModelIds: ['um_1'],
      preferenceStubUsed: false,
      sourceHash: 'fnv1a:00000000',
    },
  };
}

describe('contract-serialize', () => {
  it('serializes as JSON and parses back', () => {
    const c = fixtureContract();
    const text = serializeContract(c);
    expect(JSON.parse(text)).toBeTruthy();
    const parsed = parseContractJson(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.contractId).toBe('ec_test_1');
    expect(parsed!.authority.baseline.length).toBe(1);
    expect(parsed!.authority.inferred[0]!.confidence).toBe(0.76);
  });

  it('round-trips through the prompt wrapper', () => {
    const c = fixtureContract();
    const prompt = `<trylo_team_access>\n<${CONTRACT_TAG}>\n${serializeContract(c)}\n</${CONTRACT_TAG}>\n</trylo_team_access>`;
    const extracted = extractContractFromPrompt(prompt);
    expect(extracted).not.toBeNull();
    expect(extracted!.contractId).toBe(c.contractId);
  });

  it('malformed JSON fails closed to null, not an empty object', () => {
    expect(parseContractJson('{not json')).toBeNull();
    expect(extractContractFromPrompt(`<${CONTRACT_TAG}>oops</${CONTRACT_TAG}>`)).toBeNull();
  });

  it('missing wrapper yields null', () => {
    expect(extractContractFromPrompt('no contract here')).toBeNull();
    expect(extractContractFromPrompt(`<${CONTRACT_TAG}>unterminated`)).toBeNull();
  });

  it('rejects wrong schemaVersion and empty baseline', () => {
    const wrongVersion = JSON.parse(serializeContract(fixtureContract()));
    wrongVersion.schemaVersion = 999;
    expect(parseContractJson(JSON.stringify(wrongVersion))).toBeNull();

    const emptyBaseline = JSON.parse(serializeContract(fixtureContract()));
    emptyBaseline.authority.baseline = [];
    expect(parseContractJson(JSON.stringify(emptyBaseline))).toBeNull();
  });

  it('contract with no inferred clauses stays legal', () => {
    const c = fixtureContract();
    const bare = {
      ...c,
      authority: { ...c.authority, inferred: [] },
    } as EngineeringContract;
    const parsed = parseContractJson(serializeContract(bare));
    expect(parsed).not.toBeNull();
    expect(parsed!.authority.inferred).toEqual([]);
  });
});
