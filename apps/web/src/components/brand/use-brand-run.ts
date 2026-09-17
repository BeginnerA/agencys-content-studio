/**
 * [M19] run 级品牌覆盖（BrandSettings 拆分：M26 红线纯重构，函数体逐字搬移）
 * run scope 三态覆盖（继承/禁用/自定义）+ 继承摘要 + 保存 + 回填。
 * 依赖注入：form（水印参数 refs）、deps（wrap/imgAssets/assetName）；保持函数体逐字不变。
 */
import { computed, ref } from 'vue'
import type { Ref } from 'vue'
import { composeApi, projectApi, settingsApi } from '../../lib/api'
import type { Asset, BrandConfig, BrandMaterialSlot, BrandSlotKey, WatermarkConfig } from '../../lib/types'
import {
  SLOT_TEXT,
  WM_POSITIONS,
  marginOf,
  mergeFront,
  normBrand,
  pctShow,
  pctStore,
  posOf,
} from './brand-form-helpers'
import type { useBrandForm } from './use-brand-form'

export function useBrandRun(
  props: { scope: 'platform' | 'project' | 'run'; projectId?: number; runId?: number },
  form: Pick<ReturnType<typeof useBrandForm>, 'wmPosition' | 'wmOpacity' | 'wmWidth' | 'wmMargin'>,
  deps: {
    wrap: (fn: () => Promise<void>, okMsg: string) => Promise<void>
    imgAssets: Ref<Asset[]>
    assetName: (id: number) => string
  },
) {
  const { wmPosition, wmOpacity, wmWidth, wmMargin } = form
  const { wrap, imgAssets, assetName } = deps

  const runBrand = ref<BrandConfig>({})
  const inheritBrand = ref<BrandConfig>({})
  const wmMode = ref<'inherit' | 'off' | 'custom'>('inherit')
  const introMode = ref<'inherit' | 'off' | 'on'>('inherit')
  const outroMode = ref<'inherit' | 'off' | 'on'>('inherit')
  const wmAssetIdRun = ref(0) // 0 = 继承

  /** 继承槽来源摘要（asset_id 优先 → file → 无；镜像服务端 resolveMaterialPath 语义） */
  function inheritSummary(slot: BrandSlotKey): string {
    const cfg = inheritBrand.value[slot]
    if (!cfg) return '继承：未配置（合成时跳过）'
    if (cfg.enabled === false) return '继承：已禁用（合成时跳过）'
    if (typeof cfg.asset_id === 'number' && cfg.asset_id > 0) return `继承：项目资产 ${assetName(cfg.asset_id)}`
    if (cfg.file) return `继承：平台文件「${cfg.file}」`
    return '继承：未配置来源（合成时跳过）'
  }

  /** 继承水印参数摘要（清洗 + 默认值同服务端 sanitizeWatermark） */
  function inheritWmParams(): string {
    const wm = inheritBrand.value.watermark
    const posText = WM_POSITIONS.find((p) => p.v === posOf(wm?.position))?.t ?? '右下'
    return `参数：${posText} · 透明度 ${Math.round(pctShow(wm?.opacity, 90))}% · 宽度 ${Math.round(pctShow(wm?.width_pct, 15))}% · 边距 ${marginOf(wm?.margin_px)}px`
  }

  /** run 覆盖表单回填（来源优先级：run 覆盖值 → 继承值 → 默认） */
  function fillRunForms() {
    const rw = runBrand.value.watermark
    if (!rw) wmMode.value = 'inherit'
    else if (rw.enabled === false) wmMode.value = 'off'
    else wmMode.value = 'custom'
    const src = { ...inheritBrand.value.watermark, ...rw } as WatermarkConfig
    wmPosition.value = posOf(src.position)
    wmOpacity.value = pctShow(src.opacity, 90)
    wmWidth.value = pctShow(src.width_pct, 15)
    wmMargin.value = marginOf(src.margin_px)
    wmAssetIdRun.value = typeof rw?.asset_id === 'number' ? rw.asset_id : 0
    const ri = runBrand.value.intro
    introMode.value = !ri ? 'inherit' : ri.enabled === false ? 'off' : 'on'
    const ro = runBrand.value.outro
    outroMode.value = !ro ? 'inherit' : ro.enabled === false ? 'off' : 'on'
  }

  async function loadRun() {
    const rid = props.runId ?? 0
    const pid = props.projectId ?? 0
    const [c, s, p, imgs] = await Promise.all([
      composeApi.getConfig(rid),
      settingsApi.list(),
      pid > 0 ? projectApi.detail(pid) : Promise.resolve(null),
      pid > 0 ? projectApi.assets(pid, '?kind=image&limit=200') : Promise.resolve(null),
    ])
    runBrand.value = normBrand(c.config.brand)
    const plat = normBrand(s.items.find((it) => it.key === 'brand')?.value)
    const proj = normBrand(p?.project.settings?.brand)
    inheritBrand.value = mergeFront(plat, proj)
    imgAssets.value = imgs?.items ?? []
    fillRunForms()
  }

  /** run 水印覆盖保存（三态：继承=清除覆盖 / 禁用 / 自定义参数） */
  function saveRunWatermark() {
    const mode = wmMode.value
    void wrap(async () => {
      const rid = props.runId ?? 0
      let patch: WatermarkConfig | null
      if (mode === 'inherit') {
        patch = null
      } else if (mode === 'off') {
        patch = { enabled: false }
      } else {
        patch = {
          position: wmPosition.value,
          opacity: pctStore(wmOpacity.value, 5, 100),
          width_pct: pctStore(wmWidth.value, 3, 50),
          margin_px: Math.round(Math.min(200, Math.max(0, Number(wmMargin.value) || 0))),
        }
        if (wmAssetIdRun.value > 0) patch.asset_id = wmAssetIdRun.value
      }
      const r = await composeApi.updateConfig(rid, { brand: { watermark: patch } })
      runBrand.value = normBrand(r.config.brand)
      fillRunForms()
    }, mode === 'inherit' ? '水印覆盖已清除（回落继承）' : '水印 run 级覆盖已保存（重新合成后生效）')
  }

  /** run 片头/片尾覆盖保存（三态：继承 / 禁用 / 强制启用） */
  function saveRunClip(slot: 'intro' | 'outro') {
    const mode = slot === 'intro' ? introMode.value : outroMode.value
    const patch: BrandMaterialSlot | null = mode === 'inherit' ? null : { enabled: mode === 'on' }
    void wrap(async () => {
      const rid = props.runId ?? 0
      const r = await composeApi.updateConfig(rid, { brand: { [slot]: patch } })
      runBrand.value = normBrand(r.config.brand)
      fillRunForms()
    }, mode === 'inherit' ? `${SLOT_TEXT[slot]}覆盖已清除（回落继承）` : `${SLOT_TEXT[slot]} run 级覆盖已保存（重新合成后生效）`)
  }

  /** 保存按钮文案（run 水印） */
  const runWmBtnText = computed(() => (wmMode.value === 'inherit' ? '清除覆盖（用继承）' : '保存覆盖'))

  /** 片头/片尾覆盖模式读写（v-for 内 v-model 不能写三元表达式，改 checked + change） */
  function clipModeOf(slot: 'intro' | 'outro'): 'inherit' | 'off' | 'on' {
    return slot === 'intro' ? introMode.value : outroMode.value
  }
  function setClipMode(slot: 'intro' | 'outro', mode: 'inherit' | 'off' | 'on') {
    if (slot === 'intro') introMode.value = mode
    else outroMode.value = mode
  }

  return {
    runBrand,
    inheritBrand,
    wmMode,
    introMode,
    outroMode,
    wmAssetIdRun,
    inheritSummary,
    inheritWmParams,
    fillRunForms,
    loadRun,
    saveRunWatermark,
    saveRunClip,
    runWmBtnText,
    clipModeOf,
    setClipMode,
  }
}
