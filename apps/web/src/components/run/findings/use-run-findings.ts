/**
 * M69 审片面板状态：加载、动作、当前播放时间与镜头定位。
 * 服务端投影为准；本 composable 只做 UI 态（loading/acting/notice）与半开区间当前镜头。
 */
import { computed, ref, type Ref } from 'vue'
import { findingsApi } from '../../../lib/api/findings'
import { ApiError } from '../../../lib/api/core'
import type { FindingsList, FindingView } from '../../../lib/types/findings'
import { allowedScopes } from './finding-ui'

export function useRunFindings(runId: Ref<number>, stepKey = 'compose') {
  const data = ref<FindingsList | null>(null)
  const loading = ref(false)
  const acting = ref(false)
  const hidden = ref(false)
  const errText = ref('')
  const notice = ref('')
  const currentMs = ref(0)

  const formatMs = (ms: number): string => {
    const total = Math.max(0, Math.round(ms))
    const s = Math.floor(total / 1000)
    const m = Math.floor(s / 60)
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${Math.floor((total % 1000) / 100)}`
  }

  const segments = computed(() => data.value?.timeline?.segments ?? [])
  const totalMs = computed(
    () => data.value?.timeline?.totalMs ?? data.value?.final?.durationMs ?? 0,
  )
  const finalAssetId = computed(() => data.value?.final?.assetId ?? null)

  /** 与后端 locateAt 同口径：半开区间，边界取后一段 */
  const currentShot = computed(() => {
    const tl = data.value?.timeline
    if (!tl) return null
    const at = currentMs.value
    if (at < tl.introMs || at >= tl.totalMs) return null
    return tl.segments.find((s) => at >= s.startMs && at < s.endMs) ?? null
  })

  const findings = computed(() => data.value?.findings ?? [])
  const sortedFindings = computed(() => {
    const rank = (s: FindingView['status']): number =>
      s === 'open' || s === 'in_rework' ? 0 : s === 'pending_recheck' ? 1 : 2
    const sev = (s: FindingView['severity']): number =>
      s === 'blocker' ? 0 : s === 'major' ? 1 : 2
    return [...findings.value].sort(
      (a, b) =>
        rank(a.status) - rank(b.status) ||
        sev(a.severity) - sev(b.severity) ||
        a.createdAt - b.createdAt,
    )
  })

  async function load(): Promise<void> {
    loading.value = true
    errText.value = ''
    try {
      data.value = await findingsApi.list(runId.value, stepKey)
      // 无成片且无历史问题单：整体隐藏，不打扰（与 QC 面板同策略）
      hidden.value =
        data.value.capability.code === 'no_final' &&
        data.value.findings.length === 0
    } catch (e) {
      if (e instanceof ApiError && e.code === 'run_not_found')
        hidden.value = true
      else
        errText.value = e instanceof ApiError ? e.message : '读取审片问题失败'
    } finally {
      loading.value = false
    }
  }

  function setMs(ms: number): void {
    currentMs.value = Number.isFinite(ms) ? ms : 0
  }

  function seekTo(ms: number, video: HTMLVideoElement | null): void {
    setMs(ms)
    if (video) video.currentTime = Math.max(0, ms / 1000)
  }

  async function act(
    fn: () => Promise<unknown>,
    okText: string,
  ): Promise<void> {
    acting.value = true
    notice.value = ''
    errText.value = ''
    try {
      await fn()
      notice.value = okText
      await load()
    } catch (e) {
      errText.value = e instanceof ApiError ? e.message : '操作失败'
    } finally {
      acting.value = false
    }
  }

  return {
    data,
    loading,
    acting,
    hidden,
    errText,
    notice,
    currentMs,
    formatMs,
    segments,
    totalMs,
    finalAssetId,
    currentShot,
    findings,
    sortedFindings,
    load,
    setMs,
    seekTo,
    act,
    allowedScopes,
  }
}
