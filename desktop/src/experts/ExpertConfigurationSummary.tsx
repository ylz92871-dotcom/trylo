import type { ExpertConfiguration } from '../../../new trylo cli/src/internal/subagent/experts/contracts'
import { EXPERT_ROLE_LABELS } from './presentation'

export function ExpertConfigurationSummary({
  configuration,
}: {
  readonly configuration: ExpertConfiguration
}) {
  return (
    <div className="expert-library__configuration expert-library__profile">
      <h3>适合哪些任务</h3>
      <ul>
        {configuration.situations.map((situation) => (
          <li key={situation}>{situation}</li>
        ))}
      </ul>
      <h3>负责的工作</h3>
      <ul>
        {configuration.responsibilities.map((responsibility) => (
          <li key={responsibility}>{responsibility}</li>
        ))}
      </ul>
      <h3>工作方法</h3>
      {configuration.methods.map((method, index) => (
        <section className="expert-library__method" key={index}>
          <h4>{method.title}</h4>
          <p className="expert-library__method-instructions">{method.instructions}</p>
        </section>
      ))}
      <details>
        <summary>协作要求与能力配置</summary>
        <dl>
          <dt>基础席位</dt>
          <dd>{EXPERT_ROLE_LABELS[configuration.baseRole]}</dd>
          <dt>约束</dt>
          <dd>{configuration.constraints.join('；') || '未单独指定'}</dd>
          <dt>协作要求</dt>
          <dd>{configuration.collaboration.join('；') || '未单独指定'}</dd>
          <dt>技能</dt>
          <dd>{configuration.role.skills?.join('、') || '未选择技能'}</dd>
          <dt>工具引用</dt>
          <dd>{configuration.toolRefs.join('、') || '未选择工具引用'}</dd>
        </dl>
        <p className="expert-library__hint">工具将在派发时解析并检查权限</p>
      </details>
      <h4>资源依据</h4>
      <ul className="expert-sources">
        {configuration.sources.map((source) => (
          <li key={source.uri}>
            <strong>{source.title}</strong>
            {/^(https?):\/\//i.test(source.uri) ? (
              <a href={source.uri} target="_blank" rel="noopener noreferrer">
                {source.uri}
              </a>
            ) : (
              <span>{source.uri}</span>
            )}
            <p>{source.excerpt}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}
