// Overlay attenuation preview tests (Foundation spec §7.4 / §11.3).
// These lock the ONLY-ATTENUATE guarantee the CLI merge must match.

import { describe, expect, it } from 'vitest';
import { applyMemberOverlayPreview } from './overlay-merge';
import { emptyMemberOverlay, type TeamMemberSpec } from './profile-types';

function merge(baseRole: TeamMemberSpec['baseRole'], overlay: Partial<TeamMemberSpec['overlay']> = {}) {
  return applyMemberOverlayPreview({
    memberId: 'm-1',
    baseRole,
    overlay: { ...emptyMemberOverlay(), ...overlay },
  });
}

describe('applyMemberOverlayPreview', () => {
  it('default overlay = full floor, inherit model, no skills (Skill tool dropped for worker)', () => {
    const worker = merge('worker');
    expect(worker.resolvedModel).toBe('inherit');
    expect(worker.writes).toBe(true);
    expect(worker.toolsApplied).toContain('Write');
    expect(worker.toolsApplied).not.toContain('Skill'); // empty skills ⇒ drop Skill tool
    expect(worker.toolsApplied).not.toContain('Agent');
    expect(worker.skills).toEqual([]);
  });

  it('read-only roles never get write/spawn tools and drop ALL skills (fail closed)', () => {
    const reviewer = merge('reviewer', {
      tools: ['Read', 'Write', 'Agent'],
      skills: ['repo-writer'],
    });
    expect(reviewer.toolsApplied).toEqual(['Read']);
    expect(reviewer.disallowed).toContain('Agent');
    expect(reviewer.disallowed).toContain('ExitPlanMode');
    expect(reviewer.disallowed).toContain('Write');
    expect(reviewer.skills).toEqual([]);
    expect(reviewer.skillsDropped).toEqual(['repo-writer']);
    expect(reviewer.writes).toBe(false);
    expect(reviewer.independence).toBe('review');
  });

  it('overlay tools outside floor ∪ allowlist are silently dropped (worker extra = research)', () => {
    const worker = merge('worker', { tools: ['Read', 'WebFetch', 'WebSearch', 'Agent'] });
    expect(worker.toolsApplied).toContain('WebFetch');
    expect(worker.toolsApplied).toContain('WebSearch');
    expect(worker.toolsApplied).not.toContain('Agent');

    // Reviewer has NO allowlist extras — research cannot be added.
    const reviewer = merge('reviewer', { tools: ['Read', 'WebFetch'] });
    expect(reviewer.toolsApplied).toEqual(['Read']);
  });

  it('worker may drop write tools (read-only executor) but canSpawn stays false', () => {
    const worker = merge('worker', { tools: ['Read', 'Grep'], disallowedTools: ['Write', 'Edit', 'NotebookEdit'] });
    expect(worker.toolsApplied).not.toContain('Write');
    expect(worker.canSpawn).toBe(false);
    expect(worker.disallowed).toContain('Agent');
  });

  it('overlay prompt is capped at 2000 chars and hashed', () => {
    const merged = merge('worker', { systemPromptOverlay: 'x'.repeat(2500) });
    expect(merged.systemPromptOverlay).toHaveLength(2000);
    expect(merged.overlayHash).toBeTruthy();
  });

  it('independence / writes / canSpawn are copied from the floor, never from overlay', () => {
    expect(merge('verifier').independence).toBe('verify');
    expect(merge('verifier').writes).toBe(false);
    expect(merge('person').independence).toBe('none');
    expect(merge('worker').canSpawn).toBe(false);
  });

  it('two workers with different overlays produce different previews (Pitfall 11)', () => {
    const a = applyMemberOverlayPreview({
      memberId: 'a',
      baseRole: 'worker',
      overlay: { ...emptyMemberOverlay(), systemPromptOverlay: '写代码' },
    });
    const b = applyMemberOverlayPreview({
      memberId: 'b',
      baseRole: 'worker',
      overlay: { ...emptyMemberOverlay(), systemPromptOverlay: '写文档' },
    });
    expect(a.systemPromptOverlay).not.toBe(b.systemPromptOverlay);
    expect(a.overlayHash).not.toBe(b.overlayHash);
  });
});
