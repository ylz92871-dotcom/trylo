import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ExpertIdentity,
  ExpertBaseRole,
  ExpertVersion,
} from '../../../new trylo cli/src/internal/subagent/experts/contracts'
import type { ExpertLibraryClient } from './client'
import { EXPERT_ROLE_LABELS } from './presentation'
import './experts.css'

/** Selection carries stable authority references. The host must resolve them at its next dispatch boundary. */
export function ExpertSelector({
  client,
  onSelect,
  selected,
  disabled = false,
  targetRole,
}: {
  readonly client: ExpertLibraryClient
  readonly onSelect: (identity: ExpertIdentity) => void
  readonly selected?: readonly Pick<ExpertIdentity, 'expertId' | 'version'>[]
  readonly disabled?: boolean
  readonly targetRole?: ExpertBaseRole
}) {
  const [text, setText] = useState('')
  const [experts, setExperts] = useState<readonly ExpertVersion[]>([])
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<AbortController | null>(null)
  const query = useCallback(
    async (queryText: string) => {
      pending.current?.abort()
      const controller = new AbortController()
      pending.current = controller
      setPhase('loading')
      setError(null)
      try {
        const result = await client.query(queryText, controller.signal)
        if (!controller.signal.aborted) {
          setExperts(result)
          setPhase('ready')
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : '专家查询未完成')
          setPhase('error')
        }
      }
    },
    [client],
  )
  useEffect(() => {
    void query('')
    return () => pending.current?.abort()
  }, [query])
  return (
    <section
      className="expert-selector"
      aria-label="为团队选用专家"
      aria-busy={phase === 'loading'}
    >
      <h3>选用已有专家</h3>
      <p className="expert-library__hint">在下一次组队或交接后的派发中采用所选版本。</p>
      <form
        className="expert-library__search"
        onSubmit={(event) => {
          event.preventDefault()
          void query(text)
        }}
      >
        <label>
          <span>查询专家专长</span>
          <input
            type="search"
            value={text}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            placeholder="当前任务需要哪方面的能力？"
          />
        </label>
        <button type="submit" className="expert-button" disabled={disabled || phase === 'loading'}>
          查询
        </button>
      </form>
      {phase === 'loading' && <p role="status">正在查找专家…</p>}
      {error !== null && (
        <p role="alert">
          {error}
          <button
            type="button"
            className="expert-button"
            onClick={() => {
              void query(text)
            }}
          >
            重试
          </button>
        </p>
      )}
      {phase === 'ready' && experts.length === 0 && (
        <p className="expert-library__empty">
          没有匹配的已保存专家。可调整查询，或在设置中创建专项专家。
        </p>
      )}
      <ul className="expert-selector__list">
        {experts.map((expert) => {
          const incompatible =
            targetRole !== undefined && expert.configuration.baseRole !== targetRole
          const isSelected =
            selected?.some(
              (item) => item.expertId === expert.expertId && item.version === expert.version,
            ) ?? false
          return (
            <li key={expert.expertId}>
              <div>
                <strong>{expert.configuration.displayName}</strong>
                <span>{expert.configuration.specialty}</span>
                <small>
                  {EXPERT_ROLE_LABELS[expert.configuration.baseRole]} · v{expert.version} ·{' '}
                  {expert.configuration.situations.join('、')}
                </small>
                {incompatible && (
                  <small>基础席位不相容，请选择{EXPERT_ROLE_LABELS[targetRole]}专家</small>
                )}
              </div>
              <button
                type="button"
                className="expert-button"
                disabled={disabled || phase !== 'ready' || isSelected || incompatible}
                aria-label={`选用 ${expert.configuration.displayName}`}
                onClick={() => {
                  if (incompatible) return
                  onSelect({
                    expertId: expert.expertId,
                    version: expert.version,
                    experienceKey: expert.experienceKey,
                  })
                }}
              >
                {isSelected ? '已选用' : incompatible ? '席位不相容' : '选用'}
              </button>
            </li>
          )
        })}
      </ul>
      <p className="expert-library__hint">工具将在派发时解析并检查权限</p>
    </section>
  )
}
