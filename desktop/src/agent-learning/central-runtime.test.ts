import { describe, expect, it } from 'vitest'
import { parseCentralRuntimeState } from './central-runtime'

describe('actual central workspace runtime state', () => {
  it('distinguishes saved activation, stopped intent and a live independent owner', () => {
    const base = { schemaVersion: 1, domain: 'central_runtime', ok: true }
    expect(parseCentralRuntimeState(JSON.stringify({ ...base, enabled: false }))).toEqual({
      enabled: false,
    })
    expect(parseCentralRuntimeState(JSON.stringify({ ...base, enabled: true }))).toEqual({
      enabled: true,
    })
    expect(
      parseCentralRuntimeState(
        JSON.stringify({
          ...base,
          enabled: true,
          owner: {
            ownerId: 'scope-owner',
            state: 'running',
            revision: 3,
            progress: { message: 'original domain is working' },
          },
        }),
      ).owner?.state,
    ).toBe('running')
  })
  it('keeps command rejection explicit instead of treating failed stop as disabled', () => {
    expect(() =>
      parseCentralRuntimeState(
        JSON.stringify({
          schemaVersion: 1,
          domain: 'central_runtime',
          ok: false,
          reason: 'runtime_owner_busy',
        }),
      ),
    ).toThrow('runtime_owner_busy')
    expect(() =>
      parseCentralRuntimeState(
        JSON.stringify({
          schemaVersion: 1,
          domain: 'central_runtime',
          ok: true,
          enabled: false,
          owner: { ownerId: 'scope-owner', state: 'completed', revision: 1 },
        }),
      ),
    ).toThrow('central_runtime_reply_invalid')
  })
  it('exposes the actual saved background connection and User switch independently of UI defaults', () => {
    const value = parseCentralRuntimeState(
      JSON.stringify({
        schemaVersion: 1,
        domain: 'central_runtime',
        ok: true,
        enabled: true,
        configuration: {
          schemaVersion: 1,
          providerId: 'named-provider',
          model: 'actual-background-model',
          endpointHash: 'reference-hash',
          accountId: 'original-account',
          userLearning: false,
        },
      }),
    )
    expect(value.configuration).toEqual({
      providerId: 'named-provider',
      model: 'actual-background-model',
      endpointHash: 'reference-hash',
      accountId: 'original-account',
      userLearning: false,
    })
    const saved = parseCentralRuntimeState(
      JSON.stringify({
        schemaVersion: 1,
        domain: 'central_runtime',
        ok: true,
        enabled: false,
        configuration: {
          schemaVersion: 1,
          providerId: 'named-provider',
          model: 'actual-background-model',
          endpointHash: 'reference-hash',
          userLearning: false,
          thoughtMaxTokens: 64000,
          allowance: { maxTokens: 160000 },
        },
      }),
    )
    expect(saved.configuration?.thoughtMaxTokens).toBe(64000)
    expect(saved.configuration?.allowance?.maxTokens).toBe(160000)
  })
  it('distinguishes an owned control plane from semantic initialization', () => {
    const value = parseCentralRuntimeState(
      JSON.stringify({
        schemaVersion: 1,
        domain: 'central_runtime',
        ok: true,
        enabled: true,
        owner: {
          ownerId: 'scope-owner',
          revision: 1,
          state: 'running',
          progress: { message: 'Loading semantic host', phase: 'initializing' },
        },
      }),
    )
    expect(value.owner?.progress?.phase).toBe('initializing')
  })
})
