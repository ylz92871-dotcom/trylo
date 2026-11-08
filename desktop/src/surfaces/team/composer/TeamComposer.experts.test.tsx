import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExpertLibraryClient } from '../../../experts'
import { TeamComposer } from './TeamComposer'
import { blankCustomDraft } from './composer-store'

vi.mock('../../../experts', () => ({
  ExpertSelector: ({
    onSelect,
    disabled,
    targetRole,
  }: {
    onSelect: (value: unknown) => void
    disabled: boolean
    targetRole: string
  }) => (
    <button
      disabled={disabled}
      data-target-role={targetRole}
      onClick={() =>
        onSelect({
          expertId: targetRole === 'person' ? 'representation-expert' : 'finance-expert',
          version: 3,
          experienceKey: 'specialist-experience',
        })
      }
    >
      选择样本专家
    </button>
  ),
}))
afterEach(cleanup)
it('stores only a stable expert selection on the selected member for the next real dispatch', () => {
  const base = blankCustomDraft('code'),
    member = {
      ...base.members[1]!,
      overlay: {
        ...base.members[1]!.overlay,
        tools: [],
        skills: ['docs'],
        model: 'chosen-model',
        systemPromptOverlay: '保留已明确的用户约束',
      },
    },
    onChange = vi.fn()
  render(
    <TeamComposer
      draft={{ ...base, members: [base.members[0]!, member], selectedMemberId: member.memberId }}
      modelChoices={[]}
      composerLive
      allowNoWorker={false}
      canOverwriteSaved={false}
      expertClient={{} as ExpertLibraryClient}
      onChange={onChange}
      onStart={vi.fn()}
      onSaveAs={vi.fn()}
      onBackToIdle={vi.fn()}
    />,
  )
  expect(
    screen.getByRole('button', { name: '选择样本专家' }).getAttribute('data-target-role'),
  ).toBe('worker')
  fireEvent.click(screen.getByRole('button', { name: '选择样本专家' }))
  const changed = onChange.mock.calls[0]?.[0]
  expect(changed.members[1].overlay).toEqual({
    ...member.overlay,
    expert: { expertId: 'finance-expert', version: 3 },
  })
  expect(changed.members[0]).toEqual(base.members[0])
  expect(JSON.stringify(changed)).not.toContain('experienceKey')
  expect(JSON.stringify(changed)).not.toContain('adopted')
})

it('offers same-role specialist selection to Person while retaining its representation seat', () => {
  const draft = blankCustomDraft('code'),
    person = draft.members[0]!,
    onChange = vi.fn()
  render(
    <TeamComposer
      draft={{ ...draft, selectedMemberId: person.memberId }}
      modelChoices={[]}
      composerLive
      allowNoWorker={false}
      canOverwriteSaved={false}
      expertClient={{} as ExpertLibraryClient}
      onChange={onChange}
      onStart={vi.fn()}
      onSaveAs={vi.fn()}
      onBackToIdle={vi.fn()}
    />,
  )
  const button = screen.getByRole('button', { name: '选择样本专家' })
  expect(button.getAttribute('data-target-role')).toBe('person')
  fireEvent.click(button)
  const changed = onChange.mock.calls[0]?.[0]
  expect(changed.members[0]).toEqual({
    ...person,
    overlay: { ...person.overlay, expert: { expertId: 'representation-expert', version: 3 } },
  })
  expect(changed.members[1]).toEqual(draft.members[1])
})
