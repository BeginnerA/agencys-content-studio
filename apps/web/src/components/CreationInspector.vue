<script setup lang="ts">
/**
 * [M16] 创作画布检查器（spec §2.6；交互体例对齐 M15 CanvasDrawer）
 * - gen 节点：spec 表单（genKind/prompt/尺寸/端点覆盖/编辑模式）+ 执行（表单先自动保存）· 取消
 *   + 就绪度问题 / 编辑能力提示 / 任务历史（≤5）/ 结果预览 / 入边出边管理
 * - asset 节点：预览 / 改名 / 删除
 * - 边选中：端点信息 + 断开
 * - 蒙版编辑器（EditBrushModal）内联；「设为实体参考图」内联面板；所有操作 emit refresh 由父级全量重拉
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type {
  AnyNodeSpec, Asset, CanvasAssetLite, CanvasDocEdge, CanvasDocNode, CanvasEditMode, CanvasGenTaskLite,
  CanvasResultItem, ComposeTransition, CreationNodeSpec, EntityItem, EntityKind, GenKind, NodeSpecEdit, TextNodeSpec,
} from '../lib/types'
import { assetApi, creationApi, entityApi, runApi, taskApi, type CanvasNodePatch } from '../lib/api'
import { confirmDialog } from '../lib/confirm'
import { fmtMs, fmtTime, KIND_TEXT, purposeText } from '../lib/format'
import AssetPreviewer from './AssetPreviewer.vue'
import EditBrushModal from './EditBrushModal.vue'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

const props = defineProps<{
  node: CanvasDocNode | null
  edge: CanvasDocEdge | null
  nodes: CanvasDocNode[]
  edges: CanvasDocEdge[]
  canvasId: number
  projectId: number
  /** [M17] 写命令回调（View 执行 + 入撤销栈；await 返回即已落库） */
  applyPatch: (p: { id: number; patch: CanvasNodePatch; label: string }) => Promise<void>
  applyRun: (p: { id: number; variants: number; savePatch?: CanvasNodePatch }) => Promise<void>
  applyExtract: (id: number) => Promise<void>
  applyDelete: () => Promise<void>
  applyRemoveEdge: (id: number) => Promise<void>
}>()
const emit = defineEmits<{ refresh: []; clear: []; notice: [msg: string] }>()
const router = useRouter()

const opErr = ref('')
const opBusy = ref(false)

// ===== 通用文案 =====
const TASK_TEXT: Record<string, string> = { pending: '等待', processing: '生成中', succeeded: '成功', failed: '失败', cancelled: '已取消' }
const TASK_CLS: Record<string, string> = { pending: 'pending', processing: 'processing', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled' }
const PORT_TEXT: Record<string, string> = { reference: '参考图', first_frame: '首帧', last_frame: '尾帧', source: '源图（编辑底图）' }
const EDIT_MODE_TEXT: Record<CanvasEditMode, string> = { inpaint: '局部重绘', erase: '消除', outpaint: '扩图' }
/** [M18] 转场中文标签（TRANSITIONS 枚举，与服务端 / M11 ComposeConfig 同源） */
const TRANSITION_OPTIONS: Array<{ value: ComposeTransition; label: string }> = [
  { value: 'none', label: '无（硬切）' },
  { value: 'fade', label: '淡入淡出' },
  { value: 'fadeblack', label: '渐黑过渡' },
  { value: 'slideleft', label: '左滑入' },
  { value: 'slideright', label: '右滑入' },
  { value: 'dissolve', label: '溶解' },
]
const ENT_KIND_LABEL: Record<EntityKind, string> = { character: '角色', scene: '场景', prop: '道具' }
/** [M17] 实体类型文案（实体摘要 kind 为宽 string，兜底原值） */
function entKindText(k: string): string {
  return ENT_KIND_LABEL[k as EntityKind] ?? k
}
/** [M17] run 节点状态映射（pipeline_runs.status） */
const RUN_TEXT: Record<string, string> = { queued: '排队', running: '运行中', waiting_input: '待输入', completed: '完成', failed: '失败', cancelled: '已取消' }
const RUN_CLS: Record<string, string> = { queued: 'pending', running: 'processing', waiting_input: 'pending', completed: 'succeeded', failed: 'failed', cancelled: 'cancelled' }
const RUN_TERMINAL = new Set(['completed', 'failed', 'cancelled'])

function stText(s: string | null): string {
  return s && s !== 'idle' ? (TASK_TEXT[s] ?? s) : ''
}
function stCls(s: string | null): string | undefined {
  return s ? (TASK_CLS[s] ?? 'pending') : undefined
}
/** [M17] spec 类型守卫：是否 gen 规范（含 genKind；spec 已扩为 AnyNodeSpec 联合） */
function asGenSpec(s: AnyNodeSpec | null | undefined): CreationNodeSpec | null {
  return s && typeof s === 'object' && 'genKind' in s ? (s as CreationNodeSpec) : null
}
/** [M17] spec 类型守卫：是否文本规范（含 text） */
function asTextSpec(s: AnyNodeSpec | null | undefined): TextNodeSpec | null {
  return s && typeof s === 'object' && 'text' in s ? (s as TextNodeSpec) : null
}
/** [M17] gen 规范视图（模板/守卫通用；非 gen 节点为 null） */
const genSpec = computed<CreationNodeSpec | null>(() => asGenSpec(props.node?.spec))
/** [M17] run 节点可取消（有 run 且非终态） */
const canCancelRun = computed<boolean>(() => {
  const r = props.node?.run
  return !!r && !RUN_TERMINAL.has(r.status)
})
/** [M17] 就绪度 notes（实体截断/降级提示） */
const readinessNotes = computed<string[]>(() => props.node?.readiness?.notes ?? [])
/** [M17] 节点副标题文案（五型全覆盖） */
function kindLabel(n: CanvasDocNode): string {
  switch (n.kind) {
    case 'asset': return '素材'
    case 'text': return '文本'
    case 'entity': return '实体'
    case 'run': return '运行'
    default: {
      const gk = asGenSpec(n.spec)?.genKind
      if (gk === 'video') return '视频生成'
      if (gk === 'audio') return '音频生成'
      if (gk === 'compose') return '音视频合成'
      if (gk === 'llm') return 'LLM 文本处理'
      return '图片生成'
    }
  }
}
function nodeIcon(n: CanvasDocNode): string {
  if (n.kind === 'asset') return 'photo'
  if (n.kind === 'text') return 'doc'
  if (n.kind === 'entity') return 'users'
  if (n.kind === 'run') return 'play'
  const s = asGenSpec(n.spec)
  if (!s) return 'alert'
  if (s.edit) return 'brush'
  if (s.genKind === 'video') return 'video'
  if (s.genKind === 'audio') return 'speaker-wave'
  if (s.genKind === 'compose') return 'film'
  if (s.genKind === 'llm') return 'sparkles'
  return 'photo'
}
function assetThumb(a: CanvasAssetLite | null): string | null {
  if (!a) return null
  return a.urls.thumb ?? (a.kind === 'image' ? a.urls.file : null)
}
function nodeTitle(id: number): string {
  return props.nodes.find((n) => n.id === id)?.title ?? `节点 #${id}`
}

// ===== 标题改名 =====
const titleDraft = ref('')
const renaming = ref(false)
const titleEl = ref<HTMLInputElement | null>(null)

function startRename(): void {
  titleDraft.value = props.node?.title ?? ''
  renaming.value = true
  void nextTick(() => titleEl.value?.select())
}
async function saveTitle(): Promise<void> {
  const n = props.node
  if (!n || !renaming.value) return
  renaming.value = false
  const t = titleDraft.value.trim()
  if (!t || t === n.title) return
  opErr.value = ''
  try {
    await props.applyPatch({ id: n.id, patch: { title: t }, label: '节点改名' })
    emit('notice', '标题已更新')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  }
}

// ===== gen 节点：spec 表单 =====
const fGenKind = ref<GenKind>('image')
const fPrompt = ref('')
const fSize = ref('')
const fDuration = ref('')
const fResolution = ref('')
const fAspectRatio = ref('')
const fVoice = ref('')
const fSpeed = ref('')
const fFps = ref('')
const fProvider = ref('')
const fModel = ref('')
const fStyle = ref(true)
const fEditMode = ref<'' | CanvasEditMode>('')
const fAngle = ref('')
const fXScale = ref('')
const fYScale = ref('')
/** [M17] 执行变体数（1-4） */
const fVariants = ref(1)
/** [M17] text 节点文本表单 */
const fText = ref('')
/** [M18] compose：转场 token / 转场时长（字符串表单）/ BGM 资产（字符串表单）/ 音量 / 淡入淡出 */
const fTransition = ref<ComposeTransition>('none')
const fTransitionDuration = ref('')
const fBgmAssetId = ref('')
const fBgmVolume = ref('')
const fBgmFade = ref(true)
/** [M18] 抽帧：模式 / 指定时刻（秒）/ 忙锁 */
const frameMode = ref<'first' | 'last' | 'custom'>('first')
const frameTime = ref('')
const frameBusy = ref(false)
/** [M18] LLM 节点：采样温度 / 最大输出 token */
const fTemperature = ref('')
const fMaxTokens = ref('')

function formSnapshot(): string {
  return JSON.stringify({
    g: fGenKind.value, p: fPrompt.value, s: fSize.value, d: fDuration.value, r: fResolution.value,
    ar: fAspectRatio.value, vo: fVoice.value, sp: fSpeed.value, fp: fFps.value,
    pr: fProvider.value, m: fModel.value, st: fStyle.value, em: fEditMode.value,
    a: fAngle.value, xs: fXScale.value, ys: fYScale.value,
    tr: fTransition.value, td: fTransitionDuration.value, bg: fBgmAssetId.value, bv: fBgmVolume.value, bf: fBgmFade.value,
    tm: fTemperature.value, mt: fMaxTokens.value,
  })
}
let formBase = ''
const formTouched = ref(false)
// 实体挂接面板开合（node 变更 watch 会重置它，故必须先于该 watch 声明）
const entOpen = ref(false)

function fillForm(n: CanvasDocNode | null): void {
  const s = asGenSpec(n?.spec)
  fGenKind.value = s?.genKind ?? 'image'
  fPrompt.value = s?.prompt ?? ''
  fSize.value = s?.size ?? ''
  fDuration.value = s?.duration != null ? String(s.duration) : ''
  fResolution.value = s?.resolution ?? ''
  fAspectRatio.value = s?.aspectRatio ?? ''
  fVoice.value = s?.voice ?? ''
  fSpeed.value = s?.speed != null ? String(s.speed) : ''
  fFps.value = s?.fps != null ? String(s.fps) : ''
  fProvider.value = s?.provider ?? ''
  fModel.value = s?.model ?? ''
  fStyle.value = s?.useStylePreset !== false
  fEditMode.value = s?.edit?.mode ?? ''
  fAngle.value = s?.edit?.expand?.angle != null ? String(s.edit.expand.angle) : ''
  fXScale.value = s?.edit?.expand?.xScale != null ? String(s.edit.expand.xScale) : ''
  fYScale.value = s?.edit?.expand?.yScale != null ? String(s.edit.expand.yScale) : ''
  fTransition.value = s?.transition ?? 'none'
  fTransitionDuration.value = s?.transitionDuration != null ? String(s.transitionDuration) : ''
  fBgmAssetId.value = s?.bgmAssetId != null ? String(s.bgmAssetId) : ''
  fBgmVolume.value = s?.bgmVolume != null ? String(s.bgmVolume) : ''
  fBgmFade.value = s?.bgmFade !== false
  fTemperature.value = s?.temperature != null ? String(s.temperature) : ''
  fMaxTokens.value = s?.maxTokens != null ? String(s.maxTokens) : ''
  fVariants.value = 1
  fText.value = asTextSpec(n?.spec)?.text ?? ''
  formBase = formSnapshot()
  formTouched.value = false
}
watch(
  () => `${props.node?.id ?? ''}:${props.edge?.id ?? ''}`,
  () => {
    opErr.value = ''
    entOpen.value = false
    fillForm(props.node)
  },
  { immediate: true },
)
watch([fGenKind, fPrompt, fSize, fDuration, fResolution, fAspectRatio, fVoice, fSpeed, fFps, fProvider, fModel, fStyle, fEditMode, fAngle, fXScale, fYScale, fTransition, fTransitionDuration, fBgmAssetId, fBgmVolume, fBgmFade, fTemperature, fMaxTokens], () => {
  formTouched.value = formSnapshot() !== formBase
})

/** 组装 spec（over.maskAssetId 供蒙版保存直填；表单为空的可选项不落库） */
function buildSpec(over?: { maskAssetId?: number }): CreationNodeSpec {
  const gk = fGenKind.value
  const spec: CreationNodeSpec = { genKind: gk, prompt: gk === 'compose' ? '' : fPrompt.value.trim() }
  if (gk === 'image') {
    const size = fSize.value.trim()
    if (size) spec.size = size
  } else if (gk === 'video') {
    const duration = Number(fDuration.value)
    if (fDuration.value.trim() && Number.isFinite(duration) && duration > 0) spec.duration = duration
  } else if (gk === 'audio') {
    const voice = fVoice.value.trim()
    if (voice) spec.voice = voice
    const speed = Number(fSpeed.value)
    if (fSpeed.value.trim() && Number.isFinite(speed) && speed >= 0.25 && speed <= 4) spec.speed = speed
  } else if (gk === 'llm') {
    // [M18] LLM：温度 0-2（默认 0.7）、maxTokens 1-32000（默认 2048），为空不落库走服务端默认
    const tm = Number(fTemperature.value)
    if (fTemperature.value.trim() && Number.isFinite(tm) && tm >= 0 && tm <= 2) spec.temperature = tm
    const mt = Number(fMaxTokens.value)
    if (fMaxTokens.value.trim() && Number.isInteger(mt) && mt >= 1 && mt <= 32000) spec.maxTokens = mt
  } else {
    const fps = Number(fFps.value)
    if (fFps.value.trim() && Number.isFinite(fps) && fps > 0) spec.fps = fps
    // [M18] 转场（'none' 省略；时长仅转场启用时落库，0.1-2 服务端同规则）
    if (fTransition.value !== 'none') {
      spec.transition = fTransition.value
      const td = Number(fTransitionDuration.value)
      if (fTransitionDuration.value.trim() && Number.isFinite(td) && td >= 0.1 && td <= 2) spec.transitionDuration = td
    }
    // [M18] BGM（未选省略；音量/淡出仅 BGM 启用时落库，缺省走服务端）
    const ba = Number(fBgmAssetId.value)
    if (fBgmAssetId.value && Number.isInteger(ba) && ba > 0) {
      spec.bgmAssetId = ba
      const bv = Number(fBgmVolume.value)
      if (fBgmVolume.value.trim() && Number.isFinite(bv) && bv >= 0 && bv <= 1) spec.bgmVolume = bv
      if (!fBgmFade.value) spec.bgmFade = false
    }
  }
  if (gk !== 'audio') {
    const resolution = fResolution.value.trim()
    if (resolution) spec.resolution = resolution
  }
  if (gk === 'image' || gk === 'video') {
    const aspectRatio = fAspectRatio.value.trim()
    if (aspectRatio) spec.aspectRatio = aspectRatio
  }
  const provider = fProvider.value.trim()
  if (provider) spec.provider = provider
  const model = fModel.value.trim()
  if (model) spec.model = model
  if (gk === 'image' || gk === 'video') spec.useStylePreset = fStyle.value
  if (gk === 'image' && fEditMode.value) {
    const edit: NodeSpecEdit = { mode: fEditMode.value }
    if (fEditMode.value === 'outpaint') {
      const expand: { angle?: number; xScale?: number; yScale?: number } = {}
      const a = Number(fAngle.value)
      if (fAngle.value.trim() && Number.isFinite(a)) expand.angle = a
      const xs = Number(fXScale.value)
      if (fXScale.value.trim() && Number.isFinite(xs)) expand.xScale = xs
      const ys = Number(fYScale.value)
      if (fYScale.value.trim() && Number.isFinite(ys)) expand.yScale = ys
      if (Object.keys(expand).length) edit.expand = expand
    } else {
      const mid = over?.maskAssetId ?? asGenSpec(props.node?.spec)?.edit?.maskAssetId
      if (mid) edit.maskAssetId = mid
    }
    spec.edit = edit
  }
  return spec
}

async function saveSpec(): Promise<void> {
  const n = props.node
  if (!n) return
  opBusy.value = true
  opErr.value = ''
  try {
    await props.applyPatch({ id: n.id, patch: { spec: buildSpec() }, label: '保存参数' })
    emit('notice', 'spec 已保存')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

// ===== 蒙版编辑器 =====
const showBrush = ref(false)
const sourceNode = computed<CanvasDocNode | null>(() => {
  const n = props.node
  if (!n) return null
  const e = props.edges.find((x) => x.to === n.id && x.port === 'source')
  if (!e) return null
  return props.nodes.find((x) => x.id === e.from) ?? null
})
const sourceAsset = computed<CanvasAssetLite | null>(() => sourceNode.value?.asset ?? null)
const currentMaskId = computed<number | null>(() => asGenSpec(props.node?.spec)?.edit?.maskAssetId ?? null)

function openBrush(): void {
  if (!sourceAsset.value) return
  showBrush.value = true
}
async function onMaskSaved(assetId: number): Promise<void> {
  showBrush.value = false
  const n = props.node
  if (!n) return
  opBusy.value = true
  opErr.value = ''
  try {
    await props.applyPatch({ id: n.id, patch: { spec: buildSpec({ maskAssetId: assetId }) }, label: '应用蒙版' })
    emit('notice', `蒙版已保存并应用（资产 #${assetId}）`)
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

const capHint = computed<string | null>(() => {
  const n = props.node
  const cap = n?.editCapability
  const s = asGenSpec(n?.spec)
  if (!s?.edit || !cap) return null
  const mode = s.edit.mode
  const ok = mode === 'outpaint' ? cap.outpaint : cap.inpaint
  return ok ? null : `当前图像端点未声明「${EDIT_MODE_TEXT[mode]}」能力，执行将失败（可在高级选项指定支持编辑的端点）`
})

// ===== [M17] 表单持久化辅助（AI 扩写 / extract 前落库） =====
/** 保存 text/gen 表单（有改动才写；写命令入撤销栈） */
async function persistFormIfNeeded(): Promise<void> {
  const n = props.node
  if (!n) return
  if (n.kind === 'text') {
    const ts = asTextSpec(n.spec)
    if (!ts || ts.text !== fText.value) {
      await props.applyPatch({ id: n.id, patch: { spec: { text: fText.value } }, label: '编辑文本' })
    }
  } else if (n.kind === 'gen' && formTouched.value) {
    await props.applyPatch({ id: n.id, patch: { spec: buildSpec() }, label: '保存参数' })
  }
}

// ===== [M17] text 节点：直编（blur 提交 PATCH，入撤销栈） =====
async function saveText(): Promise<void> {
  const n = props.node
  if (!n || n.kind !== 'text') return
  const ts = asTextSpec(n.spec)
  if (ts && ts.text === fText.value) return
  opBusy.value = true
  opErr.value = ''
  try {
    await props.applyPatch({ id: n.id, patch: { spec: { text: fText.value } }, label: '编辑文本' })
    emit('notice', '文本已保存')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

// ===== [M17] AI 扩写（对照弹窗：原/新，可编辑 → 应用 PATCH 入栈） =====
const expandOpen = ref(false)
const expandBusy = ref(false)
const expandErr = ref('')
const expandSrc = ref('')
const expandDraft = ref('')
const expandInstruction = ref('')
/** 节点切换 / 取消选中时关闭扩写弹窗（结果归属原节点，避免误应用） */
watch(() => props.node?.id ?? null, () => {
  expandOpen.value = false
})

async function openExpand(): Promise<void> {
  const n = props.node
  if (!n) return
  const src = n.kind === 'text' ? fText.value.trim() : fPrompt.value.trim()
  if (!src) {
    opErr.value = '内容为空，无法扩写'
    return
  }
  opErr.value = ''
  expandErr.value = ''
  try {
    // 先落库表单（服务端扩写取库内已存内容）
    await persistFormIfNeeded()
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
    return
  }
  expandSrc.value = src
  expandDraft.value = ''
  expandInstruction.value = ''
  expandOpen.value = true
}

async function doExpand(): Promise<void> {
  const n = props.node
  if (!n) return
  expandBusy.value = true
  expandErr.value = ''
  try {
    const r = await creationApi.promptExpand(n.id, expandInstruction.value.trim() || undefined)
    expandDraft.value = r.prompt
  } catch (e) {
    expandErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    expandBusy.value = false
  }
}

async function applyExpand(): Promise<void> {
  const n = props.node
  if (!n || !expandDraft.value.trim()) return
  opBusy.value = true
  opErr.value = ''
  try {
    if (n.kind === 'text') {
      fText.value = expandDraft.value
      await props.applyPatch({ id: n.id, patch: { spec: { text: expandDraft.value } }, label: '应用扩写' })
    } else {
      fPrompt.value = expandDraft.value
      await props.applyPatch({ id: n.id, patch: { spec: buildSpec() }, label: '应用扩写' })
    }
    expandOpen.value = false
    emit('notice', '扩写已应用')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

// ===== [M17] 提取文本节点 =====
async function doExtract(): Promise<void> {
  const n = props.node
  if (!n) return
  opBusy.value = true
  opErr.value = ''
  try {
    await persistFormIfNeeded()
    await props.applyExtract(n.id)
    emit('notice', '已提取为文本节点')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

// ===== [M18] BGM 候选（本画布音频节点/资产产物；含 spec 现值兼容兜底） =====
const bgmOptions = computed<Array<{ id: number; name: string }>>(() => {
  const out: Array<{ id: number; name: string }> = []
  const seen = new Set<number>()
  const push = (id: number | null | undefined, name: string | null | undefined): void => {
    if (id == null || seen.has(id)) return
    seen.add(id)
    out.push({ id, name: name ?? `资产 #${id}` })
  }
  for (const n of props.nodes) {
    if (n.kind === 'asset' && n.asset?.kind === 'audio') push(n.assetId, n.asset.name)
  }
  for (const n of props.nodes) {
    if (n.kind !== 'gen' || asGenSpec(n.spec)?.genKind !== 'audio') continue
    if (n.displayTask?.asset?.kind === 'audio') push(n.displayTask.resultAssetId, n.displayTask.asset.name)
  }
  const cur = asGenSpec(props.node?.spec)?.bgmAssetId
  if (cur != null) push(cur, `资产 #${cur}（画布外引用）`)
  return out
})

// ===== [M18] 视频抽帧（gen(video) 显示产物 / asset 视频资产） =====
const canExtractFrame = computed<boolean>(() => {
  const n = props.node
  if (!n) return false
  if (n.kind === 'asset') return n.asset?.kind === 'video'
  if (n.kind !== 'gen') return false
  return asGenSpec(n.spec)?.genKind === 'video' && (n.assetId != null || n.displayTask?.resultAssetId != null)
})

async function doExtractFrame(): Promise<void> {
  const n = props.node
  if (!n || frameBusy.value) return
  if (frameMode.value === 'custom' && !frameTime.value.trim()) {
    opErr.value = '请先填写指定时刻（秒）'
    return
  }
  frameBusy.value = true
  opErr.value = ''
  try {
    if (n.kind === 'gen' && formTouched.value) {
      await props.applyPatch({ id: n.id, patch: { spec: buildSpec() }, label: '保存参数' })
    }
    const r = await creationApi.extractFrame(n.id, {
      mode: frameMode.value,
      time: frameMode.value === 'custom' ? Number(frameTime.value) : undefined,
    })
    emit('notice', `已抽取帧素材（节点 #${r.node.id} · 资产 #${r.asset.id}）`)
    emit('refresh')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    frameBusy.value = false
  }
}

// ===== [M17] 画廊采纳（PATCH adoptedTaskId 入栈；再点取消采纳） =====
async function adoptResult(item: CanvasResultItem): Promise<void> {
  const n = props.node
  if (!n) return
  const next = n.adoptedTaskId === item.taskId ? null : item.taskId
  opBusy.value = true
  opErr.value = ''
  try {
    await props.applyPatch({ id: n.id, patch: { adoptedTaskId: next }, label: next == null ? '取消采纳' : '采纳产物' })
    emit('notice', next == null ? '已取消采纳' : `已采纳任务 #${item.taskId}`)
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

// ===== [M17] run 节点：打开详情 / 取消 =====
async function openRunDetail(): Promise<void> {
  const r = props.node?.run
  if (!r) return
  void router.push({ path: `/runs/${r.id}` })
}

async function cancelRun(): Promise<void> {
  const r = props.node?.run
  if (!r) return
  opBusy.value = true
  opErr.value = ''
  try {
    await runApi.cancel(r.id)
    emit('notice', `运行 #${r.id} 已取消`)
    emit('refresh')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

// ===== 执行 / 取消 / 删除 =====
const runTitle = computed(() => {
  const n = props.node
  if (!n) return ''
  if (n.status === 'pending' || n.status === 'processing') return '节点正在执行中'
  if (n.canRun === true) return '执行该节点（当前表单会先自动保存）'
  return n.readiness?.problems.join('；') || '节点未就绪'
})

async function doRun(): Promise<void> {
  const n = props.node
  if (!n) return
  opBusy.value = true
  opErr.value = ''
  try {
    await props.applyRun({ id: n.id, variants: fVariants.value, savePatch: { spec: buildSpec() } })
    emit('notice', `节点「${n.title}」已入队执行${fVariants.value > 1 ? ` ×${fVariants.value}` : ''}`)
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

async function doCancel(): Promise<void> {
  const t = props.node?.latestTask
  if (!t) return
  opBusy.value = true
  opErr.value = ''
  try {
    await taskApi.cancel(t.id)
    emit('notice', `任务 #${t.id} 已取消`)
    emit('refresh')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

async function cancelTaskRow(t: CanvasGenTaskLite): Promise<void> {
  opBusy.value = true
  opErr.value = ''
  try {
    await taskApi.cancel(t.id)
    emit('notice', `任务 #${t.id} 已取消`)
    emit('refresh')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

async function removeNode(): Promise<void> {
  const n = props.node
  if (!n) return
  const ok = await confirmDialog({
    title: '删除节点',
    message: `删除「${n.title}」及与其相连的所有边？产物资产会保留在资产库。`,
    confirmText: '删除节点',
    danger: true,
  })
  if (!ok) return
  opBusy.value = true
  opErr.value = ''
  try {
    await props.applyDelete()
    emit('clear')
    emit('notice', '节点已删除')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

// ===== 连线 =====
const incoming = computed<CanvasDocEdge[]>(() => {
  const n = props.node
  return n ? props.edges.filter((e) => e.to === n.id) : []
})
const outgoing = computed<CanvasDocEdge[]>(() => {
  const n = props.node
  return n ? props.edges.filter((e) => e.from === n.id) : []
})
const edgeFrom = computed<CanvasDocNode | null>(() => {
  const e = props.edge
  return e ? props.nodes.find((n) => n.id === e.from) ?? null : null
})
const edgeTo = computed<CanvasDocNode | null>(() => {
  const e = props.edge
  return e ? props.nodes.find((n) => n.id === e.to) ?? null : null
})

async function dropEdge(id: number): Promise<void> {
  opBusy.value = true
  opErr.value = ''
  try {
    await props.applyRemoveEdge(id)
    emit('notice', '连线已断开')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

// ===== 预览 =====
const previewAssets = ref<Asset[]>([])
const previewIdx = ref<number | null>(null)

async function openPreview(assetId: number | null): Promise<void> {
  if (assetId == null) return
  opErr.value = ''
  try {
    const { asset } = await assetApi.detail(assetId)
    previewAssets.value = [asset]
    previewIdx.value = 0
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  }
}
function onPreviewChanged(updated: Asset): void {
  previewAssets.value = previewAssets.value.map((a) => (a.id === updated.id ? updated : a))
}

// ===== 设为实体参考图（内联面板） =====
const entKind = ref<EntityKind>('character')
const entList = ref<EntityItem[]>([])
const entLoading = ref(false)
const entBusy = ref<number | null>(null)
const entErr = ref('')

async function loadEntities(): Promise<void> {
  entLoading.value = true
  entErr.value = ''
  try {
    const r = await entityApi.list(entKind.value, `&project_id=${props.projectId}`)
    entList.value = r.items
  } catch (e) {
    entErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    entLoading.value = false
  }
}
function toggleEntities(): void {
  entOpen.value = !entOpen.value
  if (entOpen.value) void loadEntities()
}
watch(entKind, () => {
  if (entOpen.value) void loadEntities()
})

async function attachTo(e: EntityItem): Promise<void> {
  const n = props.node
  if (!n || n.assetId == null) return
  entBusy.value = e.id
  entErr.value = ''
  try {
    const r = await creationApi.attachRefAssets(e.id, [n.assetId])
    emit('notice', `已挂接「${e.name}」参考图（新增 ${r.added ?? 0} 张）`)
    entOpen.value = false
  } catch (err) {
    entErr.value = err instanceof Error ? err.message : String(err)
  } finally {
    entBusy.value = null
  }
}
</script>

<template>
  <aside class="ci" aria-label="节点检查器">
    <div v-if="!node && !edge" class="ci-empty">
      <Icon name="wand" :size="24" />
      <p class="muted">
        未选中节点。<br />
        单击节点查看与编辑属性；双击空白新建生成节点；拖拽右侧圆点到目标节点左侧圆点连线。
      </p>
    </div>

    <!-- ===== 节点视图 ===== -->
    <template v-else-if="node">
      <div class="ci-head">
        <Icon :name="nodeIcon(node)" :size="15" />
        <input
          v-if="renaming"
          ref="titleEl"
          v-model="titleDraft"
          class="ci-title-in"
          @keydown.enter="saveTitle"
          @keydown.esc="renaming = false"
          @blur="saveTitle"
        />
        <div v-else class="tt" :title="node.title" @dblclick="startRename">{{ node.title }}</div>
        <button type="button" class="iconbtn" title="改名" @click="startRename">
          <Icon name="pencil" :size="12" />
        </button>
        <button type="button" class="iconbtn" title="取消选中" @click="emit('clear')">
          <Icon name="x" :size="13" />
        </button>
      </div>
      <div class="sub mono">
        #{{ node.id }} ·
        {{ kindLabel(node) }}
        <template v-if="genSpec?.edit"> · 编辑（{{ EDIT_MODE_TEXT[genSpec.edit.mode] }}）</template>
      </div>
      <div v-if="node.kind === 'gen'" class="ci-status">
        <span v-if="stText(node.status)" class="badge" :class="stCls(node.status)">{{ stText(node.status) }}</span>
        <span v-if="node.latestTask" class="muted">{{ fmtTime(node.latestTask.createdAt) }}</span>
        <span v-if="node.latestTask && node.latestTask.attempts > 1" class="muted">尝试 {{ node.latestTask.attempts }}</span>
      </div>

      <!-- ===== gen：spec 表单 ===== -->
      <template v-if="node.kind === 'gen'">
        <section class="sec">
          <div class="sec-h">生成参数</div>
          <div class="frow">
            <label class="flabel">生成类型</label>
            <select v-model="fGenKind">
              <option value="image">图片</option>
              <option value="video">视频</option>
              <option value="audio">音频（TTS）</option>
              <option value="compose">音视频合成</option>
              <option value="llm">LLM 文本处理</option>
            </select>
          </div>
          <div v-if="fGenKind !== 'compose'" class="frow">
            <label class="flabel">{{ fGenKind === 'audio' ? '朗读文本' : fGenKind === 'llm' ? '指令' : '提示词' }}</label>
            <textarea
              v-model="fPrompt"
              rows="3"
              :placeholder="fGenKind === 'audio' ? '要朗读的文本…（留空则取「提示词」端口连线的文本节点）' : fGenKind === 'llm' ? '给 LLM 的指令（如：总结要点 / 改写风格 / 描述画面），留空则取「提示词」端口' : fEditMode === 'inpaint' ? '要画什么（局部重绘必填）' : fEditMode === 'erase' ? '可留空（走消除默认提示词）' : '描述要生成的画面…'"
            />
            <div class="frow-ops">
              <button type="button" class="btn sm" :disabled="opBusy || expandBusy" title="AI 扩写提示词/文本" @click="openExpand">
                <Icon name="sparkles" :size="12" /> AI 扩写
              </button>
              <button type="button" class="btn sm" :disabled="opBusy" title="提取为独立文本节点" @click="doExtract">
                <Icon name="doc" :size="12" /> 提取文本节点
              </button>
            </div>
          </div>
          <div v-if="fGenKind === 'image'" class="frow">
            <label class="flabel">画面尺寸</label>
            <input v-model="fSize" type="text" placeholder="如 832x1248（留空走项目/模板默认）" />
          </div>
          <template v-else-if="fGenKind === 'video'">
            <div class="frow">
              <label class="flabel">时长（秒）</label>
              <input v-model="fDuration" type="number" min="1" step="1" placeholder="如 5（留空走默认）" />
            </div>
            <div class="frow">
              <label class="flabel">分辨率</label>
              <input v-model="fResolution" type="text" placeholder="如 480p / 768p（留空走默认）" />
            </div>
            <div class="frow">
              <label class="flabel">画幅比</label>
              <input v-model="fAspectRatio" type="text" placeholder="如 9:16（留空走默认）" />
            </div>
          </template>
          <template v-else-if="fGenKind === 'audio'">
            <div class="frow">
              <label class="flabel">声线</label>
              <input v-model="fVoice" type="text" placeholder="如 zh-CN-XiaoxiaoNeural（留空走设置/实例声线）" />
            </div>
            <div class="frow">
              <label class="flabel">语速</label>
              <input v-model="fSpeed" type="number" step="0.05" min="0.25" max="4" placeholder="0.25–4（留空默认）" />
            </div>
          </template>
          <template v-else-if="fGenKind === 'llm'">
            <div class="frow">
              <label class="flabel">采样温度</label>
              <input v-model="fTemperature" type="number" step="0.1" min="0" max="2" placeholder="0–2（默认 0.7）" />
            </div>
            <div class="frow">
              <label class="flabel">最大 token</label>
              <input v-model="fMaxTokens" type="number" step="1" min="1" max="32000" placeholder="1–32000（默认 2048）" />
            </div>
            <div class="muted mini">输入：参考图（≤ 4）· 文本素材（≤ 4 段，合并为上下文）· 提示词（1 条，优先级高于本表单指令）。产物为文本资产，可连入图/视频/LLM 节点。</div>
          </template>
          <template v-else>
            <div class="frow">
              <label class="flabel">分辨率</label>
              <input v-model="fResolution" type="text" placeholder="如 1080x1920（留空跟随首个视频源）" />
            </div>
            <div class="frow">
              <label class="flabel">帧率</label>
              <input v-model="fFps" type="number" min="1" step="1" placeholder="如 30（留空跟随源）" />
            </div>
            <div class="frow">
              <label class="flabel">转场</label>
              <select v-model="fTransition">
                <option v-for="t in TRANSITION_OPTIONS" :key="t.value" :value="t.value">{{ t.label }}</option>
              </select>
            </div>
            <div v-if="fTransition !== 'none'" class="frow">
              <label class="flabel">转场时长</label>
              <input v-model="fTransitionDuration" type="number" step="0.1" min="0.1" max="2" placeholder="秒（0.1–2，默认 0.5）" />
            </div>
            <div class="frow">
              <label class="flabel">背景音乐</label>
              <select v-model="fBgmAssetId">
                <option value="">无</option>
                <option v-for="a in bgmOptions" :key="a.id" :value="String(a.id)">{{ a.name }}</option>
              </select>
            </div>
            <template v-if="fBgmAssetId">
              <div class="frow">
                <label class="flabel">BGM 音量</label>
                <input v-model="fBgmVolume" type="number" step="0.05" min="0" max="1" placeholder="0–1（默认 0.5）" />
              </div>
              <label class="chk">
                <input v-model="fBgmFade" type="checkbox" />
                <span>BGM 首尾淡入淡出（1.5s）</span>
              </label>
            </template>
            <div class="muted mini">输入：视频端口（≥1，按连线创建序拼接）＋ 音频端口（可选，混音；有音轨时丢弃视频原声）。</div>
          </template>

          <div class="frow">
            <label class="flabel">编辑模式</label>
            <select v-model="fEditMode" :disabled="fGenKind !== 'image'">
              <option value="">无（普通生成）</option>
              <option value="inpaint">局部重绘（涂抹后重画）</option>
              <option value="erase">消除（涂抹后去除）</option>
              <option value="outpaint">扩图（向外扩展画布）</option>
            </select>
          </div>
          <div v-if="fGenKind !== 'image' && fEditMode" class="muted mini">非图片节点不支持编辑模式，保存时将忽略。</div>

          <template v-if="fGenKind === 'image' && fEditMode && fEditMode !== 'outpaint'">
            <div class="maskrow">
              <div class="maskinfo">
                <span class="muted">蒙版：</span>
                <span v-if="currentMaskId != null" class="mono">资产 #{{ currentMaskId }}</span>
                <span v-else class="warn-t">未设置（执行前必需）</span>
              </div>
              <button
                type="button"
                class="btn sm"
                :disabled="!sourceAsset"
                :title="sourceAsset ? '在源图上涂抹要编辑的区域' : '请先连接源图（source 端口）'"
                @click="openBrush"
              >
                <Icon name="brush" :size="12" /> 打开蒙版编辑器…
              </button>
            </div>
            <div v-if="!sourceAsset" class="muted mini">请从上游节点的输出端口连线到本节点左侧的「源图」输入端口，作为编辑底图。</div>
          </template>

          <div v-if="fGenKind === 'image' && fEditMode === 'outpaint'" class="expandrow">
            <div class="frow3">
              <label class="flabel">旋转角</label>
              <input v-model="fAngle" type="number" step="1" placeholder="默认" />
            </div>
            <div class="frow3">
              <label class="flabel">横向倍率</label>
              <input v-model="fXScale" type="number" step="0.1" min="1" placeholder="如 1.5" />
            </div>
            <div class="frow3">
              <label class="flabel">纵向倍率</label>
              <input v-model="fYScale" type="number" step="0.1" min="1" placeholder="如 1.5" />
            </div>
          </div>

          <details class="fold">
            <summary>高级（端点覆盖 / 风格预设）</summary>
            <div class="frow">
              <label class="flabel">端点</label>
              <input v-model="fProvider" type="text" placeholder="如 aliyun_wan_image（留空自动解析）" />
            </div>
            <div class="frow">
              <label class="flabel">模型</label>
              <input v-model="fModel" type="text" placeholder="如 wan2.6-t2i（留空走端点默认）" />
            </div>
            <label class="chk">
              <input v-model="fStyle" type="checkbox" />
              <span>套用项目风格预设（图片生成）</span>
            </label>
          </details>

          <div class="ops">
            <button type="button" class="btn sm" :disabled="opBusy" @click="saveSpec">
              <Icon name="check" :size="12" /> 保存 spec
            </button>
            <span v-if="formTouched" class="muted mini">有未保存修改（执行时会自动保存）</span>
          </div>
        </section>

        <!-- ===== gen：就绪度 ===== -->
        <section class="sec">
          <div class="sec-h">就绪度</div>
          <div v-if="node.specError" class="err-text">{{ node.specError }}</div>
          <template v-else-if="node.readiness">
            <div v-if="node.readiness.ready" class="ok-t">
              <Icon name="check" :size="12" /> 已就绪，可执行
            </div>
            <ul v-else class="prob">
              <li v-for="(p, i) in node.readiness.problems" :key="i">{{ p }}</li>
            </ul>
          </template>
          <div v-if="capHint" class="warn-t mini">{{ capHint }}</div>
          <ul v-if="readinessNotes.length" class="notes">
            <li v-for="(nt, i) in readinessNotes" :key="i">{{ nt }}</li>
          </ul>
        </section>
      </template>

      <!-- ===== 操作 ===== -->
      <section class="sec">
        <div class="sec-h">操作</div>
        <div class="ops">
          <label v-if="node.kind === 'gen'" class="vsel" title="执行变体数（1-4，建多个任务并行排队）">
            变体
            <select v-model.number="fVariants">
              <option v-for="n in 4" :key="n" :value="n">{{ n }}</option>
            </select>
          </label>
          <button
            v-if="node.kind === 'gen'"
            type="button"
            class="btn sm primary"
            :disabled="opBusy || (node.canRun !== true && !formTouched)"
            :title="runTitle"
            @click="doRun"
          >
            <Icon name="play" :size="12" /> 执行{{ fVariants > 1 ? ` ×${fVariants}` : '' }}
          </button>
          <button
            v-if="node.kind === 'gen' && node.canCancel"
            type="button"
            class="btn sm"
            :disabled="opBusy"
            title="取消进行中的任务"
            @click="doCancel"
          >
            <Icon name="stop" :size="12" /> 取消任务
          </button>
          <label v-if="canExtractFrame" class="vsel" title="抽帧位置（首/尾帧可接力 i2v）">
            抽帧
            <select v-model="frameMode">
              <option value="first">首帧</option>
              <option value="last">尾帧</option>
              <option value="custom">指定时刻</option>
            </select>
          </label>
          <input
            v-if="canExtractFrame && frameMode === 'custom'"
            v-model="frameTime"
            class="ft-time"
            type="number"
            min="0"
            step="0.1"
            placeholder="秒"
          />
          <button
            v-if="canExtractFrame"
            type="button"
            class="btn sm"
            :disabled="opBusy || frameBusy"
            title="从视频产物抽取一帧为图片素材节点"
            @click="doExtractFrame"
          >
            <Icon name="photo" :size="12" /> {{ frameBusy ? '抽帧中…' : '抽帧' }}
          </button>
          <span class="sp" />
          <button type="button" class="btn sm danger" :disabled="opBusy" title="删除节点（保留产物资产）" @click="removeNode">
            <Icon name="trash" :size="12" /> 删除节点
          </button>
        </div>
        <div v-if="opErr" class="err-text">{{ opErr }}</div>
      </section>

      <!-- ===== gen：任务历史 ===== -->
      <section v-if="node.kind === 'gen'" class="sec">
        <div class="sec-h">任务历史（最近 {{ node.tasks.length }} 条）</div>
        <div v-if="!node.tasks.length" class="muted">暂无任务</div>
        <div v-else class="tlist">
          <div v-for="t in node.tasks" :key="t.id" class="trow">
            <span class="mono tid">#{{ t.id }}</span>
            <span class="badge" :class="stCls(t.status)">{{ TASK_TEXT[t.status] ?? t.status }}</span>
            <span v-if="t.attempts > 1" class="muted">尝试 {{ t.attempts }}</span>
            <span v-if="t.status === 'succeeded' && t.completedAt" class="muted mono">{{ fmtMs(t.completedAt - t.createdAt) }}</span>
            <span v-if="t.errorMsg" class="t-err" :title="t.errorMsg">{{ t.errorMsg }}</span>
            <span class="sp" />
            <button
              v-if="t.status === 'succeeded' && t.resultAssetId != null"
              type="button"
              class="btn sm"
              @click="openPreview(t.resultAssetId)"
            >
              查看
            </button>
            <button
              v-if="t.status === 'pending' || t.status === 'processing'"
              type="button"
              class="btn sm danger"
              :disabled="opBusy"
              @click="cancelTaskRow(t)"
            >
              取消
            </button>
          </div>
        </div>
      </section>

      <!-- ===== [M17] gen：显示产物 + 结果画廊（采纳） ===== -->
      <section v-if="node.kind === 'gen'" class="sec">
        <div class="sec-h">
          显示产物
          <span v-if="node.adoptedTaskId != null" class="muted mini">· 采纳任务 #{{ node.adoptedTaskId }}</span>
          <span v-else-if="node.displayTaskId != null" class="muted mini">· 任务 #{{ node.displayTaskId }}</span>
        </div>
        <div v-if="node.displayTask && node.displayTask.asset" class="resbox static">
          <audio v-if="node.displayTask.asset.kind === 'audio'" controls :src="node.displayTask.asset.urls.file" />
          <video v-else-if="node.displayTask.asset.kind === 'video'" controls :src="node.displayTask.asset.urls.file" />
          <button v-else type="button" class="unstyle" title="点击预览" @click="openPreview(node.displayTask.resultAssetId)">
            <img v-if="assetThumb(node.displayTask.asset)" :src="assetThumb(node.displayTask.asset)!" alt="" />
            <span v-else class="muted">{{ KIND_TEXT[node.displayTask.asset.kind] ?? node.displayTask.asset.kind }}</span>
          </button>
        </div>
        <button
          v-else-if="node.assetId != null && node.asset"
          type="button"
          class="resbox"
          title="点击预览"
          @click="openPreview(node.assetId)"
        >
          <img v-if="assetThumb(node.asset)" :src="assetThumb(node.asset)!" alt="" />
          <span v-else class="muted">{{ KIND_TEXT[node.asset.kind] ?? node.asset.kind }}</span>
        </button>
        <div v-else class="muted">暂无产物</div>

        <div class="sec-h">结果画廊（最近成功 {{ node.results.length }} 张）</div>
        <div v-if="!node.results.length" class="muted">暂无成功产物</div>
        <div v-else class="gallery">
          <div v-for="r in node.results" :key="r.taskId" class="gitem" :class="{ adopted: r.taskId === node.adoptedTaskId }">
            <button type="button" class="gthumb" :title="`任务 #${r.taskId} · ${fmtTime(r.createdAt)}（点击大图）`" @click="openPreview(r.assetId)">
              <img v-if="r.asset && (r.asset.urls.thumb || r.asset.kind === 'image')" :src="r.asset.urls.thumb ?? r.asset.urls.file" alt="" />
              <span v-else class="muted mini">{{ r.asset ? (KIND_TEXT[r.asset.kind] ?? r.asset.kind) : '缺失' }}</span>
            </button>
            <div class="gmeta">
              <span v-if="r.taskId === node.adoptedTaskId" class="badge succeeded">已采纳</span>
              <span v-else-if="r.taskId === node.displayTaskId" class="badge pending">最新</span>
              <span class="mono mini">#{{ r.taskId }}</span>
            </div>
            <button type="button" class="btn sm" :disabled="opBusy" @click="adoptResult(r)">
              {{ r.taskId === node.adoptedTaskId ? '取消采纳' : '采纳' }}
            </button>
          </div>
        </div>
      </section>

      <!-- ===== asset 节点：素材信息 ===== -->
      <template v-else-if="node.kind === 'asset'">
        <section class="sec">
          <div class="sec-h">素材</div>
          <button v-if="node.asset" type="button" class="resbox" title="点击预览" @click="openPreview(node.assetId)">
            <img v-if="assetThumb(node.asset)" :src="assetThumb(node.asset)!" alt="" />
            <span v-else class="muted">{{ KIND_TEXT[node.asset.kind] ?? node.asset.kind }}</span>
          </button>
          <div v-else class="err-text">引用的资产已不存在（#{{ node.assetId ?? '?' }}）</div>
          <div v-if="node.asset" class="kvs">
            <div class="kv">
              <span class="k">类型</span>
              <span class="v">
                {{ KIND_TEXT[node.asset.kind] ?? node.asset.kind }}
                <template v-if="node.asset.purpose"> · {{ purposeText(node.asset.purpose) }}</template>
              </span>
            </div>
            <div v-if="node.asset.width && node.asset.height" class="kv">
              <span class="k">尺寸</span>
              <span class="v mono">{{ node.asset.width }}×{{ node.asset.height }}</span>
            </div>
            <div v-if="node.asset.duration" class="kv">
              <span class="k">时长</span>
              <span class="v mono">{{ node.asset.duration }}s</span>
            </div>
          </div>
        </section>
      </template>

      <!-- ===== [M17] text 节点：文本内容 ===== -->
      <template v-else-if="node.kind === 'text'">
        <section class="sec">
          <div class="sec-h">文本内容</div>
          <div class="frow">
            <textarea v-model="fText" rows="7" placeholder="输入文本…（连到生成节点的「提示词」端口即可作为其提示词）" @blur="saveText" />
          </div>
          <div class="frow-ops">
            <button type="button" class="btn sm" :disabled="opBusy || expandBusy" title="AI 扩写文本" @click="openExpand">
              <Icon name="sparkles" :size="12" /> AI 扩写
            </button>
            <button type="button" class="btn sm" :disabled="opBusy" title="立即保存文本" @click="saveText">
              <Icon name="check" :size="12" /> 保存文本
            </button>
          </div>
          <div class="muted mini">失焦自动保存；提取自生成节点的文本也会落到这里的独立节点。</div>
          <div v-if="node.specError" class="err-text">{{ node.specError }}</div>
        </section>
      </template>

      <!-- ===== [M17] entity 节点：实体直通 ===== -->
      <template v-else-if="node.kind === 'entity'">
        <section class="sec">
          <div class="sec-h">实体</div>
          <template v-if="node.entity">
            <button
              v-if="node.entity.asset"
              type="button"
              class="resbox"
              title="点击预览参考图"
              @click="openPreview(node.entity.asset.id)"
            >
              <img v-if="assetThumb(node.entity.asset)" :src="assetThumb(node.entity.asset)!" alt="" />
              <span v-else class="muted">{{ KIND_TEXT[node.entity.asset.kind] ?? node.entity.asset.kind }}</span>
            </button>
            <div class="kvs">
              <div class="kv"><span class="k">名称</span><span class="v">{{ node.entity.name }}</span></div>
              <div class="kv"><span class="k">类型</span><span class="v">{{ entKindText(node.entity.kind) }}</span></div>
              <div class="kv"><span class="k">参考图</span><span class="v mono">{{ node.entity.refCount }} 张</span></div>
            </div>
            <div class="muted mini">下游节点执行时按实体参考图注入（受实体截断策略约束）。</div>
          </template>
          <div v-else class="err-text">实体数据缺失（可能已被删除）</div>
        </section>
      </template>

      <!-- ===== [M17] run 节点：内嵌运行 ===== -->
      <template v-else-if="node.kind === 'run'">
        <section class="sec">
          <div class="sec-h">运行</div>
          <template v-if="node.run">
            <div class="kvs">
              <div class="kv"><span class="k">运行</span><span class="v mono">#{{ node.run.id }}</span></div>
              <div class="kv"><span class="k">模板</span><span class="v mono">{{ node.run.templateKey }}</span></div>
              <div class="kv">
                <span class="k">状态</span>
                <span class="v">
                  <span class="badge" :class="RUN_CLS[node.run.status] ?? 'pending'">
                    {{ RUN_TEXT[node.run.status] ?? node.run.status }}
                  </span>
                </span>
              </div>
              <div class="kv"><span class="k">步骤</span><span class="v mono">{{ node.run.steps.succeeded }}/{{ node.run.steps.total }} 成功</span></div>
              <div v-if="node.run.startedAt" class="kv"><span class="k">开始</span><span class="v mono">{{ fmtTime(node.run.startedAt) }}</span></div>
              <div v-if="node.run.completedAt" class="kv"><span class="k">结束</span><span class="v mono">{{ fmtTime(node.run.completedAt) }}</span></div>
            </div>
            <div class="ops">
              <button type="button" class="btn sm" @click="openRunDetail">
                <Icon name="doc" :size="12" /> 打开运行详情
              </button>
              <button v-if="canCancelRun" type="button" class="btn sm danger" :disabled="opBusy" @click="cancelRun">
                <Icon name="stop" :size="12" /> 取消运行
              </button>
            </div>
            <div class="muted mini">画布内进度由轮询实时更新；详情页可查看每步输入输出。</div>
          </template>
          <div v-else class="err-text">运行数据缺失或被删除（可能已超出保留期）</div>
        </section>
      </template>

      <!-- ===== 连线 ===== -->
      <section class="sec">
        <div class="sec-h">连线（入 {{ incoming.length }} · 出 {{ outgoing.length }}）</div>
        <div v-if="!incoming.length && !outgoing.length" class="muted">无连线</div>
        <div v-else class="elist">
          <div v-for="e in incoming" :key="e.id" class="erow">
            <span class="edir mono">←</span>
            <span class="etitle" :title="nodeTitle(e.from)">{{ nodeTitle(e.from) }}</span>
            <span class="eport">{{ PORT_TEXT[e.port] ?? e.port }}</span>
            <button type="button" class="iconbtn" title="断开" @click="dropEdge(e.id)">
              <Icon name="x" :size="11" />
            </button>
          </div>
          <div v-for="e in outgoing" :key="'o' + e.id" class="erow">
            <span class="edir mono">→</span>
            <span class="etitle" :title="nodeTitle(e.to)">{{ nodeTitle(e.to) }}</span>
            <span class="eport">{{ PORT_TEXT[e.port] ?? e.port }}</span>
            <button type="button" class="iconbtn" title="断开" @click="dropEdge(e.id)">
              <Icon name="x" :size="11" />
            </button>
          </div>
        </div>
      </section>

      <!-- ===== 联动：设为实体参考图 ===== -->
      <section v-if="node.assetId != null" class="sec">
        <div class="sec-h">联动</div>
        <button type="button" class="btn sm" :disabled="node.assetId == null" @click="toggleEntities">
          <Icon name="link" :size="12" /> {{ entOpen ? '收起' : '设为实体参考图…' }}
        </button>
        <template v-if="entOpen">
          <div class="frow">
            <label class="flabel">实体类型</label>
            <select v-model="entKind">
              <option value="character">角色</option>
              <option value="scene">场景</option>
              <option value="prop">道具</option>
            </select>
          </div>
          <div v-if="entLoading" class="muted">加载中…</div>
          <div v-else-if="!entList.length" class="muted">该项目下暂无{{ ENT_KIND_LABEL[entKind] }}实体</div>
          <div v-else class="entlist">
            <button
              v-for="e in entList"
              :key="e.id"
              type="button"
              class="entitem"
              :disabled="entBusy === e.id"
              :title="`把产物 #${node.assetId} 挂为该实体的参考图`"
              @click="attachTo(e)"
            >
              <span class="entname">{{ e.name }}</span>
              <span class="muted mini">{{ e.refAssets?.length ?? 0 }} 张参考图</span>
            </button>
          </div>
          <div v-if="entErr" class="err-text">{{ entErr }}</div>
        </template>
      </section>
    </template>

    <!-- ===== 边视图 ===== -->
    <template v-else-if="edge">
      <div class="ci-head">
        <Icon name="link" :size="14" />
        <div class="tt">连线 #{{ edge.id }}</div>
        <button type="button" class="iconbtn" title="取消选中" @click="emit('clear')">
          <Icon name="x" :size="13" />
        </button>
      </div>
      <section class="sec">
        <div class="kv"><span class="k">起点</span><span class="v">{{ edgeFrom ? edgeFrom.title : `#${edge.from}` }}</span></div>
        <div class="kv">
          <span class="k">终点</span>
          <span class="v">{{ edgeTo ? edgeTo.title : `#${edge.to}` }} · {{ PORT_TEXT[edge.port] ?? edge.port }}</span>
        </div>
        <div class="ops">
          <button type="button" class="btn sm danger" :disabled="opBusy" @click="dropEdge(edge.id)">
            <Icon name="trash" :size="12" /> 断开连线
          </button>
        </div>
        <div v-if="opErr" class="err-text">{{ opErr }}</div>
      </section>
    </template>

    <!-- AI 扩写（对照弹窗：原文 / 可编辑草稿） -->
    <Modal v-if="expandOpen && node" title="AI 扩写" :width="720" @close="expandOpen = false">
      <div class="exp-body">
        <div class="exp-col">
          <div class="exp-h">原文</div>
          <pre class="exp-pre">{{ expandSrc }}</pre>
        </div>
        <div class="exp-col">
          <div class="exp-h">扩写结果（可编辑后应用）</div>
          <textarea v-model="expandDraft" class="exp-ta" rows="10" placeholder="点击「开始扩写」生成…" />
        </div>
      </div>
      <div class="frow">
        <label class="flabel">补充要求（可选）</label>
        <input v-model="expandInstruction" type="text" placeholder="如：更电影感、补充光影细节、控制在 120 字内…" @keydown.enter="doExpand" />
      </div>
      <div v-if="expandErr" class="err-text">{{ expandErr }}</div>
      <template #footer>
        <button type="button" class="btn" @click="expandOpen = false">关闭</button>
        <button type="button" class="btn" :disabled="expandBusy" @click="doExpand">
          <Icon name="sparkles" :size="12" /> {{ expandBusy ? '扩写中…' : expandDraft ? '重新扩写' : '开始扩写' }}
        </button>
        <button type="button" class="btn primary" :disabled="expandBusy || opBusy || !expandDraft.trim()" @click="applyExpand">
          <Icon name="check" :size="12" /> 应用
        </button>
      </template>
    </Modal>
    <!-- 蒙版编辑器（自持） -->
    <EditBrushModal
      v-if="showBrush && genSpec?.edit && sourceAsset"
      :project-id="projectId"
      :base-url="sourceAsset.urls.file"
      :base-name="sourceAsset.name"
      @close="showBrush = false"
      @saved="onMaskSaved"
    />
    <!-- 结果预览（自持） -->
    <AssetPreviewer
      v-if="previewIdx !== null && previewAssets.length"
      :assets="previewAssets"
      :index="previewIdx"
      @close="previewIdx = null"
      @changed="onPreviewChanged"
    />
  </aside>
</template>

<style scoped>
.ci {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 340px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 15px 18px;
  background: var(--panel);
  border-left: 1px solid var(--border);
  box-shadow: -14px 0 30px rgb(0 0 0 / 34%);
  overflow-y: auto;
  z-index: 6;
  animation: ci-in 0.18s ease;
}

@keyframes ci-in {
  from {
    transform: translateX(22px);
    opacity: 0;
  }
}

.ci-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 36px 12px;
  text-align: center;
  color: var(--text-3);
}

.ci-empty p {
  font-size: 12px;
  line-height: 1.7;
  margin: 0;
}

.ci-head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text-2);
}

.tt {
  flex: 1;
  min-width: 0;
  font-weight: 700;
  font-size: 13.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: text;
}

.ci-title-in {
  flex: 1;
  min-width: 0;
  padding: 4px 7px;
  font-size: 13px;
}

.iconbtn {
  display: flex;
  flex: none;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 3px;
  border-radius: 6px;
}

.iconbtn:hover {
  background: var(--hover);
  color: #fff;
}

.sub {
  font-size: 11px;
  color: var(--text-3);
  word-break: break-all;
  margin-top: -4px;
}

.ci-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  flex-wrap: wrap;
}

.sec {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}

.sec-h {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0.4px;
}

.frow {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.flabel {
  font-size: 11.5px;
  color: var(--text-3);
}

.frow select,
.frow input,
.frow textarea {
  font-size: 12.5px;
  padding: 6px 9px;
}

.frow3 {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
}

.frow3 input {
  font-size: 12px;
  padding: 5px 8px;
}

.expandrow {
  display: flex;
  gap: 8px;
}

.maskrow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.maskinfo {
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.fold summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-2);
}

.fold summary:hover {
  color: #fff;
}

.fold {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.chk {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}

.chk input {
  width: auto;
}

.ops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.sp {
  flex: 1;
}

.mini {
  font-size: 11px;
}

.ok-t {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--ok);
}

.warn-t {
  font-size: 12px;
  color: var(--warn);
}

.prob {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--warn);
  line-height: 1.7;
}

.tlist {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.trow {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  padding: 3px 0;
  min-width: 0;
  flex-wrap: wrap;
}

.tid {
  color: var(--text-3);
  flex: none;
}

.t-err {
  flex: 1;
  min-width: 90px;
  color: var(--bad);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resbox {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--code-bg);
  overflow: hidden;
  cursor: pointer;
  padding: 0;
  min-height: 84px;
}

.resbox:hover {
  border-color: var(--accent);
}

.resbox img {
  display: block;
  width: 100%;
  max-height: 190px;
  object-fit: contain;
}

.kvs {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.kv {
  display: flex;
  gap: 8px;
  font-size: 12px;
}

.kv .k {
  flex: none;
  width: 48px;
  color: var(--text-3);
}

.kv .v {
  min-width: 0;
  color: var(--text-2);
  word-break: break-all;
}

.elist {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.erow {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  min-width: 0;
}

.edir {
  flex: none;
  color: var(--text-3);
}

.etitle {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}

.eport {
  flex: none;
  font-size: 10.5px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-3);
}

.entlist {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow-y: auto;
}

.entitem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--code-bg);
  color: var(--text);
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}

.entitem:hover {
  border-color: var(--accent);
}

.entname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ===== [M17] 新增块：frow-ops / notes / vsel / 画廊 / 弹窗 ===== */
.frow-ops {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.notes {
  margin: 0;
  padding-left: 18px;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.7;
}

.vsel {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-3);
}

.ft-time {
  width: 72px;
  font-size: 12px;
  padding: 4px 6px;
}

.vsel select {
  font-size: 12px;
  padding: 4px 6px;
}

.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 8px;
}

.gitem {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--code-bg);
  padding: 5px;
}

.gitem.adopted {
  border-color: var(--accent);
}

.gthumb {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  border-radius: 6px;
  overflow: hidden;
  padding: 0;
  cursor: pointer;
  min-height: 56px;
  color: var(--text-3);
}

.gthumb img {
  display: block;
  width: 100%;
  height: 62px;
  object-fit: cover;
}

.gmeta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  min-height: 18px;
}

.resbox.static {
  cursor: default;
}

.resbox audio,
.resbox video {
  width: 100%;
}

.unstyle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  color: var(--text-3);
}

.unstyle img {
  display: block;
  width: 100%;
  max-height: 190px;
  object-fit: contain;
}

.exp-body {
  display: flex;
  gap: 12px;
}

.exp-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.exp-h {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
}

.exp-pre {
  margin: 0;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--code-bg);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 340px;
  overflow-y: auto;
}

.exp-ta {
  font-size: 12.5px;
  min-height: 264px;
  resize: vertical;
}
</style>
