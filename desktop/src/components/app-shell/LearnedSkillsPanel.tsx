import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createSkillLearningPort,
  type SkillLearningPort,
  type SkillLearningRuntime,
  type SkillSummary,
  type SkillUse,
} from '../../skill-learning/cli'
import './learned-skills.css'

const STATUS: Readonly<Record<string, string>> = {
  draft: '待验证',
  quarantined: '待验证',
  evaluating: '验证中',
  shadow: '已验证 · 试用',
  active: '已启用',
  rejected: '已停止',
  suspended: '已暂停',
  retired: '已撤回',
  rolled_back: '已回退',
  withdrawn: '已撤回',
  superseded: '历史版本',
}

export function LearnedSkillsPanel({
  runtime,
  port: provided,
}: {
  readonly runtime?: SkillLearningRuntime
  readonly port?: SkillLearningPort
}) {
  const [trialAuthorized, setTrialAuthorized] = useState(false)
  const port = useMemo(
    () =>
      provided ?? (runtime ? createSkillLearningPort({ ...runtime, trialAuthorized }) : undefined),
    [provided, runtime, trialAuthorized],
  )
  const [skills, setSkills] = useState<readonly SkillSummary[]>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<SkillSummary>(),
    [content, setContent] = useState(''),
    [uses, setUses] = useState<readonly SkillUse[]>([])
  const [busy, setBusy] = useState(''),
    [maxTokens, setMaxTokens] = useState('12000'),
    [maxCalls, setMaxCalls] = useState('12')
  const controller = useRef<AbortController>()
  useEffect(() => {
    const current = new AbortController()
    controller.current = current
    setSkills(undefined)
    setSelected(undefined)
    setContent('')
    setUses([])
    setError('')
    setNotice('')
    if (!port) {
      setError('当前运行环境尚未连接技能学习服务。')
      return () => current.abort()
    }
    setBusy('读取')
    void port
      .list(current.signal)
      .then((result) => {
        if (current.signal.aborted) return
        if (result.ok) setSkills(result.skills)
        else setError(result.reason)
      })
      .catch(() => {
        if (!current.signal.aborted) setError('技能目录暂时无法读取，请刷新重试。')
      })
      .finally(() => {
        if (!current.signal.aborted) setBusy('')
      })
    return () => current.abort()
  }, [port])

  const refresh = async () => {
    if (!port || !controller.current || controller.current.signal.aborted) return
    const signal = controller.current.signal
    setBusy('读取')
    setError('')
    setSelected(undefined)
    setContent('')
    setUses([])
    try {
      const result = await port.list(signal)
      if (signal.aborted) return
      if (result.ok) setSkills(result.skills)
      else setError(result.reason)
    } catch {
      if (!signal.aborted) setError('技能目录暂时无法读取，请刷新重试。')
    } finally {
      if (!signal.aborted) setBusy('')
    }
  }
  const show = async (skill: SkillSummary) => {
    if (!port || !controller.current) return
    const signal = controller.current.signal
    setBusy('详情')
    setError('')
    setSelected(skill)
    setContent('')
    setUses([])
    try {
      const result = await port.show(skill.versionId, signal)
      if (signal.aborted) return
      if (result.ok) {
        setSelected(result.skill)
        setContent(result.content)
        setUses(result.uses)
      } else setError(result.reason)
    } catch {
      if (!signal.aborted) setError('技能详情暂时无法读取。')
    } finally {
      if (!signal.aborted) setBusy('')
    }
  }
  const mutate = async (action: 'learn' | 'withdraw') => {
    if (!port || !controller.current || (action === 'withdraw' && !selected)) return
    const signal = controller.current.signal
    setBusy(action === 'learn' ? '学习' : '撤回')
    setError('')
    setNotice('')
    try {
      if (action === 'learn') {
        const result = await port.learn(
          { maxTokens: Number(maxTokens), maxCalls: Number(maxCalls) },
          signal,
        )
        if (signal.aborted) return
        if (!result.ok) {
          setError(result.reason)
          return
        }
        const cost =
          result.usage.usageStatus === 'missing'
            ? '总 token 用量未知'
            : `实际总用量 ${result.usage.tokens} token`
        setNotice(
          `本轮学习已返回：${STATUS[result.status] ?? result.status}（${result.reason}） · ${result.usage.calls} 次模型调用 · ${cost}`,
        )
      } else {
        const result = await port.withdraw(selected!.versionId, signal)
        if (signal.aborted) return
        if (!result.ok) {
          setError(result.reason)
          return
        }
        setNotice('已撤回。后续任务将不再装载这个版本。')
      }
      await refresh()
    } catch {
      if (!signal.aborted) setError('操作未能确认完成，请刷新后核对记录。')
    } finally {
      if (!signal.aborted) setBusy('')
    }
  }
  const validBudget =
    Number.isSafeInteger(Number(maxTokens)) &&
    Number(maxTokens) > 0 &&
    Number(maxTokens) <= 100000 &&
    Number.isSafeInteger(Number(maxCalls)) &&
    Number(maxCalls) > 0 &&
    Number(maxCalls) <= 16
  const canWithdraw =
    selected && !['rejected', 'retired', 'rolled_back', 'withdrawn'].includes(selected.status)
  return (
    <section className="learned-skills" aria-label="任务技能学习" aria-busy={!!busy}>
      <p className="settings-modal__desc">
        从当前工作区的任务经历学习可复用做法。技能保留适用条件、验证依据和使用反馈。
      </p>
      <p className="settings-modal__hint">
        额度限制本轮累计生成
        token；输入量与调用次数另有限制。实际总用量单独核账，模型服务未报告时显示未知。
      </p>
      <label className="learned-skills__authorization">
        <input
          type="checkbox"
          checked={trialAuthorized}
          disabled={!!busy}
          onChange={(event) => setTrialAuthorized(event.target.checked)}
        />
        授权本轮在隔离目录试用候选技能、写入试验产物并执行检查
      </label>
      <div className="learned-skills__learning">
        <label>
          生成 token 额度
          <input
            type="number"
            min="1"
            max="100000"
            value={maxTokens}
            disabled={!!busy}
            onChange={(event) => setMaxTokens(event.target.value)}
          />
        </label>
        <label>
          模型调用上限
          <input
            type="number"
            min="1"
            max="16"
            value={maxCalls}
            disabled={!!busy}
            onChange={(event) => setMaxCalls(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="settings-modal__btn settings-modal__btn--primary"
          disabled={!port || !!busy || !validBudget}
          onClick={() => void mutate('learn')}
        >
          {busy === '学习' ? '正在学习…' : '学习已有经历'}
        </button>
        <button
          type="button"
          className="settings-modal__btn settings-modal__btn--ghost"
          disabled={!port || !!busy}
          onClick={() => void refresh()}
        >
          刷新
        </button>
      </div>
      {notice && (
        <p role="status" className="settings-modal__hint">
          {notice}
        </p>
      )}
      {error && (
        <div className="skills-modal__error" role="alert">
          <span>技能学习服务未能完成请求：{error}</span>
        </div>
      )}
      {skills === undefined && !error ? (
        <p role="status">正在读取任务技能…</p>
      ) : skills?.length === 0 ? (
        <div className="skills-modal__empty">
          <p>当前工作区还没有学习技能。</p>
          <p>完成可采集的任务后，可在这里启动学习；验证通过的版本会在条件适用的后续任务中试用。</p>
        </div>
      ) : null}
      <ul className="skills-modal__list">
        {skills?.map((skill) => (
          <li className="skills-modal__item" key={skill.versionId}>
            <button
              className="skills-modal__item-head"
              type="button"
              disabled={!!busy}
              aria-expanded={selected?.versionId === skill.versionId}
              onClick={() => void show(skill)}
            >
              <span className="skills-modal__item-name">
                {skill.name} · v{skill.version}
              </span>
              <span className="skills-modal__category">{STATUS[skill.status] ?? skill.status}</span>
            </button>
            <p className="skills-modal__item-desc">
              {skill.taskFamily.intentClass} · {skill.usage.loads} 次装载 · {skill.usage.successes}{' '}
              次成功 · {skill.usage.failures} 次失败
            </p>
            {selected?.versionId === skill.versionId && (
              <div className="skills-modal__detail">
                {busy === '详情' ? (
                  <p role="status">正在读取版本详情…</p>
                ) : (
                  <>
                    <dl className="learned-skills__metadata">
                      <dt>版本</dt>
                      <dd>{selected.versionId}</dd>
                      <dt>适用条件</dt>
                      <dd>
                        {selected.taskFamily.intentClass} / {selected.taskFamily.checkKind}
                        {selected.taskFamily.language ? ` / ${selected.taskFamily.language}` : ''}
                      </dd>
                      <dt>来源</dt>
                      <dd>
                        {selected.sourceOpportunityId}
                        <br />
                        {selected.observationRefs.join('、')}
                      </dd>
                      <dt>内容标识</dt>
                      <dd>{selected.contentHash}</dd>
                    </dl>
                    {content && (
                      <details open>
                        <summary>技能步骤与依据</summary>
                        <pre className="skills-modal__content">{content}</pre>
                      </details>
                    )}
                    <details>
                      <summary>使用记录（{uses.length}）</summary>
                      {uses.length ? (
                        <ul>
                          {uses.map((use, index) => (
                            <li key={`${use.runId}:${index}`}>
                              {use.outcome} · {use.runId}
                              <br />
                              <span>{use.sourceRef}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>尚无已记录的后续使用结果。装载本身不代表任务验证成功。</p>
                      )}
                    </details>
                    <button
                      className="settings-modal__btn settings-modal__btn--ghost"
                      type="button"
                      disabled={!!busy || !canWithdraw}
                      onClick={() => void mutate('withdraw')}
                    >
                      撤回此版本
                    </button>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
