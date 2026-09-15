/**
 * [M28] 创作画布检查器状态与操作（自 CreationInspector.vue 逐字迁移）
 * —— 装配约定：函数体逐字保留；props/emit 经参数注入；包裹层缩进 +2（机械转换）
 * —— form 状态总线（reactive 代理）：供模板与各面板子组件安全读写全部状态
 */
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type {
  CanvasAssetLite,
  CanvasDocEdge,
  CanvasDocNode,
  CanvasEditMode,
  CanvasGenTaskLite,
  CanvasResultItem,
  ComposeTransition,
  CreationNodeSpec,
  EntityItem,
  EntityKind,
  GenKind,
  NodeSpecEdit,
} from '../../../lib/types'
import { creationApi, entityApi, runApi, taskApi } from '../../../lib/api'
import { confirmDialog } from '../../../lib/confirm'
import { EDIT_MODE_TEXT, RUN_TERMINAL, asGenSpec, asTextSpec } from './internals'
import type { InspectorEmitFn, InspectorProps } from './internals'

export function useInspectorForm(props: InspectorProps, emit: InspectorEmitFn) {
  const router = useRouter()

  const opErr = ref('')
  const opBusy = ref(false)

  /** [M17] gen 规范视图（模板/守卫通用；非 gen 节点为 null） */
  const genSpec = computed<CreationNodeSpec | null>(() => asGenSpec(props.node?.spec))
  /** [M17] run 节点可取消（有 run 且非终态） */
  const canCancelRun = computed<boolean>(() => {
    const r = props.node?.run
    return !!r && !RUN_TERMINAL.has(r.status)
  })
  /** [M17] 就绪度 notes（实体截断/降级提示） */
  const readinessNotes = computed<string[]>(() => props.node?.readiness?.notes ?? [])

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

  // ---- 模板状态总线（M28 装配新增；reactive 代理解包 ref/computed，模板与子组件读写均安全）----
  const form = reactive({
    // 表单字段
    fGenKind, fPrompt, fSize, fDuration, fResolution, fAspectRatio, fVoice, fSpeed, fFps, fProvider, fModel, fStyle,
    fEditMode, fAngle, fXScale, fYScale, fTransition, fTransitionDuration, fBgmAssetId, fBgmVolume, fBgmFade,
    fTemperature, fMaxTokens, fText,
    // 交互状态
    opErr, opBusy, formTouched, expandBusy,
    entOpen, entKind, entList, entLoading, entBusy, entErr,
    // 派生视图
    genSpec, canCancelRun, readinessNotes, sourceNode, sourceAsset, currentMaskId, capHint, bgmOptions, canExtractFrame,
  })

  return {
    form,
    // —— 视图层（index 解构直用；函数下传面板子组件）——
    genSpec, opErr, opBusy, formTouched, frameBusy, canExtractFrame, fVariants, frameMode, frameTime, runTitle,
    incoming, outgoing, edgeFrom, edgeTo,
    doRun, doCancel, doExtractFrame, removeNode, dropEdge,
    saveSpec, openExpand, doExpand, applyExpand, doExtract, saveText,
    openBrush, onMaskSaved, showBrush, sourceAsset,
    expandOpen, expandBusy, expandErr, expandDraft, expandInstruction, expandSrc,
    cancelTaskRow, adoptResult, toggleEntities, attachTo, openRunDetail, cancelRun,
  }
}

/** form 状态总线类型（M28 装配）：供各面板子组件 props 标注 */
export type InspectorForm = ReturnType<typeof useInspectorForm>['form']
/** composable 返回 API 类型：子组件函数 props 以索引类型标注，签名漂移自动同步 */
export type InspectorApi = ReturnType<typeof useInspectorForm>
