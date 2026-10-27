import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemberInspector } from './MemberInspector';
import { blankCustomDraft } from './composer-store';
import type { TeamMemberSpec } from '../team-profile-types';

const placeholder = '逗号分隔的技能名；空 = 不加载技能';
const draft = blankCustomDraft('work');
const worker = (id: string, skills: readonly string[]): TeamMemberSpec => ({
  memberId: id, baseRole: 'worker', displayName: id,
  overlay: { model: 'inherit', skills, systemPromptOverlay: '' },
});

describe('member skill configuration', () => {
  it('shows frozen selections and preserves them when an untouched field loses focus', () => {
    const onPatchOverlay = vi.fn();
    render(<MemberInspector draft={draft} member={worker('writer', ['documents', 'pdf'])}
      modelChoices={[]} onRename={vi.fn()} onPatchOverlay={onPatchOverlay} />);
    const field = screen.getByPlaceholderText(placeholder) as HTMLInputElement;
    expect(field.value).toBe('documents, pdf');
    fireEvent.blur(field);
    expect(onPatchOverlay).toHaveBeenCalledWith('writer', { skills: ['documents', 'pdf'] });
  });

  it('keeps each selected member separate and applies edits to that member only', () => {
    const onPatchOverlay = vi.fn();
    const props = { draft, modelChoices: [], onRename: vi.fn(), onPatchOverlay };
    const view = render(<MemberInspector {...props} member={worker('first', ['documents'])} />);
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value: 'pdf， spreadsheets' } });
    fireEvent.blur(screen.getByPlaceholderText(placeholder));
    expect(onPatchOverlay).toHaveBeenLastCalledWith('first', { skills: ['pdf', 'spreadsheets'] });
    view.rerender(<MemberInspector {...props} member={worker('second', ['slides'])} />);
    const field = screen.getByPlaceholderText(placeholder) as HTMLInputElement;
    expect(field.value).toBe('slides');
    fireEvent.blur(field);
    expect(onPatchOverlay).toHaveBeenLastCalledWith('second', { skills: ['slides'] });
    view.rerender(<MemberInspector {...props} member={worker('first', ['pdf', 'spreadsheets'])} />);
    expect((screen.getByPlaceholderText(placeholder) as HTMLInputElement).value).toBe('pdf, spreadsheets');
  });
});
