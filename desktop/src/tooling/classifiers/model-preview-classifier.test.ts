import { describe, expect, it } from 'vitest';
import { createToolRiskClassifier } from '../tool-risk-classifier';
import { modelPreviewClassifier, MODEL_PREVIEW_TOOLS } from './model-preview-classifier';

describe('built-in model observation permissions', () => {
  for (const permissionLevel of ['read_only', 'ask', 'workspace_write', 'unrestricted'] as const) {
    it(`${permissionLevel} permits scoped scene observation without granting writes`, () => {
      const router = createToolRiskClassifier([modelPreviewClassifier]);
      for (const tool of MODEL_PREVIEW_TOOLS) expect(router.classify({
        toolName: `mcp__trylo-preview__${tool}`, input: tool === 'preview_open' ? { path: '.trylo/out/model.glb' } : {},
        permissionLevel, projectRoot: 'D:/project', conversationId: 'chat', profileId: 'work.office.v1', managedPackageIds: ['model-preview'],
      })).toMatchObject({ behavior: 'auto_allow', risk: 'read' });
    });
  }
  it('keeps traversal, external roots, disabled profiles and unknown tools out of automatic approval', () => {
    const router = createToolRiskClassifier([modelPreviewClassifier]);
    const request = { toolName: 'mcp__trylo-preview__preview_open', input: {}, permissionLevel: 'unrestricted' as const,
      projectRoot: 'D:/project', conversationId: 'chat', profileId: 'code.core.v1', managedPackageIds: ['model-preview'] };
    for (const path of ['../private/model.glb', 'D:/project-other/model.glb', 'E:/outside/model.glb']) {
      expect(router.classify({ ...request, input: { path } })).toMatchObject({ behavior: 'deny' });
    }
    expect(router.classify({ ...request, input: { path: 'model.glb' }, managedPackageIds: [] })).toEqual({ behavior: 'unmanaged' });
    expect(router.classify({ ...request, toolName: 'mcp__trylo-preview__execute_code' })).toMatchObject({ behavior: 'deny', reasonCode: 'unknown_tool' });
  });
});
