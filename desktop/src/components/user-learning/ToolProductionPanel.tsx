import { useState } from 'react'
import type { ToolLearningRuntime } from '../../tool-learning/cli-status'
import { useToolProduction } from './use-tool-production'
import { ToolProductionDetail, productionLabel } from './ToolProductionDetail'
import './tool-production.css'
import { toolPurposeLabel, toolRuntimeLabel } from './ToolPurpose'

export function ToolProductionPanel({ runtime }: { readonly runtime?: ToolLearningRuntime }) {
  const state = useToolProduction(runtime),
    [filter, setFilter] = useState('all')
  const rows =
    state.inventory?.items.filter(
      (item) =>
        filter === 'all' ||
        (filter === 'active'
          ? productionLabel(item) === '已启用'
          : ['等待审核', '等待验证', '验证未通过', '验证未结束'].includes(productionLabel(item))),
    ) ?? []
  const selectedVisible = rows.some((item) => item.versionId === state.selected)
  return (
    <section
      className="tool-production"
      aria-label="生产工具管理"
      aria-busy={state.loading || !!state.busy}
    >
      <div className="tool-production__toolbar">
        <div className="tool-production__filters" role="group" aria-label="筛选生产工具">
          {[
            ['all', '全部工具'],
            ['review', '待处理'],
            ['active', '已启用'],
          ].map(([id, name]) => (
            <button
              type="button"
              key={id}
              aria-pressed={filter === id}
              disabled={!!state.busy}
              onClick={() => setFilter(id!)}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="tool-production__toolbar-end">
          {state.inventory ? (
            <span className="tool-production__count">当前工作区 · {rows.length} 项</span>
          ) : null}
          <button type="button" onClick={state.refresh} disabled={state.loading || !!state.busy}>
            刷新工具
          </button>
        </div>
      </div>
      {state.notice ? (
        <p className="tool-production__notice" role="status">
          {state.notice}
        </p>
      ) : null}
      {state.error ? (
        <div className="tool-production__empty" role="alert">
          <h3>暂时无法读取工具目录</h3>
          <p>请检查当前 CLI 是否支持生产工具管理，然后刷新重试。</p>
          <details>
            <summary>查看原因</summary>
            <code>{state.error}</code>
          </details>
          <button type="button" onClick={state.refresh}>
            重试读取
          </button>
        </div>
      ) : state.loading && !state.inventory ? (
        <p className="tool-production__empty" role="status">
          正在读取当前工作区的工具…
        </p>
      ) : !state.inventory?.items.length ? (
        <div className="tool-production__empty">
          <h3>还没有准备好的工具</h3>
          <p>待审阅的工具会显示在这里。新的工具缺口与处理进展可在「学习记录」中查看。</p>
        </div>
      ) : (
        <>
          {state.inventory.truncated || state.loading ? (
            <p className="tool-production__count">
              {state.inventory.truncated
                ? `目录共 ${state.inventory.total} 项，仅载入最近 50 项`
                : ''}
              {state.loading ? ' · 正在刷新…' : ''}
            </p>
          ) : null}
          <div className={`tool-production__workspace${selectedVisible ? ' has-selection' : ''}`}>
            <div className="tool-production__list" aria-label="工具列表">
              {rows.length ? (
                rows.map((item) => (
                  <button
                    type="button"
                    className="tool-production__item"
                    key={item.versionId}
                    aria-pressed={state.selected === item.versionId}
                    disabled={!!state.busy || state.loading}
                    onClick={() => state.select(item.versionId)}
                  >
                    <strong title={item.description}>{toolPurposeLabel(item.description)}</strong>
                    <span className="tool-production__item-package">
                      {item.packageName} · {item.packageVersion}
                    </span>
                    <span className="tool-production__item-state">
                      <span>{productionLabel(item)}</span>
                      <span>{toolRuntimeLabel(item.profile)}</span>
                    </span>
                  </button>
                ))
              ) : (
                <p>当前筛选没有匹配工具。选择「全部工具」可查看完整目录。</p>
              )}
            </div>
            {selectedVisible && state.readingDetail ? (
              <div className="tool-production__detail" role="status">
                正在读取来源与验证依据…
              </div>
            ) : selectedVisible && state.detailError ? (
              <div className="tool-production__detail" role="alert">
                <p>工具详情读取失败，请刷新后重试。</p>
                <code>{state.detailError}</code>
                <button type="button" onClick={state.refresh}>
                  重试详情
                </button>
                <button type="button" onClick={() => state.select(undefined)}>
                  返回工具列表
                </button>
              </div>
            ) : selectedVisible && state.detail ? (
              <ToolProductionDetail
                detail={state.detail}
                busy={state.busy}
                disabled={!!state.busy || state.loading}
                onAction={state.act}
                onBack={() => state.select(undefined)}
                onCancel={state.cancel}
              />
            ) : (
              <div className="tool-production__detail tool-production__placeholder">
                <h3>了解工具，再决定是否启用</h3>
                <p>选择一个工具，先了解它的用途和适用场景，再决定是否允许使用。</p>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}
