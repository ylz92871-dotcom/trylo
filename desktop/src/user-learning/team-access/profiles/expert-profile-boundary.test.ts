import { expect, it } from 'vitest'
import { sanitizeOverlay } from './profile-validate'
import { renderMemberOverlayFallbackTags } from '../render-team-access'
import { parseTeamProfilesFile } from './profile-io'
import { freezeProfile, serializeFrozenProfile } from './launch'

it('preserves an explicit empty tool allowlist instead of restoring the role tool range', () => {
  expect(sanitizeOverlay({ tools: [], systemPromptOverlay: '' }).tools).toEqual([])
  expect(sanitizeOverlay({ systemPromptOverlay: '' }).tools).toBeUndefined()
})
it('preserves the complete validated overlay in the file-write fallback', () => {
  const prompt = `${'原始约束。'.repeat(150)}最后一条约束不得遗漏。`
  const rendered = renderMemberOverlayFallbackTags({
    id: 'profile-a',
    members: [
      {
        memberId: 'worker-a',
        baseRole: 'worker',
        displayName: '成员A',
        overlay: { model: 'inherit', skills: [], systemPromptOverlay: prompt, tools: [] },
      },
    ],
  })
  expect(rendered).toContain(JSON.stringify(prompt))
  expect(rendered).toContain('"tools":[]')
})
it('keeps the canonical expert selection reference through saved profiles and the fallback channel', () => {
  const expert = { expertId: 'expert-finance', version: 3 }
  const parsed = parseTeamProfilesFile(
    JSON.stringify({
      schemaVersion: 1,
      workspaceId: 'workspace-a',
      profiles: [
        {
          id: 'profile-a',
          surface: 'code',
          title: '专项团队',
          members: [
            {
              memberId: 'worker-a',
              baseRole: 'worker',
              displayName: '成员A',
              overlay: { model: 'inherit', skills: [], systemPromptOverlay: '', expert },
            },
          ],
        },
      ],
    }),
  )
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) return
  expect(parsed.profiles[0]?.members[0]?.overlay).toMatchObject({ expert })
  const frozen = freezeProfile(parsed.profiles[0]!)
  expect(frozen.members[0]?.overlay).toMatchObject({ expert })
  expect(serializeFrozenProfile(frozen)).toContain('"expertId": "expert-finance"')
  const rendered = renderMemberOverlayFallbackTags(frozen)
  expect(rendered).toContain('"expert":{"expertId":"expert-finance","version":3}')
})
