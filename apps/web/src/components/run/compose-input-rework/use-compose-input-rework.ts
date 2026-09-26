// 合成输入本地返修状态组合函数（切片2 §6 双模受控闸）：探测能力 → 加载基准配置/BGM/候选 →
// 表单本地收集变更（不预先直写草稿）→ 结构化预览（幂等 ticket）→ 原子确认（本地续跑、零付费）。
// 费用/影响/过期判断全部以后端返回为准，前端不重新实现（规格 §4/§9）。仅编辑 ComposeConfig 真实字段，
// 不臆造键（转场/时长/音量/字幕烧录 + BGM 换绑/移除）；clamp/枚举由服务端真源裁决。
import { computed, ref, type Ref } from 'vue'
import { composeApi, projectApi } from '../../../lib/api'
import { composeInputReworkApi, ReworkApiError } from '../../../lib/api/rework'
import { newRequestKey } from '../../../lib/api/creation-chat'
import { confirmDialog } from '../../../lib/confirm'
import type { Asset, ComposeConfig } from '../../../lib/types'
import type {
  ComposeInputCapabilityView,
  ComposeInputChangeView,
  ComposeInputPreviewView,
} from '../../../lib/types/rework'

/** BGM 换绑选择：保持当前 / 移除 / 换成指定资产 id */
export type BgmChoice = 'keep' | 'remove' | number

/** 返修表单草稿态（仅覆盖真实 ComposeConfig 字段；音量存 0–1/0–2 原值） */
export interface ComposeInputForm {
  transition: string
  transitionDuration: number
  bgmVolume: number
  bgmFade: number
  sfxVolume: number
  subtitleBurn: boolean
  bgmChoice: BgmChoice
}

export interface ComposeInputReworkHooks {
  onApplied?: (requestId: string) => void
}

const numOr = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** 表单草稿 → 结构化变更：与 baseline 逐字段 diff；无变化返回空数组（交 UI 禁用以避免 no_effect） */
export function buildComposeInputChanges(form: ComposeInputForm, base: ComposeConfig, bgmAssetId: number | null): ComposeInputChangeView[] {
  const patch: Record<string, unknown> = {}
  const baseTransition = base.transition ?? 'none'
  if (form.transition !== baseTransition) patch.transition = form.transition
  const baseDur = numOr(base.transition_duration, 0.5)
  if (Math.abs(form.transitionDuration - baseDur) > 1e-6) patch.transition_duration = form.transitionDuration
  const baseVol = numOr(base.bgm_volume, 0.25)
  if (Math.abs(form.bgmVolume - baseVol) > 1e-6) patch.bgm_volume = form.bgmVolume
  const baseFade = numOr(base.bgm_fade, 0)
  if (Math.abs(form.bgmFade - baseFade) > 1e-6) patch.bgm_fade = form.bgmFade
  const baseSfx = numOr(base.sfx_volume, 1)
  if (Math.abs(form.sfxVolume - baseSfx) > 1e-6) patch.sfx_volume = form.sfxVolume
  const baseBurn = base.subtitleBurn !== false // 缺省/true=烧录
  if (form.subtitleBurn !== baseBurn) patch.subtitleBurn = form.subtitleBurn

  const changes: ComposeInputChangeView[] = []
  if (Object.keys(patch).length > 0) changes.push({ kind: 'compose-config', patch })
  if (form.bgmChoice === 'remove') {
    if (bgmAssetId !== null) changes.push({ kind: 'bgm', assetId: null })
  } else if (typeof form.bgmChoice === 'number') {
    if (form.bgmChoice !== bgmAssetId) changes.push({ kind: 'bgm', assetId: form.bgmChoice })
  }
  return changes
}

/** 变更签名（幂等 ticket 判据：签名一致复用同 requestKey，连点不重复建请求） */
export function composeInputSignature(changes: ComposeInputChangeView[]): string {
  return JSON.stringify(changes)
}

export function useComposeInputRework(
  runId: Ref<number>,
  stepKey: Ref<string | undefined>,
  projectId: Ref<number>,
  hooks: ComposeInputReworkHooks = {},
) {
  const capability = ref<ComposeInputCapabilityView | null>(null)
  const baseConfig = ref<ComposeConfig>({})
  const baseBgm = ref<{ assetId: number | null; name: string | null }>({ assetId: null, name: null })
  const candidates = ref<Asset[]>([])
  const form = ref<ComposeInputForm>({
    transition: 'none',
    transitionDuration: 0.5,
    bgmVolume: 0.25,
    bgmFade: 0,
    sfxVolume: 1,
    subtitleBurn: true,
    bgmChoice: 'keep',
  })

  const loading = ref(false)
  const submitting = ref(false)
  const applying = ref(false)
  const loadError = ref('')
  const previewError = ref('')
  const preview = ref<ComposeInputPreviewView | null>(null)
  const requestId = ref('')
  const ticket = ref<{ signature: string; key: string } | null>(null)
  const previewSignature = ref('')
  let epoch = 0

  const supported = computed(() => capability.value?.supported === true)
  const changes = computed(() => buildComposeInputChanges(form.value, baseConfig.value, baseBgm.value.assetId))
  const dirty = computed(() => changes.value.length > 0)
  const changeCount = computed(() => changes.value.length)

  /** 用后端返回的基准配置回填表单初值（显示口径与 ComposeSettingsModal 一致） */
  function seedForm(cfg: ComposeConfig, bgmAssetId: number | null): void {
    form.value = {
      transition: cfg.transition ?? 'none',
      transitionDuration: numOr(cfg.transition_duration, 0.5),
      bgmVolume: numOr(cfg.bgm_volume, 0.25),
      bgmFade: numOr(cfg.bgm_fade, 0),
      sfxVolume: numOr(cfg.sfx_volume, 1),
      subtitleBurn: cfg.subtitleBurn !== false,
      bgmChoice: 'keep',
    }
    void bgmAssetId
  }

  async function load(): Promise<void> {
    if (!runId.value) return
    const token = ++epoch
    loading.value = true
    loadError.value = ''
    try {
      const cap = await composeInputReworkApi.capability(runId.value, stepKey.value ?? 'compose')
      if (token !== epoch) return
      capability.value = cap.capability
      if (!cap.capability.supported) {
        loading.value = false
        return
      }
      const [cfgRes, bgmRes] = await Promise.all([composeApi.getConfig(runId.value), composeApi.getBgm(runId.value)])
      if (token !== epoch) return
      baseConfig.value = (cfgRes.config ?? {}) as ComposeConfig
      baseBgm.value = { assetId: bgmRes.bgm?.id ?? null, name: bgmRes.bgm?.name ?? null }
      seedForm(baseConfig.value, baseBgm.value.assetId)
      if (projectId.value > 0) {
        const r = await projectApi.assets(projectId.value, '?kind=audio&limit=50')
        if (token !== epoch) return
        candidates.value = r.items
      }
      resetPreview()
    } catch (err) {
      if (token !== epoch) return
      loadError.value = err instanceof Error ? err.message : '加载合成返修状态失败'
      capability.value = null
    } finally {
      if (token === epoch) loading.value = false
    }
  }

  function resetPreview(): void {
    preview.value = null
    previewError.value = ''
    requestId.value = ''
    ticket.value = null
    previewSignature.value = ''
  }

  /** 表单编辑后签名变化即作废预览（同签名连续输入不回退已展示的预览） */
  function onFormEdited(): void {
    if (!preview.value && !previewError.value) return
    if (previewSignature.value && previewSignature.value === composeInputSignature(changes.value)) return
    resetPreview()
  }

  /** 请求预览：同签名复用 ticket；blocked/冲突按后端 message 就近展示 */
  async function requestPreview(): Promise<void> {
    if (!supported.value || submitting.value) return
    const list = changes.value
    if (list.length === 0) {
      previewError.value = '没有待确认的修改'
      return
    }
    const signature = composeInputSignature(list)
    if (!ticket.value || ticket.value.signature !== signature) {
      ticket.value = { signature, key: newRequestKey('cirw') }
    }
    const token = epoch
    const key = ticket.value.key
    submitting.value = true
    previewError.value = ''
    try {
      const res = await composeInputReworkApi.preview(runId.value, key, list, stepKey.value)
      if (token !== epoch) return
      requestId.value = res.request_id
      preview.value = res.preview
      previewSignature.value = signature
    } catch (err) {
      if (token !== epoch) return
      if (err instanceof ReworkApiError) {
        previewError.value = `${err.message}${err.requestId ? `（请求 ${err.requestId}）` : ''}`
        if (err.code === 'idempotency_conflict' || err.code === 'stale_preview' || err.code === 'no_effect') {
          preview.value = null
          ticket.value = null
        }
      } else {
        previewError.value = err instanceof Error ? err.message : '预览请求失败'
      }
    } finally {
      if (token === epoch) submitting.value = false
    }
  }

  /** 原子确认：逐字回传 previewHash；成功后重载基准（新成片待复审） */
  async function applyConfirmed(): Promise<boolean> {
    const pv = preview.value
    if (!pv || !requestId.value || applying.value) return false
    applying.value = true
    previewError.value = ''
    try {
      const res = await composeInputReworkApi.apply(runId.value, requestId.value, pv.previewHash)
      preview.value = null
      ticket.value = null
      await load()
      hooks.onApplied?.(res.request_id)
      return true
    } catch (err) {
      previewError.value = err instanceof Error ? `${err.message}；未确认，可重新预览后重试` : '确认请求失败'
      if (err instanceof ReworkApiError && err.status === 409) preview.value = null
      return false
    } finally {
      applying.value = false
    }
  }

  /** 未保存离开提示（有本地改动尚未预览确认时） */
  async function guardClose(): Promise<boolean> {
    if (!dirty.value) return true
    return confirmDialog({
      title: '放弃未确认的合成修改？',
      message: `当前有 ${changeCount.value} 项合成输入修改尚未预览确认，关闭后本地选择将丢失（不影响已生成的成片）。`,
      confirmText: '放弃修改',
      cancelText: '继续编辑',
      danger: true,
    })
  }

  return {
    capability,
    baseConfig,
    baseBgm,
    candidates,
    form,
    loading,
    submitting,
    applying,
    loadError,
    previewError,
    preview,
    requestId,
    supported,
    changes,
    dirty,
    changeCount,
    load,
    onFormEdited,
    requestPreview,
    applyConfirmed,
    guardClose,
  }
}
