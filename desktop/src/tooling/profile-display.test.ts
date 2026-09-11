// Trylo Desktop — profile-display test. Pins every known profile id so a
// composition change in tool-profile-service.mjs fails loudly here until
// the display mirror is updated alongside it.

import { describe, expect, it } from 'vitest'
import { ALWAYS_MOUNTED_SERVER, describeToolProfile } from './profile-display'

describe('describeToolProfile', () => {
  it('labels the default Work profile (office + browser + desktop control)', () => {
    const d = describeToolProfile('work.core.v1')
    expect(d.label).toBe('办公')
    expect(d.servers).toEqual(['trylo-office', 'trylo-browser', 'trylo-windows'])
  })

  it('labels the CAD profile with all adapters + desktop control + office', () => {
    const d = describeToolProfile('work.cad.v1')
    expect(d.label).toBe('CAD')
    expect(d.servers).toContain('trylo-office')
    expect(d.servers).toContain('trylo-windows')
    expect(d.servers).toContain('trylo-solidworks')
    expect(d.servers).toHaveLength(8)
  })

  it('labels the browser-debug profile; retired computer id falls back to base', () => {
    expect(describeToolProfile('work.browser-debug.v1').label).toBe('浏览器调试')
    expect(describeToolProfile('work.browser-debug.v1').servers).toContain('trylo-chrome')
    // work.computer.v1 was merged into the base (rev 2): old ids resolve
    // to the base display, which now carries desktop control.
    expect(describeToolProfile('work.computer.v1').profileId).toBe('work.core.v1')
    expect(describeToolProfile('work.computer.v1').servers).toContain('trylo-windows')
  })

  it('falls back to the default profile for unknown/empty ids (never blank)', () => {
    expect(describeToolProfile(null).profileId).toBe('work.core.v1')
    expect(describeToolProfile(undefined).profileId).toBe('work.core.v1')
    expect(describeToolProfile('').profileId).toBe('work.core.v1')
    expect(describeToolProfile('work.future.v9').profileId).toBe('work.core.v1')
  })

  it('names the always-mounted Hermes adapter for the popover footer', () => {
    expect(ALWAYS_MOUNTED_SERVER).toBe('trylo-hermes-capabilities')
  })
})
