import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CentralLearningSettings } from './CentralLearningSettings'
import type { CentralRuntimeState } from '../../agent-learning/central-runtime'

const status = vi.hoisted(() => ({ value: undefined as CentralRuntimeState | undefined }))
vi.mock('./CentralRuntimeStatus', async () => {
  const { useEffect, useRef } = await import('react')
  return {
    CentralRuntimeStatus: (props: { readonly onState?: (state: CentralRuntimeState) => void }) => {
      const onState = useRef(props.onState),
        state = status.value
      onState.current = props.onState
      useEffect(() => {
        if (state) onState.current?.(state)
      }, [state])
      return <p>运行状态由原CLI读取</p>
    },
  }
})
beforeEach(() => {
  status.value = undefined
})
afterEach(cleanup)

it('shows independent cumulative and thought defaults while keeping first activation explicit', () => {
  const changed = vi.fn(),
    thought = vi.fn()
  render(<CentralLearningSettings value={undefined} onChange={changed} onThoughtEdit={thought} />)
  expect(screen.getByLabelText('首次启用 token 累计授权')).toHaveValue(160000)
  expect(screen.getByLabelText('首次启用模型调用授权')).toHaveValue(16)
  expect(screen.getByLabelText('中央单次思考 token 包络')).toHaveValue(64000)
  expect(screen.getByLabelText('启用中央学习系统（测试功能）')).not.toBeChecked()
  expect(changed).not.toHaveBeenCalled()
  fireEvent.click(screen.getByLabelText('启用中央学习系统（测试功能）'))
  expect(changed).toHaveBeenLastCalledWith(
    expect.objectContaining({
      centralEnabled: true,
      centralTokens: 160000,
      centralCalls: 16,
      centralThoughtMaxTokens: 64000,
    }),
  )
  expect(thought).not.toHaveBeenCalled()
})

it('keeps legacy authorization and only marks a deliberate thought edit for configuration handoff', () => {
  const changed = vi.fn(),
    thought = vi.fn()
  render(
    <CentralLearningSettings
      value={{
        enabled: false,
        skillTokens: 32000,
        skillCalls: 4,
        skillOutputTokens: 8000,
        centralEnabled: false,
        centralTokens: 32000,
        centralCalls: 4,
      }}
      onChange={changed}
      onThoughtEdit={thought}
    />,
  )
  const field = screen.getByLabelText('中央单次思考 token 包络')
  expect(field).toHaveValue(null)
  fireEvent.change(field, { target: { value: '64000' } })
  expect(changed).toHaveBeenLastCalledWith(
    expect.objectContaining({
      centralEnabled: false,
      centralTokens: 32000,
      centralCalls: 4,
      centralThoughtMaxTokens: 64000,
    }),
  )
  expect(thought).toHaveBeenCalledTimes(1)
  fireEvent.change(field, { target: { value: '' } })
  expect(changed.mock.calls.at(-1)?.[0]).not.toHaveProperty('centralThoughtMaxTokens')
  expect(screen.getByText(/单次思考包络包含完整输入与输出/)).toBeInTheDocument()
})

it('reads an existing owner envelope into the draft without turning new defaults into authority', () => {
  status.value = {
    enabled: false,
    configuration: {
      providerId: 'saved',
      model: 'saved',
      endpointHash: 'saved',
      userLearning: false,
      allowance: { maxTokens: 32000 },
    },
  }
  const changed = vi.fn(),
    edited = vi.fn()
  render(<CentralLearningSettings value={undefined} onChange={changed} onThoughtEdit={edited} />)
  expect(screen.getByLabelText('中央单次思考 token 包络')).toHaveValue(32000)
  expect(changed).not.toHaveBeenCalled()
  expect(edited).not.toHaveBeenCalled()
  fireEvent.blur(screen.getByLabelText('中央单次思考 token 包络'))
  expect(screen.getByLabelText('中央单次思考 token 包络')).toHaveValue(32000)
  fireEvent.change(screen.getByLabelText('中央单次思考 token 包络'), { target: { value: '0' } })
  fireEvent.blur(screen.getByLabelText('中央单次思考 token 包络'))
  expect(screen.getByLabelText('中央单次思考 token 包络')).toHaveValue(32000)
  expect(changed).not.toHaveBeenCalled()
  expect(edited).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('中央单次思考 token 包络'), { target: { value: '64000' } })
  expect(edited).toHaveBeenCalledOnce()
  expect(changed).toHaveBeenLastCalledWith(
    expect.objectContaining({ centralThoughtMaxTokens: 64000, centralEnabled: false }),
  )
})
