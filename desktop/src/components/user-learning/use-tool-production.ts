import { useEffect, useRef, useState } from 'react'
import type { ToolLearningRuntime } from '../../tool-learning/cli-status'
import {
  loadProductionList,
  loadProductionDetail,
  runProductionAction,
  type ProductionAction,
} from '../../tool-learning/cli-production'
import type { ProductionList, ProductionDetail } from '../../tool-learning/production-contract'

export function useToolProduction(runtime?: ToolLearningRuntime) {
  const [inventory, setInventory] = useState<ProductionList>(),
    [detail, setDetail] = useState<ProductionDetail>()
  const [selected, select] = useState<string>(),
    [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true),
    [readingDetail, setReadingDetail] = useState(false)
  const [error, setError] = useState<string>(),
    [detailError, setDetailError] = useState<string>(),
    [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState<ProductionAction['kind']>(),
    actionController = useRef<AbortController>()
  const previousRuntime = useRef(runtime)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(undefined)
    setDetail(undefined)
    if (previousRuntime.current !== runtime) {
      setInventory(undefined)
      select(undefined)
      previousRuntime.current = runtime
    }
    if (!runtime) {
      setError('cli_unavailable')
      setLoading(false)
      return
    }
    void loadProductionList(runtime, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (result.ok) {
        setInventory(result.value)
        select((previous) =>
          result.value.items.some((item) => item.versionId === previous) ? previous : undefined,
        )
      } else {
        setError(result.reason)
        setInventory(undefined)
      }
      setLoading(false)
    })
    return () => controller.abort()
  }, [runtime, refresh])
  useEffect(() => {
    const controller = new AbortController()
    setDetail(undefined)
    setDetailError(undefined)
    setReadingDetail(false)
    if (!runtime || !inventory || !selected || loading) return
    setReadingDetail(true)
    void loadProductionDetail(runtime, selected, inventory.workspaceId, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return
        if (result.ok) setDetail(result.value)
        else setDetailError(result.reason)
        setReadingDetail(false)
      },
    )
    return () => controller.abort()
  }, [runtime, inventory, selected, loading])
  useEffect(() => {
    setBusy(undefined)
    setNotice(undefined)
    return () => {
      const owned = actionController.current
      actionController.current = undefined
      owned?.abort()
    }
  }, [runtime])
  async function act(action: ProductionAction): Promise<void> {
    if (!runtime || busy || loading || !detail || detail.versionId !== action.versionId) return
    const controller = new AbortController()
    actionController.current = controller
    setBusy(action.kind)
    setNotice(undefined)
    const result = await runProductionAction(runtime, action, controller.signal)
    if (actionController.current !== controller) return
    actionController.current = undefined
    setBusy(undefined)
    setDetail(undefined)
    setNotice(
      result.ok
        ? 'CLI 已确认操作完成。'
        : result.reason === 'cancelled' || result.reason === 'timeout'
          ? '已停止等待。操作结果尚未确认，请以重新读取的状态为准。'
          : result.reason === 'production_review_stale'
            ? '审阅依据已变化，本次启用未通过。请重新查看当前版本后决定。'
            : `操作未完成：${result.reason}。请检查当前状态后再决定。`,
    )
    setRefresh((value) => value + 1)
  }
  return {
    inventory,
    detail,
    selected,
    select,
    loading,
    readingDetail,
    error,
    detailError,
    notice,
    busy,
    refresh: () => setRefresh((value) => value + 1),
    act,
    cancel: () => actionController.current?.abort(),
  }
}
