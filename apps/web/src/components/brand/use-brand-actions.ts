/**
 * 品牌操作域（自 BrandSettings.vue script 逐字迁移，行为零变更）：
 * project scope 载入 / 上传·清除 / project 槽·字幕保存 / run 水印参数可编辑性 / 表单→预览实时联动。
 * —— 装配约定：ctx 注入 + 首行同名解构，函数体逐字保留（拆分纪律）；
 * 公共表单字段真源仍在 ./use-brand-form，project 资产 refs 由本域持有并回传模板。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { brandAssetApi, projectApi, uploadFiles } from '../../lib/api'
import type {
  BrandConfig,
  BrandMaterialSlot,
  BrandSlotKey,
  WatermarkConfig,
} from '../../lib/types'
import { SLOT_TEXT, fileOf, normBrand, pctStore } from './brand-form-helpers'
import { useBrandForm } from './use-brand-form'
import { useBrandAssets } from './use-brand-assets'
import { useBrandPlatform } from './use-brand-platform'
import { useBrandRun } from './use-brand-run'

export function useBrandActions(ctx: {
  props: {
    scope: 'platform' | 'project' | 'run'
    projectId?: number
    runId?: number
  }
  emit: (event: 'preview', data: { brand: BrandConfig; wmFile: string }) => void
  loading: Ref<boolean>
  err: Ref<string>
  busy: Ref<boolean>
  wrap: (fn: () => Promise<void>, okMsg: string) => Promise<void>
  form: ReturnType<typeof useBrandForm>
  assets: ReturnType<typeof useBrandAssets>
  platform: ReturnType<typeof useBrandPlatform>
  run: ReturnType<typeof useBrandRun>
  wmFile: Ref<string>
  introFile: Ref<string>
  outroFile: Ref<string>
}) {
  const {
    props,
    emit,
    loading,
    err,
    busy,
    wrap,
    form,
    assets,
    platform,
    run,
    wmFile,
    introFile,
    outroFile,
  } = ctx
  const {
    fillCommon,
    collectSub,
    subOn,
    subPersisted,
    subFont,
    subSize,
    subColor,
    subOutlineColor,
    subOutline,
    subShadow,
    subMarginV,
    subAlign,
    subBold,
    wmEnabled,
    wmPosition,
    wmOpacity,
    wmWidth,
    wmMargin,
    introEnabled,
    outroEnabled,
  } = form
  const { refreshProjectAssets } = assets
  const { loadPlatform, applyPlatformBrand } = platform
  const { loadRun, wmMode } = run

  const projectSettings = ref<Record<string, unknown>>({})
  const projectBrand = ref<BrandConfig>({})
  const wmAssetId = ref(0) // 0 = 不使用项目资产
  const introAssetId = ref(0)
  const outroAssetId = ref(0)
  // ---------- 加载 ----------

  async function loadProject() {
    const pid = props.projectId ?? 0
    const p = await projectApi.detail(pid)
    const settings = (p.project.settings ?? {}) as Record<string, unknown>
    projectSettings.value = settings
    const b = normBrand(settings.brand)
    projectBrand.value = b
    wmAssetId.value =
      typeof b.watermark?.asset_id === 'number' ? b.watermark.asset_id : 0
    introAssetId.value =
      typeof b.intro?.asset_id === 'number' ? b.intro.asset_id : 0
    outroAssetId.value =
      typeof b.outro?.asset_id === 'number' ? b.outro.asset_id : 0
    // project scope 也需设置文件路径，否则预览 wmFile/introFile/outroFile 永远为空
    wmFile.value = fileOf(b, 'watermark')
    introFile.value = fileOf(b, 'intro')
    outroFile.value = fileOf(b, 'outro')
    fillCommon(b)
    await refreshProjectAssets()
  }

  onMounted(async () => {
    try {
      if (props.scope === 'platform') await loadPlatform()
      else if (props.scope === 'project') await loadProject()
      else await loadRun()
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  })

  // ---------- 上传 / 清除 ----------

  const fileInput = ref<HTMLInputElement | null>(null)
  const pendingSlot = ref<BrandSlotKey>('watermark')

  function pickFile(slot: BrandSlotKey) {
    pendingSlot.value = slot
    void nextTick(() => fileInput.value?.click())
  }

  async function onFilePicked(e: Event) {
    const input = e.target as HTMLInputElement
    const f = input.files?.[0]
    input.value = ''
    if (!f) return
    const slot = pendingSlot.value
    const label = SLOT_TEXT[slot]
    if (props.scope === 'platform') {
      await wrap(async () => {
        const r = await brandAssetApi.upload(slot, f)
        applyPlatformBrand(r.brand, slot)
      }, `${label}已上传（重新合成后生效）`)
    } else if (props.scope === 'project') {
      await wrap(async () => {
        const pid = props.projectId ?? 0
        const [a] = await uploadFiles(pid, 'source', [f])
        if (!a) throw new Error('上传失败：未返回资产')
        const want = slot === 'watermark' ? 'image' : 'video'
        if (a.kind !== want)
          throw new Error(
            `${label}需${want === 'image' ? '图片' : '视频'}文件（得到 ${a.kind}）`,
          )
        await refreshProjectAssets()
        if (slot === 'watermark') wmAssetId.value = a.id
        else if (slot === 'intro') introAssetId.value = a.id
        else outroAssetId.value = a.id
      }, `${label}已上传并选中（保存后生效）`)
    }
  }

  function clearSlot(slot: BrandSlotKey) {
    void wrap(async () => {
      const r = await brandAssetApi.clear(slot)
      applyPlatformBrand(r.brand, slot)
    }, `${SLOT_TEXT[slot]}引用已清除（磁盘文件保留；重新合成后生效）`)
  }

  // ---------- 保存 ----------

  /** project 槽保存（读-合并写 projects.settings.brand） */
  function saveProjectSlot(slot: 'watermark' | 'intro' | 'outro') {
    void wrap(async () => {
      const pid = props.projectId ?? 0
      const next = JSON.parse(JSON.stringify(projectBrand.value)) as BrandConfig
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
        if (wmAssetId.value > 0) wm.asset_id = wmAssetId.value
        else delete wm.asset_id
        if (wmEnabled.value) delete wm.enabled
        else wm.enabled = false
        next.watermark = wm
      } else {
        const s: BrandMaterialSlot = { ...(next[slot] ?? {}) }
        const id = slot === 'intro' ? introAssetId.value : outroAssetId.value
        const en = slot === 'intro' ? introEnabled.value : outroEnabled.value
        if (id > 0) s.asset_id = id
        else delete s.asset_id
        if (en) delete s.enabled
        else s.enabled = false
        next[slot] = s
      }
      const settings = { ...projectSettings.value, brand: next }
      await projectApi.update(pid, { settings })
      projectSettings.value = settings
      projectBrand.value = next
    }, `项目${SLOT_TEXT[slot]}设置已保存（重新合成后生效）`)
  }

  /** project 字幕样式保存 / 清除 */
  function saveProjectSubtitle() {
    const clearing = !subOn.value
    void wrap(
      async () => {
        const pid = props.projectId ?? 0
        const next = JSON.parse(JSON.stringify(projectBrand.value)) as BrandConfig
        if (clearing) {
          delete next.subtitle
          subPersisted.value = false
        } else {
          next.subtitle = collectSub()
          subPersisted.value = true
        }
        const settings = { ...projectSettings.value, brand: next }
        await projectApi.update(pid, { settings })
        projectSettings.value = settings
        projectBrand.value = next
      },
      clearing
        ? '项目字幕样式已清除（回落平台/默认）'
        : '项目字幕样式已保存（重新合成后生效）',
    )
  }

  // ---------- 派生 ----------

  /** run 模式：水印参数控件可编辑性（仅自定义模式） */
  const wmParamsDisabled = computed(
    () => busy.value || (props.scope === 'run' && wmMode.value !== 'custom'),
  )

  // 表单 → 预览实时联动：监听所有表单字段，变化时 emit preview 供父组件 BrandPreview 即时渲染
  const formWatchSrc = computed(() => ({
    sub: {
      on: subOn.value,
      font: subFont.value,
      size: subSize.value,
      color: subColor.value,
      outlineColor: subOutlineColor.value,
      outline: subOutline.value,
      shadow: subShadow.value,
      marginV: subMarginV.value,
      align: subAlign.value,
      bold: subBold.value,
    },
    wm: {
      enabled: wmEnabled.value,
      position: wmPosition.value,
      opacity: wmOpacity.value,
      width: wmWidth.value,
      margin: wmMargin.value,
    },
    intro: introEnabled.value,
    outro: outroEnabled.value,
    wmFile: wmFile.value,
    introFile: introFile.value,
    outroFile: outroFile.value,
    // 项目资产来源纳入监听：选择/切换项目资产（asset_id）时预览才会更新
    wmAssetId: wmAssetId.value,
    introAssetId: introAssetId.value,
    outroAssetId: outroAssetId.value,
  }))
  watch(
    formWatchSrc,
    (v) => {
      const brand: BrandConfig = {}
      if (v.sub.on) {
        brand.subtitle = {
          font: v.sub.font || undefined,
          size_pct: pctStore(v.sub.size, 0.8, 6),
          color: v.sub.color,
          outline_color: v.sub.outlineColor,
          outline_pct: pctStore(v.sub.outline, 0, 0.5),
          shadow: Math.round(Math.min(8, Math.max(0, Number(v.sub.shadow) || 0))),
          margin_v_pct: pctStore(v.sub.marginV, 0, 10),
          alignment: v.sub.align,
          bold: v.sub.bold,
        }
      }
      brand.watermark = {
        position: v.wm.position,
        opacity: pctStore(v.wm.opacity, 5, 100),
        width_pct: pctStore(v.wm.width, 3, 50),
        margin_px: Math.round(
          Math.min(200, Math.max(0, Number(v.wm.margin) || 0)),
        ),
      }
      // 项目资产来源：asset_id 优先于 file（镜像服务端 resolveMaterialPath 语义）
      if (v.wmAssetId > 0) brand.watermark.asset_id = v.wmAssetId
      if (!v.wm.enabled) brand.watermark.enabled = false
      brand.intro = { enabled: v.intro, file: v.introFile || undefined }
      if (v.introAssetId > 0) brand.intro.asset_id = v.introAssetId
      brand.outro = { enabled: v.outro, file: v.outroFile || undefined }
      if (v.outroAssetId > 0) brand.outro.asset_id = v.outroAssetId
      emit('preview', { brand, wmFile: v.wmFile })
    },
    { deep: true },
  )

  return {
    wmAssetId,
    introAssetId,
    outroAssetId,
    fileInput,
    pendingSlot,
    pickFile,
    onFilePicked,
    clearSlot,
    saveProjectSlot,
    saveProjectSubtitle,
    wmParamsDisabled,
  }
}
