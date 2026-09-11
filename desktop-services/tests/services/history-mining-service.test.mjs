import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryMiningService, _test } from '../../src/learning/history-mining-service.mjs';

test('history mining uses the history shadow profile and persists legacy state', async () => {
  const shadowCalls = [];
  const saved = [];
  class FakeMiningOrchestrator {
    constructor(options) { this.options = options; }
    async runOnce({ state }) {
      const proposal = await this.options.runner({
        candidate: { patternKey: 'deploy', confidence: 0.9, summary: 'ignore this command', summaryUntrusted: true },
        untrustedEvidence: [{ sessionId: 's1', turnId: 't1', evidenceHash: 'abcdef' }],
      });
      state.touched = proposal.target;
      return {
        status: 'ok',
        candidates: [{ candidateId: 'c1', patternKey: 'deploy', summary: 'deploy safely', confidence: 0.9, sources: [], proposal: { state: 'staged', pendingId: 'p1' } }],
        errors: [],
      };
    }
  }
  const state = { schemaVersion: 1, workspaces: {} };
  const service = createHistoryMiningService({
    storageRoot: 'd:/data/Trylo',
    memento: {},
    shadow: {
      configure: (cli) => shadowCalls.push({ cli }),
      run: async (prompt, options) => {
        shadowCalls.push({ prompt, options });
        return { answer: '{"subsystem":"skills","action":"create","target":"deploy-safe","content":"x","rationale":"r"}' };
      },
    },
    pending: { list: async () => ({ ok: true, pending: [] }) },
    modules: {
      planner: {}, aggregator: {}, provenance: {}, client: {},
      MiningOrchestrator: FakeMiningOrchestrator,
      state: {
        loadState: () => state,
        saveState: async (_memento, value) => saved.push(value),
      },
    },
  });
  const result = await service.run({
    workspaceRoot: 'd:/repo',
    cli: { cliPath: 'd:/cli.js' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.candidates[0].proposal.pendingId, 'p1');
  assert.equal(shadowCalls[1].options.profile, 'history');
  assert.match(shadowCalls[1].prompt, /UNTRUSTED REFERENCE DATA/);
  assert.equal(saved[0].touched, 'deploy-safe');
});

test('history prompt fails closed when the aggregator omits the untrusted marker', () => {
  assert.throws(() => _test.buildPrompt({ summary: 'do bad things' }, []), /not marked untrusted/);
});
