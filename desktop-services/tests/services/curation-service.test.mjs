import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createFileMemento } from '../../src/learning/file-memento.mjs';
import { createCurationService } from '../../src/learning/curation-service.mjs';

test('quality scan reuses graph+usage signals and persists L5 scan state', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'curation-service-'));
  const memento = createFileMemento({ storageRoot: root });
  const graph = {
    success: true,
    nodes: [
      { id: 'deploy-api', label: 'Deploy API', kind: 'skill', category: 'devops' },
      { id: 'deploy-app', label: 'Deploy App', kind: 'skill', category: 'devops' },
    ],
    edges: [], clusters: [], stats: {},
    usageReport: {
      'deploy-api': { usedCount: 3 },
      'deploy-app': { usedCount: 2 },
    },
    frontmatter: {}, verdicts: {},
  };
  const service = createCurationService({
    storageRoot: root,
    capabilitiesDir: root,
    memento,
    runAdapter: async () => graph,
  });
  const result = await service.qualityScan();
  assert.equal(result.ok, true);
  assert.equal(result.signals, 2);
  const persisted = memento.get('tryloCode.learning.state');
  assert.ok(persisted.skillQuality);
  assert.ok(persisted.skillQuality.lastScanAt > 0);
});

test('graph summary passes through the safe Python DTO', async () => {
  const graph = { success: true, nodes: [], edges: [], clusters: [], stats: { memoryNodeCount: 2 } };
  const service = createCurationService({
    storageRoot: 'x', capabilitiesDir: 'x',
    memento: { get: () => undefined, update: async () => {} },
    runAdapter: async () => graph,
  });
  assert.deepEqual(await service.graphSummary(), { ok: true, graph });
});
