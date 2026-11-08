import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { approveToolAcquisition, loadToolAcquisitionReview, type ToolAcquisitionReview } from '../../tool-learning/cli-acquisition'
import type { ToolLearningRuntime } from '../../tool-learning/cli-status'
import { confirmToolAcquisitionInquiry, loadToolAcquisitionInquiry } from '../../tool-learning/cli-acquisition-inquiry'
import type { ToolAcquisitionInquiryReview } from '../../tool-learning/acquisition-inquiry-contract'

export function useToolAcquisition(runtime: ToolLearningRuntime | undefined, jobId: string, workspaceId: string) {
  useSyncExternalStore(runtime?.recovery?.subscribe ?? noSubscribe, runtime?.recovery?.getVersion ?? noVersion, noVersion)
  const startBlocked = runtime?.lifecycle?.canStart?.() === false
  const workspaceRoot = runtime?.cwd
  const stopPending = startBlocked && (runtime?.recovery?.statuses().some(row => row.workspaceRoot === workspaceRoot
    && (row.state === 'stopping' || row.state === 'stop_unconfirmed')) ?? false)
  const [review, setReview] = useState<ToolAcquisitionReview>(), [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0)
  const [notice, setNotice] = useState<string>()
  const [operation, setOperation] = useState<'acquire' | 'review_inquiry' | 'inquiry' | 'recover_inquiry'>()
  const [inquiry, setInquiry] = useState<ToolAcquisitionInquiryReview>(), [inquiryError, setInquiryError] = useState<string>()
  const actionController = useRef<AbortController>()
  const refreshController = useRef<AbortController>()
  useEffect(() => {
    setReview(undefined)
    setNotice(undefined)
    setBusy(false)
    setOperation(undefined)
    setInquiry(undefined)
    setInquiryError(undefined)
    return () => {
      const owned = actionController.current
      actionController.current = undefined
      owned?.abort()
      refreshController.current?.abort()
    }
  }, [runtime, jobId, workspaceId])
  useEffect(() => {
    const controller = new AbortController()
    refreshController.current = controller
    setLoading(true)
    setError(undefined)
    if (!runtime) {
      setError('cli_unavailable')
      setLoading(false)
      return
    }
    void loadToolAcquisitionReview(runtime, jobId, workspaceId, controller.signal).then(result => {
      if (controller.signal.aborted) return
      if (result.ok) setReview(result.value)
      else setError(result.reason)
      setLoading(false)
    })
    return () => controller.abort()
  }, [runtime, jobId, workspaceId, refresh])
  // Only a user-started operation gets live reads. Each completed read schedules
  // the next, so slow CLI queries never overlap and leaving the view stops them.
  useEffect(() => {
    if (!busy || operation !== 'acquire' || !runtime) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const result = await loadToolAcquisitionReview(runtime, jobId, workspaceId, controller.signal)
      if (controller.signal.aborted) return
      if (result.ok) { setReview(result.value); setError(undefined) }
      timer = setTimeout(() => { void poll() }, 3000)
    }
    timer = setTimeout(() => { void poll() }, 3000)
    return () => { clearTimeout(timer); controller.abort() }
  }, [runtime, jobId, workspaceId, busy, operation])
  useEffect(() => {
    if (!busy || operation !== 'inquiry' || !runtime || !review?.failure) return
    const controller = new AbortController(), original = review
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const result = await loadToolAcquisitionInquiry(runtime, original, controller.signal)
      if (controller.signal.aborted) return
      if (result.ok) { setInquiry(result.value); setInquiryError(undefined) }
      timer = setTimeout(() => { void poll() }, 3000)
    }
    timer = setTimeout(() => { void poll() }, 3000)
    return () => { clearTimeout(timer); controller.abort() }
  }, [runtime, busy, operation, review?.failure?.ref])

  async function approve() {
    if (!runtime || !review || loading || error || startBlocked || actionController.current) return
    const controller = new AbortController()
    actionController.current = controller
    setBusy(true)
    setOperation('acquire')
    setNotice(undefined)
    const result = await approveToolAcquisition(runtime, review, controller.signal)
    if (actionController.current !== controller) return
    actionController.current = undefined
    setBusy(false)
    setOperation(undefined)
    setNotice(result.ok ? 'CLI 已确认候选已保存。请在工具管理中继续验证和审核。'
      : ['cancelled', 'timeout', 'stop_unconfirmed', 'incomplete_output', 'acquisition_result_unconfirmed'].includes(result.reason)
        ? '本次等待已结束，操作结果尚未确认。正在重新读取持久进度；不会自动重复授权。'
        : result.reason === 'approval_plan_mismatch'
          ? '获取方案已变化，本次授权未通过。请重新审阅当前方案。'
          : `本次请求未确认完成（${result.reason}）。正在读取已保存进度；补充所需依据或额度后可继续。`)
    // A fresh read uses its own signal even when the action was cancelled.
    setRefresh(value => value + 1)
  }

  async function inquiryAction(mode: 'review' | 'start' | 'recover') {
    if (!runtime || !review?.failure || loading || error || actionController.current || (mode !== 'review' && startBlocked)) return
    const original = review, controller = new AbortController()
    actionController.current = controller
    setBusy(true)
    setOperation(mode === 'review' ? 'review_inquiry' : mode === 'start' ? 'inquiry' : 'recover_inquiry')
    setInquiryError(undefined)
    setNotice(undefined)
    if (mode === 'review') {
      const result = await loadToolAcquisitionInquiry(runtime, original, controller.signal)
      if (actionController.current !== controller) return
      if (result.ok) setInquiry(result.value)
      else setInquiryError(result.reason)
    } else {
      if (!inquiry) { actionController.current = undefined; setBusy(false); setOperation(undefined); return }
      const result = await confirmToolAcquisitionInquiry(runtime, original, inquiry, controller.signal, mode === 'start' ? 'start' : 'recover')
      if (actionController.current !== controller) return
      setNotice(result.ok ? mode === 'start' ? '续查请求已结束，正在读取已保存结果。新方案仍需单独审阅。' : '中断恢复请求已结束，正在读取持久状态。尚未重发续查。'
        : `本次续查请求未确认完成（${result.reason}）。正在重新读取状态，不会自动重发。`)
      // A cancelled or unconfirmed operation still permits a fresh read, never
      // a repeated mutation. The original Supervisor retains unknown processes.
      const followup = new AbortController()
      actionController.current = followup
      setOperation('review_inquiry')
      const current = await loadToolAcquisitionInquiry(runtime, original, followup.signal)
      if (actionController.current !== followup) return
      if (current.ok) setInquiry(current.value)
      else setInquiryError(current.reason)
    }
    actionController.current = undefined
    setBusy(false)
    setOperation(undefined)
  }
  return { review, error, loading, busy, notice, approve, stopPending, startBlocked, operation, inquiry, inquiryError,
    reviewInquiry: () => inquiryAction('review'), confirmInquiry: () => inquiryAction('start'), recoverInquiry: () => inquiryAction('recover'),
    refresh: () => setRefresh(value => value + 1), cancel: () => actionController.current?.abort() }
}
const noSubscribe = () => () => {}
const noVersion = () => 0
