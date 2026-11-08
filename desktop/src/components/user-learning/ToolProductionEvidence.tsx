import { ToolProductionSources } from './ToolProductionSources'
import type { ProductionDetail } from '../../tool-learning/production-contract'
const stages: Readonly<Record<string, string>> = {
  source_license_provenance: '来源与许可',
  archive_path_manifest_schema: '依赖与接口',
  static_secret_malware_api: '静态材料检查',
  type_build_unit: '来源样例',
  sandbox_smoke: '隔离启动',
  permission_malicious_bounds: '权限边界',
  cancel_timeout_crash: '取消与崩溃',
  idempotency_side_effects: '重复调用',
  baseline_regression: '变式与反例',
  independent_verdict: '独立检查结论',
}
export function ToolProductionEvidence({ detail }: { readonly detail: ProductionDetail }) {
  return (
    <>
      <section>
        <h4>
          验证依据{' '}
          <span className="tool-production__meta">
            {detail.review.status === 'available' ? '当前收据有效' : '当前不可启用'}
          </span>
        </h4>
        {detail.report ? (
          <>
            <p>
              历史检查 {detail.report.stages.filter((item) => item.passed).length} / 10
              项通过。启用仍以当前收据和审批为准。
            </p>
            <details>
              <summary>展开检查记录</summary>
              <ol className="tool-production__stages">
                {detail.report.stages.map((item) => (
                  <li key={item.stage}>
                    <div>
                      <span>{stages[item.stage]}</span>
                      <span>{item.passed ? '通过' : '未通过'}</span>
                    </div>
                    <p>{item.detail}</p>
                  </li>
                ))}
              </ol>
            </details>
          </>
        ) : (
          <p>尚无已完成的生产检查记录。验证通过后仍需你单独批准启用。</p>
        )}
        {detail.review.status === 'available' ? (
          <details>
            <summary>收据与版本标识</summary>
            <dl>
              <dt>验证收据</dt>
              <dd>
                <code>{detail.review.receiptId}</code>
              </dd>
              <dt>精确版本</dt>
              <dd>
                <code>{detail.versionId}</code>
              </dd>
              <dt>本次审阅</dt>
              <dd>
                <code>{detail.review.reviewId}</code>
              </dd>
            </dl>
          </details>
        ) : (
          <p className="tool-production__meta">{detail.review.code}</p>
        )}
      </section>
      <ToolProductionSources detail={detail} />
    </>
  )
}
