<script setup lang="ts">
/**
 * [M19] 品牌设置（spec §4；三处复用同一表单）
 * - scope='platform'：平台品牌（settings.brand）——字幕样式 + 水印/片头/片尾上传/预览/参数/清除
 * - scope='project'：项目品牌（projects.settings.brand）——字幕样式 + 水印/片头尾从项目资产选择/上传
 * - scope='run'：run 级覆盖（_compose.brand）——水印/片头尾三态（继承/禁用/自定义）+ 显示继承值与来源
 * 全部操作不触发执行（提示「重新合成后生效」）；成功后 emit changed。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { brandAssetApi, composeApi, projectApi, settingsApi, uploadFiles } from '../../lib/api'
import type {
  Asset,
  BrandConfig,
  BrandMaterialSlot,
  BrandSlotKey,
  SubtitleStyleConfig,
  WatermarkConfig,
  WatermarkPosition,
} from '../../lib/types'
import Icon from '../common/Icon.vue'

const props = defineProps<{ scope: 'platform' | 'project' | 'run'; projectId?: number; runId?: number }>()
const emit = defineEmits<{ changed: []; preview: [data: { brand: BrandConfig; wmFile: string }] }>()

const loading = ref(true)
const busy = ref(false)
const err = ref('')
const notice = ref('')

/** 操作封装：busy → 执行 → notice + emit changed / 失败 err */
async function wrap(fn: () => Promise<void>, okMsg: string) {
  if (busy.value) return
  busy.value = true
  err.value = ''
  notice.value = ''
  try {
    await fn()
    notice.value = okMsg
    emit('changed')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
function normBrand(v: unknown): BrandConfig {
  return isObj(v) ? (v as BrandConfig) : {}
}

// ---------- 公共表单状态（水印参数 + 片头尾开关 + 字幕样式） ----------

const WM_POSITIONS: Array<{ v: WatermarkPosition; t: string }> = [
  { v: 'tl', t: '左上' },
  { v: 'tc', t: '上中' },
  { v: 'tr', t: '右上' },
  { v: 'ml', t: '左中' },
  { v: 'mc', t: '正中' },
  { v: 'mr', t: '右中' },
  { v: 'bl', t: '左下' },
  { v: 'bc', t: '下中' },
  { v: 'br', t: '右下' },
]

const wmEnabled = ref(true)
const wmPosition = ref<WatermarkPosition>('br')
const wmOpacity = ref(90) // 显示 %（存储 0.05–1）
const wmWidth = ref(15) // 显示 %（存储 0.03–0.5）
const wmMargin = ref(24)

const introEnabled = ref(true)
const outroEnabled = ref(true)

/** 存储值 → 显示百分比（容忍脏数据） */
function pctShow(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? +(v * 100).toFixed(3) : fallback
}
/** 显示百分比 → 存储值（前端温和 clamp，服务端硬 clamp 兜底） */
function pctStore(v: number, lo: number, hi: number): number {
  const c = Math.min(hi, Math.max(lo, Number(v) || 0))
  return Number((c / 100).toFixed(5))
}
function posOf(v: unknown): WatermarkPosition {
  return WM_POSITIONS.some((p) => p.v === v) ? (v as WatermarkPosition) : 'br'
}
function marginOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(200, Math.max(0, v))) : 24
}

/** 字幕样式表单（与服务端 buildSubtitleStyle 公式基线一致的展示默认值） */
const SUB_DEFAULTS = {
  font: 'Noto Sans CJK SC',
  size: 1.8,
  color: '#FFFFFF',
  outlineColor: '#000000',
  outline: 0.09,
  shadow: 0,
  marginV: 2,
  alignment: 2 as 2 | 5 | 8,
  bold: false,
}
const subOn = ref(false)
const subFont = ref(SUB_DEFAULTS.font)
const subSize = ref(SUB_DEFAULTS.size)
const subColor = ref(SUB_DEFAULTS.color)
const subOutlineColor = ref(SUB_DEFAULTS.outlineColor)
const subOutline = ref(SUB_DEFAULTS.outline)
const subShadow = ref(SUB_DEFAULTS.shadow)
const subMarginV = ref(SUB_DEFAULTS.marginV)
const subAlign = ref<2 | 5 | 8>(SUB_DEFAULTS.alignment)
const subBold = ref(SUB_DEFAULTS.bold)
const subPersisted = ref(false)

function fillSubForm(s: SubtitleStyleConfig | null | undefined) {
  const cfg = s && typeof s === 'object' ? s : undefined
  subPersisted.value = !!cfg
  subOn.value = !!cfg
  subFont.value = typeof cfg?.font === 'string' && cfg.font ? cfg.font : SUB_DEFAULTS.font
  subSize.value = pctShow(cfg?.size_pct, SUB_DEFAULTS.size)
  subColor.value = typeof cfg?.color === 'string' ? cfg.color : SUB_DEFAULTS.color
  subOutlineColor.value = typeof cfg?.outline_color === 'string' ? cfg.outline_color : SUB_DEFAULTS.outlineColor
  subOutline.value = pctShow(cfg?.outline_pct, SUB_DEFAULTS.outline)
  subShadow.value = typeof cfg?.shadow === 'number' && Number.isFinite(cfg.shadow) ? cfg.shadow : SUB_DEFAULTS.shadow
  subMarginV.value = pctShow(cfg?.margin_v_pct, SUB_DEFAULTS.marginV)
  subAlign.value = cfg?.alignment === 5 || cfg?.alignment === 8 ? cfg.alignment : 2
  subBold.value = cfg?.bold === true
}

function collectSub(): SubtitleStyleConfig {
  return {
    font: subFont.value.trim() || undefined,
    size_pct: pctStore(subSize.value, 0.8, 6),
    color: subColor.value,
    outline_color: subOutlineColor.value,
    outline_pct: pctStore(subOutline.value, 0, 0.5),
    shadow: Math.round(Math.min(8, Math.max(0, Number(subShadow.value) || 0))),
    margin_v_pct: pctStore(subMarginV.value, 0, 10),
    alignment: subAlign.value,
    bold: subBold.value,
  }
}

/** 从品牌配置回填公共表单（platform/project） */
function fillCommon(b: BrandConfig) {
  wmEnabled.value = b.watermark ? b.watermark.enabled !== false : true
  wmPosition.value = posOf(b.watermark?.position)
  wmOpacity.value = pctShow(b.watermark?.opacity, 90)
  wmWidth.value = pctShow(b.watermark?.width_pct, 15)
  wmMargin.value = marginOf(b.watermark?.margin_px)
  introEnabled.value = b.intro ? b.intro.enabled !== false : true
  outroEnabled.value = b.outro ? b.outro.enabled !== false : true
  fillSubForm(b.subtitle && typeof b.subtitle === 'object' ? b.subtitle : undefined)
}

// ---------- platform scope 状态 ----------

const platformBrand = ref<BrandConfig>({})
const wmFile = ref('')
const introFile = ref('')
const outroFile = ref('')
const previewTs = ref<Record<BrandSlotKey, number>>({ watermark: 0, intro: 0, outro: 0 })
const previewBroken = ref<Record<BrandSlotKey, boolean>>({ watermark: false, intro: false, outro: false })

function fileOf(b: BrandConfig, slot: BrandSlotKey): string {
  const f = b[slot]?.file
  return typeof f === 'string' ? f : ''
}

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

// ---------- project scope 状态 ----------

const projectSettings = ref<Record<string, unknown>>({})
const projectBrand = ref<BrandConfig>({})
const imgAssets = ref<Asset[]>([])
const vidAssets = ref<Asset[]>([])
const wmAssetId = ref(0) // 0 = 不使用项目资产
const introAssetId = ref(0)
const outroAssetId = ref(0)

const assetName = (id: number): string => {
  const a = [...imgAssets.value, ...vidAssets.value].find((it) => it.id === id)
  return a ? `#${a.id} ${a.name}` : `#${id}`
}
const assetFileUrl = (id: number): string => {
  const a = [...imgAssets.value, ...vidAssets.value].find((it) => it.id === id)
  return a?.urls.file ?? ''
}

async function refreshProjectAssets() {
  const pid = props.projectId ?? 0
  if (pid <= 0) return
  const [imgs, vids] = await Promise.all([
    projectApi.assets(pid, '?kind=image&limit=200'),
    projectApi.assets(pid, '?kind=video&limit=200'),
  ])
  imgAssets.value = imgs.items
  vidAssets.value = vids.items
}

// ---------- run scope 状态 ----------

const runBrand = ref<BrandConfig>({})
const inheritBrand = ref<BrandConfig>({})
const wmMode = ref<'inherit' | 'off' | 'custom'>('inherit')
const introMode = ref<'inherit' | 'off' | 'on'>('inherit')
const outroMode = ref<'inherit' | 'off' | 'on'>('inherit')
const wmAssetIdRun = ref(0) // 0 = 继承

/** 前端镜像 mergeBrand：槽内字段级浅合并（展示用） */
function mergeFront(...layers: unknown[]): BrandConfig {
  const out: BrandConfig = {}
  for (const layer of layers) {
    if (!isObj(layer)) continue
    const l = layer as BrandConfig
    if (isObj(l.subtitle)) out.subtitle = { ...out.subtitle, ...l.subtitle }
    if (isObj(l.watermark)) out.watermark = { ...out.watermark, ...l.watermark }
    if (isObj(l.intro)) out.intro = { ...out.intro, ...l.intro }
    if (isObj(l.outro)) out.outro = { ...out.outro, ...l.outro }
  }
  return out
}

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

// ---------- 加载 ----------

async function loadPlatform() {
  const s = await settingsApi.list()
  const raw = s.items.find((it) => it.key === 'brand')?.value
  const b = normBrand(raw)
  applyPlatformBrand(b)
  fillCommon(b)
}

async function loadProject() {
  const pid = props.projectId ?? 0
  const p = await projectApi.detail(pid)
  const settings = (p.project.settings ?? {}) as Record<string, unknown>
  projectSettings.value = settings
  const b = normBrand(settings.brand)
  projectBrand.value = b
  wmAssetId.value = typeof b.watermark?.asset_id === 'number' ? b.watermark.asset_id : 0
  introAssetId.value = typeof b.intro?.asset_id === 'number' ? b.intro.asset_id : 0
  outroAssetId.value = typeof b.outro?.asset_id === 'number' ? b.outro.asset_id : 0
  // [M20 fix] project scope 也需设置文件路径，否则预览 wmFile/introFile/outroFile 永远为空
  wmFile.value = fileOf(b, 'watermark')
  introFile.value = fileOf(b, 'intro')
  outroFile.value = fileOf(b, 'outro')
  fillCommon(b)
  await refreshProjectAssets()
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
      if (a.kind !== want) throw new Error(`${label}需${want === 'image' ? '图片' : '视频'}文件（得到 ${a.kind}）`)
      await refreshProjectAssets()
      if (slot === 'watermark') wmAssetId.value = a.id
      else if (slot === 'intro') introAssetId.value = a.id
      else outroAssetId.value = a.id
    }, `${label}已上传并选中（保存后生效）`)
  }
}

const SLOT_TEXT: Record<BrandSlotKey, string> = { watermark: '水印', intro: '片头', outro: '片尾' }

function clearSlot(slot: BrandSlotKey) {
  void wrap(async () => {
    const r = await brandAssetApi.clear(slot)
    applyPlatformBrand(r.brand, slot)
  }, `${SLOT_TEXT[slot]}引用已清除（磁盘文件保留；重新合成后生效）`)
}

// ---------- 保存 ----------

/** platform 槽保存（读-合并写 settings.brand 整体） */
function savePlatformSlot(slot: 'watermark' | 'intro' | 'outro') {
  void wrap(async () => {
    const next = JSON.parse(JSON.stringify(platformBrand.value)) as BrandConfig
    if (slot === 'watermark') {
      const wm: WatermarkConfig = {
        ...(next.watermark ?? {}),
        position: wmPosition.value,
        opacity: pctStore(wmOpacity.value, 5, 100),
        width_pct: pctStore(wmWidth.value, 3, 50),
        margin_px: Math.round(Math.min(200, Math.max(0, Number(wmMargin.value) || 0))),
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
  void wrap(async () => {
    const next = JSON.parse(JSON.stringify(platformBrand.value)) as BrandConfig
    if (clearing) {
      delete next.subtitle
      subPersisted.value = false
    } else {
      next.subtitle = collectSub()
      subPersisted.value = true
    }
    await settingsApi.put('brand', next)
    platformBrand.value = next
  }, clearing ? '平台字幕样式已清除（回落默认基线）' : '平台字幕样式已保存（重新合成后生效）')
}

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
        margin_px: Math.round(Math.min(200, Math.max(0, Number(wmMargin.value) || 0))),
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
  void wrap(async () => {
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
  }, clearing ? '项目字幕样式已清除（回落平台/默认）' : '项目字幕样式已保存（重新合成后生效）')
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

// ---------- 派生 ----------

/** run 模式：水印参数控件可编辑性（仅自定义模式） */
const wmParamsDisabled = computed(() => busy.value || (props.scope === 'run' && wmMode.value !== 'custom'))
/** 保存按钮文案（run 水印） */
const runWmBtnText = computed(() => (wmMode.value === 'inherit' ? '清除覆盖（用继承）' : '保存覆盖'))

// [M20] 表单 → 预览实时联动：监听所有表单字段，变化时 emit preview 供父组件 BrandPreview 即时渲染
const formWatchSrc = computed(() => ({
  sub: { on: subOn.value, font: subFont.value, size: subSize.value, color: subColor.value, outlineColor: subOutlineColor.value, outline: subOutline.value, shadow: subShadow.value, marginV: subMarginV.value, align: subAlign.value, bold: subBold.value },
  wm: { enabled: wmEnabled.value, position: wmPosition.value, opacity: wmOpacity.value, width: wmWidth.value, margin: wmMargin.value },
  intro: introEnabled.value,
  outro: outroEnabled.value,
  wmFile: wmFile.value,
  introFile: introFile.value,
  outroFile: outroFile.value,
  // [M20 fix2] 项目资产来源纳入监听：选择/切换项目资产（asset_id）时预览才会更新
  wmAssetId: wmAssetId.value,
  introAssetId: introAssetId.value,
  outroAssetId: outroAssetId.value,
}))
watch(formWatchSrc, (v) => {
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
    margin_px: Math.round(Math.min(200, Math.max(0, Number(v.wm.margin) || 0))),
  }
  // [M20 fix2] 项目资产来源：asset_id 优先于 file（镜像服务端 resolveMaterialPath 语义）
  if (v.wmAssetId > 0) brand.watermark.asset_id = v.wmAssetId
  if (!v.wm.enabled) brand.watermark.enabled = false
  brand.intro = { enabled: v.intro, file: v.introFile || undefined }
  if (v.introAssetId > 0) brand.intro.asset_id = v.introAssetId
  brand.outro = { enabled: v.outro, file: v.outroFile || undefined }
  if (v.outroAssetId > 0) brand.outro.asset_id = v.outroAssetId
  emit('preview', { brand, wmFile: v.wmFile })
}, { deep: true })

/** 片头/片尾覆盖模式读写（v-for 内 v-model 不能写三元表达式，改 checked + change） */
function clipModeOf(slot: 'intro' | 'outro'): 'inherit' | 'off' | 'on' {
  return slot === 'intro' ? introMode.value : outroMode.value
}
function setClipMode(slot: 'intro' | 'outro', mode: 'inherit' | 'off' | 'on') {
  if (slot === 'intro') introMode.value = mode
  else outroMode.value = mode
}
</script>

<template>
  <div class="bs">
    <div v-if="loading" class="muted">加载中…</div>
    <template v-else>
      <!-- ===== 字幕样式（platform / project） ===== -->
      <section v-if="scope !== 'run'" class="bs-sec">
        <div class="bs-h">
          <Icon name="pencil" :size="12" />
          <span>字幕样式</span>
          <span class="muted bs-tip">{{ scope === 'platform' ? '平台默认（项目与 run 可覆盖）' : '项目覆盖（run 可覆盖）' }}；未配置时用默认基线（字号 1.8% 高 / 底边距 2%）</span>
        </div>
        <label class="bs-ck">
          <input v-model="subOn" type="checkbox" :disabled="busy" />
          <span class="muted">启用自定义字幕样式</span>
        </label>
        <div class="st-grid" :class="{ off: !subOn }">
          <div class="bs-row">
            <span class="bs-lb">字体</span>
            <input v-model="subFont" type="text" class="bs-txt grow" spellcheck="false" placeholder="Noto Sans CJK SC" :disabled="busy || !subOn" />
          </div>
          <div class="bs-row">
            <span class="bs-lb">字号</span>
            <input v-model.number="subSize" type="number" class="bs-num" min="0.8" max="6" step="0.1" :disabled="busy || !subOn" />
            <span class="muted">%</span>
            <span class="bs-lb bs-lb-2">描边</span>
            <input v-model.number="subOutline" type="number" class="bs-num" min="0" max="0.5" step="0.01" :disabled="busy || !subOn" />
            <span class="muted">%</span>
            <span class="bs-lb bs-lb-2">阴影</span>
            <input v-model.number="subShadow" type="number" class="bs-num" min="0" max="8" step="1" :disabled="busy || !subOn" />
          </div>
          <div class="bs-row">
            <span class="bs-lb">字色</span>
            <input v-model="subColor" type="color" class="bs-color" :disabled="busy || !subOn" />
            <span class="muted mono">{{ subColor.toUpperCase() }}</span>
            <span class="bs-lb bs-lb-2">描边色</span>
            <input v-model="subOutlineColor" type="color" class="bs-color" :disabled="busy || !subOn" />
            <span class="muted mono">{{ subOutlineColor.toUpperCase() }}</span>
          </div>
          <div class="bs-row">
            <span class="bs-lb">底边距</span>
            <input v-model.number="subMarginV" type="number" class="bs-num" min="0" max="10" step="0.5" :disabled="busy || !subOn" />
            <span class="muted">%</span>
            <span class="bs-lb bs-lb-2">对齐</span>
            <select v-model.number="subAlign" class="bs-sel" :disabled="busy || !subOn">
              <option :value="2">底部居中</option>
              <option :value="5">中部居中</option>
              <option :value="8">顶部居中</option>
            </select>
            <label class="bs-ck bs-ck-in">
              <input v-model="subBold" type="checkbox" :disabled="busy || !subOn" /> <span class="muted">加粗</span>
            </label>
          </div>
        </div>
        <div class="bs-row">
          <button
            class="btn sm"
            :class="{ primary: subOn }"
            :disabled="busy || (!subOn && !subPersisted)"
            @click="scope === 'platform' ? savePlatformSubtitle() : saveProjectSubtitle()"
          >
            <Icon name="check" :size="12" /> {{ subOn ? '保存样式' : '清除样式（用默认/继承）' }}
          </button>
          <span class="muted bs-tip">保存后重新合成生效</span>
        </div>
      </section>

      <!-- ===== 水印 ===== -->
      <section class="bs-sec">
        <div class="bs-h">
          <Icon name="imageplus" :size="12" />
          <span>水印</span>
          <span class="muted bs-tip">
            {{ scope === 'platform' ? '平台水印（推荐 PNG 透明底；项目/run 可覆盖来源）' : scope === 'project' ? '项目水印（从项目图片资产选择，覆盖平台来源）' : 'run 级覆盖（叠加于字幕之上，呈现最顶层）' }}
          </span>
        </div>

        <!-- 来源：平台上传 -->
        <template v-if="scope === 'platform'">
          <div class="bs-row">
            <img
              v-if="wmFile && !previewBroken.watermark"
              class="bs-wm"
              :src="brandAssetApi.fileUrl('watermark', previewTs.watermark)"
              alt="水印预览"
              @error="onPreviewErr('watermark')"
              @load="previewBroken.watermark = false"
            />
            <span v-if="wmFile" class="muted bs-file" :title="wmFile">{{ wmFile }}</span>
            <span v-else class="muted">未上传水印图片</span>
            <span class="grow" />
            <button class="btn sm" :disabled="busy" @click="pickFile('watermark')">
              <Icon name="upload" :size="12" /> {{ wmFile ? '替换' : '上传图片' }}
            </button>
            <button v-if="wmFile" class="btn sm danger" :disabled="busy" @click="clearSlot('watermark')">
              <Icon name="trash" :size="12" /> 清除
            </button>
          </div>
        </template>

        <!-- 来源：项目资产 -->
        <template v-else-if="scope === 'project'">
          <div class="bs-row">
            <img v-if="wmAssetId > 0 && !previewBroken.watermark" class="bs-wm" :src="assetFileUrl(wmAssetId)" alt="水印预览" @error="onPreviewErr('watermark')" @load="previewBroken.watermark = false" />
            <span class="bs-lb">素材</span>
            <select v-model.number="wmAssetId" class="bs-sel grow" :disabled="busy">
              <option :value="0">不使用项目资产（回落平台文件）</option>
              <option v-for="a in imgAssets" :key="a.id" :value="a.id">#{{ a.id }} {{ a.name }}</option>
            </select>
            <button class="btn sm" :disabled="busy" @click="pickFile('watermark')">
              <Icon name="upload" :size="12" /> 上传图片
            </button>
          </div>
        </template>

        <!-- 来源：run 三态覆盖 -->
        <template v-else>
          <div class="bs-row bs-radios" role="radiogroup" aria-label="水印覆盖模式">
            <label class="bs-radio"><input v-model="wmMode" type="radio" value="inherit" :disabled="busy" /> 继承</label>
            <label class="bs-radio"><input v-model="wmMode" type="radio" value="off" :disabled="busy" /> 禁用</label>
            <label class="bs-radio"><input v-model="wmMode" type="radio" value="custom" :disabled="busy" /> 自定义</label>
          </div>
          <div class="muted bs-tip">{{ inheritSummary('watermark') }}</div>
          <div class="muted bs-tip">{{ inheritWmParams() }}</div>
          <div v-if="wmMode === 'custom'" class="bs-row">
            <span class="bs-lb">素材</span>
            <select v-model.number="wmAssetIdRun" class="bs-sel grow" :disabled="busy">
              <option :value="0">继承项目/平台素材</option>
              <option v-for="a in imgAssets" :key="a.id" :value="a.id">#{{ a.id }} {{ a.name }}</option>
            </select>
          </div>
        </template>

        <!-- 参数（三 scope 共用；run 仅自定义时可编辑） -->
        <div class="bs-row" :class="{ dim: scope === 'run' && wmMode !== 'custom' }">
          <span class="bs-lb">位置</span>
          <select v-model="wmPosition" class="bs-sel" :disabled="wmParamsDisabled">
            <option v-for="p in WM_POSITIONS" :key="p.v" :value="p.v">{{ p.t }}</option>
          </select>
          <span class="bs-lb bs-lb-2">透明度</span>
          <input v-model.number="wmOpacity" type="number" class="bs-num" min="5" max="100" step="5" :disabled="wmParamsDisabled" />
          <span class="muted">%</span>
          <span class="bs-lb bs-lb-2">宽度</span>
          <input v-model.number="wmWidth" type="number" class="bs-num" min="3" max="50" step="1" :disabled="wmParamsDisabled" />
          <span class="muted">%</span>
          <span class="bs-lb bs-lb-2">边距</span>
          <input v-model.number="wmMargin" type="number" class="bs-num" min="0" max="200" step="4" :disabled="wmParamsDisabled" />
          <span class="muted">px</span>
        </div>

        <div class="bs-row">
          <label class="bs-ck" v-if="scope !== 'run'">
            <input v-model="wmEnabled" type="checkbox" :disabled="busy" />
            <span class="muted">启用（需有素材来源才生效）</span>
          </label>
          <span class="grow" />
          <button
            v-if="scope === 'platform'"
            class="btn sm primary"
            :disabled="busy"
            @click="savePlatformSlot('watermark')"
          >
            <Icon name="check" :size="12" /> 保存水印设置
          </button>
          <button
            v-else-if="scope === 'project'"
            class="btn sm primary"
            :disabled="busy"
            @click="saveProjectSlot('watermark')"
          >
            <Icon name="check" :size="12" /> 保存项目水印
          </button>
          <button
            v-else
            class="btn sm"
            :class="{ primary: wmMode !== 'inherit' }"
            :disabled="busy"
            @click="saveRunWatermark"
          >
            <Icon name="check" :size="12" /> {{ runWmBtnText }}
          </button>
        </div>
      </section>

      <!-- ===== 片头 / 片尾（结构同构，逐槽渲染） ===== -->
      <section v-for="slot in (['intro', 'outro'] as const)" :key="slot" class="bs-sec">
        <div class="bs-h">
          <Icon :name="slot === 'intro' ? 'film' : 'flag'" :size="12" />
          <span>{{ slot === 'intro' ? '片头' : '片尾' }}</span>
          <span class="muted bs-tip">
            {{ scope === 'platform' ? '平台视频（拼接于正片前后；时长 ffprobe，音轨丢弃）' : scope === 'project' ? '项目视频资产（覆盖平台来源）' : 'run 级覆盖（继承 / 禁用 / 强制启用）' }}
          </span>
        </div>

        <!-- 来源：平台上传 -->
        <template v-if="scope === 'platform'">
          <div class="bs-row">
            <video
              v-if="(slot === 'intro' ? introFile : outroFile) && !previewBroken[slot]"
              class="bs-video"
              :src="brandAssetApi.fileUrl(slot, previewTs[slot])"
              controls
              preload="metadata"
              @error="onPreviewErr(slot)"
            />
            <span v-if="slot === 'intro' ? introFile : outroFile" class="muted bs-file" :title="introFile || outroFile">
              {{ slot === 'intro' ? introFile : outroFile }}
            </span>
            <span v-else class="muted">未上传{{ slot === 'intro' ? '片头' : '片尾' }}视频</span>
            <span class="grow" />
            <button class="btn sm" :disabled="busy" @click="pickFile(slot)">
              <Icon name="upload" :size="12" /> {{ (slot === 'intro' ? introFile : outroFile) ? '替换' : '上传视频' }}
            </button>
            <button v-if="slot === 'intro' ? introFile : outroFile" class="btn sm danger" :disabled="busy" @click="clearSlot(slot)">
              <Icon name="trash" :size="12" /> 清除
            </button>
          </div>
        </template>

        <!-- 来源：项目资产 -->
        <template v-else-if="scope === 'project'">
          <div class="bs-row">
            <span class="bs-lb">素材</span>
            <select v-if="slot === 'intro'" v-model.number="introAssetId" class="bs-sel grow" :disabled="busy">
              <option :value="0">不使用项目资产（回落平台文件）</option>
              <option v-for="a in vidAssets" :key="a.id" :value="a.id">#{{ a.id }} {{ a.name }}</option>
            </select>
            <select v-else v-model.number="outroAssetId" class="bs-sel grow" :disabled="busy">
              <option :value="0">不使用项目资产（回落平台文件）</option>
              <option v-for="a in vidAssets" :key="a.id" :value="a.id">#{{ a.id }} {{ a.name }}</option>
            </select>
            <button class="btn sm" :disabled="busy" @click="pickFile(slot)">
              <Icon name="upload" :size="12" /> 上传视频
            </button>
          </div>
        </template>

        <!-- 来源：run 三态覆盖 -->
        <template v-else>
          <div class="bs-row bs-radios" role="radiogroup" :aria-label="`${slot === 'intro' ? '片头' : '片尾'}覆盖模式`">
            <label class="bs-radio"><input type="radio" :checked="clipModeOf(slot) === 'inherit'" :disabled="busy" @change="setClipMode(slot, 'inherit')" /> 继承</label>
            <label class="bs-radio"><input type="radio" :checked="clipModeOf(slot) === 'off'" :disabled="busy" @change="setClipMode(slot, 'off')" /> 禁用</label>
            <label class="bs-radio"><input type="radio" :checked="clipModeOf(slot) === 'on'" :disabled="busy" @change="setClipMode(slot, 'on')" /> 强制启用</label>
          </div>
          <div class="muted bs-tip">{{ inheritSummary(slot) }}</div>
        </template>

        <div class="bs-row">
          <label class="bs-ck" v-if="scope !== 'run'">
            <input
              v-if="slot === 'intro'"
              v-model="introEnabled"
              type="checkbox"
              :disabled="busy"
            />
            <input v-else v-model="outroEnabled" type="checkbox" :disabled="busy" />
            <span class="muted">启用（需有素材来源才生效）</span>
          </label>
          <span class="grow" />
          <button
            v-if="scope === 'platform'"
            class="btn sm primary"
            :disabled="busy"
            @click="savePlatformSlot(slot)"
          >
            <Icon name="check" :size="12" /> 保存{{ slot === 'intro' ? '片头' : '片尾' }}设置
          </button>
          <button
            v-else-if="scope === 'project'"
            class="btn sm primary"
            :disabled="busy"
            @click="saveProjectSlot(slot)"
          >
            <Icon name="check" :size="12" /> 保存项目{{ slot === 'intro' ? '片头' : '片尾' }}
          </button>
          <button
            v-else
            class="btn sm"
            :class="{ primary: (slot === 'intro' ? introMode : outroMode) !== 'inherit' }"
            :disabled="busy"
            @click="saveRunClip(slot)"
          >
            <Icon name="check" :size="12" />
            {{ (slot === 'intro' ? introMode : outroMode) === 'inherit' ? '清除覆盖（用继承）' : '保存覆盖' }}
          </button>
        </div>
      </section>

      <input
        ref="fileInput"
        type="file"
        class="bs-fileinput"
        :accept="pendingSlot === 'watermark' ? 'image/*' : 'video/*'"
        @change="onFilePicked"
      />

      <div v-if="err" class="err-text">{{ err }}</div>
      <div v-if="notice" class="bs-notice"><Icon name="check" :size="12" /> {{ notice }}</div>
    </template>
  </div>
</template>

<style scoped>
.bs {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 13px;
}

.bs-sec {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 11px 13px;
}

.bs-h {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 12.5px;
}

.bs-tip {
  font-weight: 400;
  font-size: 11.5px;
}

.bs-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.bs-row.dim {
  opacity: 0.5;
}

.grow {
  flex: 1;
  min-width: 0;
}

.bs-lb {
  min-width: 44px;
  font-size: 12px;
  color: var(--text-2);
  flex: none;
}

.bs-lb-2 {
  margin-left: 10px;
}

.bs-ck {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
}

.bs-ck-in {
  margin-left: 10px;
}

.bs-radios {
  gap: 16px;
}

.bs-radio {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  font-size: 12.5px;
}

.bs-file {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
}

.bs-wm {
  width: 46px;
  height: 26px;
  object-fit: contain;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: repeating-conic-gradient(rgb(148 163 184 / 18%) 0% 25%, transparent 0% 50%) 0 0 / 10px 10px;
  flex: none;
}

.bs-video {
  width: 150px;
  height: 84px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #000;
  flex: none;
}

.bs-txt {
  /* 覆盖全局 input width:100%（行内伸缩布局） */
  width: auto;
  min-width: 180px;
  padding: 3px 8px;
  font-size: 12.5px;
}

.bs-num {
  /* 覆盖全局 input width:100% */
  width: 68px;
  padding: 3px 7px;
  font-size: 12.5px;
  flex: none;
}

.bs-sel {
  /* 覆盖全局 select width:100%：按内容宽收缩（grow 时占满） */
  width: auto;
  max-width: 260px;
  padding: 3px 8px;
  font-size: 12.5px;
}

.bs-color {
  width: 34px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: none;
  cursor: pointer;
  flex: none;
}

.bs-fileinput {
  display: none;
}

.bs-notice {
  display: flex;
  align-items: center;
  gap: 7px;
  background: var(--ok-weak);
  color: var(--ok);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12.5px;
}

/* 字幕样式表单（与合成弹窗同构） */
.st-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  transition: opacity 0.15s;
}

.st-grid.off {
  opacity: 0.55;
}

.bs-sel.grow {
  max-width: none;
}
</style>
