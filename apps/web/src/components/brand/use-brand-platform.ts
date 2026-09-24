/**
 * platform 级品牌（BrandSettings 拆分：纯重构，函数体逐字搬移）
 * 平台品牌状态 + 预览 + 上传槽/字幕保存。依赖注入：wrap / form / 共享文件路径 refs。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import { settingsApi } from '../../lib/api'
import type {
  BrandConfig,
  BrandMaterialSlot,
  BrandSlotKey,
  WatermarkConfig,
} from '../../lib/types'
import { SLOT_TEXT, fileOf, normBrand, pctStore } from './brand-form-helpers'
import type { useBrandForm } from './use-brand-form'

type BrandForm = ReturnType<typeof useBrandForm>

export function useBrandPlatform(deps: {
  wrap: (fn: () => Promise<void>, okMsg: string) => Promise<void>
  form: BrandForm
  wmFile: Ref<string>
  introFile: Ref<string>
  outroFile: Ref<string>
}) {
  const { wrap, form, wmFile, introFile, outroFile } = deps
  const {
    wmEnabled,
    wmPosition,
    wmOpacity,
    wmWidth,
    wmMargin,
    introEnabled,
    outroEnabled,
    subOn,
    subPersisted,
    collectSub,
    fillCommon,
  } = form

  const platformBrand = ref<BrandConfig>({})
  const previewTs = ref<Record<BrandSlotKey, number>>({
    watermark: 0,
    intro: 0,
    outro: 0,
  })
  const previewBroken = ref<Record<BrandSlotKey, boolean>>({
    watermark: false,
    intro: false,
    outro: false,
  })

  function applyPlatformBrand(b: BrandConfig, refreshSlot?: BrandSlotKey) {
    platformBrand.value = b
    wmFile.value = fileOf(b, 'watermark')
    introFile.value = fileOf(b, 'intro')
    outroFile.value = fileOf(b, 'outro')
    if (refreshSlot) {
      previewTs.value[refreshSlot] = Date.now()
      previewBroken.value[refreshSlot] = false
    }
  }

  function onPreviewErr(slot: BrandSlotKey) {
    previewBroken.value[slot] = true
  }

  async function loadPlatform() {
    const s = await settingsApi.list()
    const raw = s.items.find((it) => it.key === 'brand')?.value
    const b = normBrand(raw)
    applyPlatformBrand(b)
    fillCommon(b)
  }

  /** platform 槽保存（读-合并写 settings.brand 整体） */
  function savePlatformSlot(slot: 'watermark' | 'intro' | 'outro') {
    void wrap(async () => {
      const next = JSON.parse(
        JSON.stringify(platformBrand.value),
      ) as BrandConfig
      if (slot === 'watermark') {
        const wm: WatermarkConfig = {
          ...(next.watermark ?? {}),
          position: wmPosition.value,
          opacity: pctStore(wmOpacity.value, 5, 100),
          width_pct: pctStore(wmWidth.value, 3, 50),
          margin_px: Math.round(
            Math.min(200, Math.max(0, Number(wmMargin.value) || 0)),
          ),
        }
        if (wmEnabled.value) delete wm.enabled
        else wm.enabled = false
        next.watermark = wm
      } else {
        const s: BrandMaterialSlot = { ...(next[slot] ?? {}) }
        const en = slot === 'intro' ? introEnabled.value : outroEnabled.value
        if (en) delete s.enabled
        else s.enabled = false
        next[slot] = s
      }
      await settingsApi.put('brand', next)
      platformBrand.value = next
    }, `${SLOT_TEXT[slot]}设置已保存（重新合成后生效）`)
  }

  /** platform 字幕样式保存 / 清除 */
  function savePlatformSubtitle() {
    const clearing = !subOn.value
    void wrap(
      async () => {
        const next = JSON.parse(
          JSON.stringify(platformBrand.value),
        ) as BrandConfig
        if (clearing) {
          delete next.subtitle
          subPersisted.value = false
        } else {
          next.subtitle = collectSub()
          subPersisted.value = true
        }
        await settingsApi.put('brand', next)
        platformBrand.value = next
      },
      clearing
        ? '平台字幕样式已清除（回落默认基线）'
        : '平台字幕样式已保存（重新合成后生效）',
    )
  }

  return {
    platformBrand,
    previewTs,
    previewBroken,
    applyPlatformBrand,
    onPreviewErr,
    loadPlatform,
    savePlatformSlot,
    savePlatformSubtitle,
  }
}
