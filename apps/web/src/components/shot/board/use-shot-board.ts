/**
 * 镜头工作台状态与操作（自 ShotBoard.vue 逐字迁移）
 * —— 装配约定：函数体逐字保留；props/emit 经参数注入；包裹层缩进 +2（机械转换）
 * —— sb 状态总线（reactive 代理）：供模板与各面板子组件安全读写全部状态
 * —— 操作域（时长/重排/上传/编辑器/重合成/合成设置/音效/收藏清理）拆至 use-shot-board-ops.ts（行为零变更）
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { assetApi, shotApi } from '../../../lib/api'
import { confirmDialog } from '../../../lib/confirm'
import { composeInputReworkApi, ReworkApiError } from '../../../lib/api/rework'
import { newRequestKey } from '../../../lib/api/creation-chat'
import type { ComposeInputChangeView, ComposeInputPreviewView } from '../../../lib/types/rework'
import type {
  Asset,
  ComposeConfig,
  ComposeTransition,
  ShotBoardData,
  ShotBoardShot,
  ShotEditItem,
  ShotPick,
  ShotVersion,
} from '../../../lib/types'
import { studioOff, studioOn } from '../../../lib/socket'
import type { StudioEventMap } from '../../../lib/socket'
import { useShotBoardOps } from './use-shot-board-ops'
import type { ShotBoardEmitFn, ShotBoardProps } from './internals'

export function useShotBoard(props: ShotBoardProps, emit: ShotBoardEmitFn) {
  const board = ref<ShotBoardData | null>(null)
  const loading = ref(false)
  const err = ref('')
  const notice = ref('')
  const opBusy = ref(false)
  let timer: number | undefined

  // draft：版本选用 / 剔除（本地，统一经「应用选择」提交）
  const draftSelected = ref<Record<string, number>>({})
  const draftExcluded = ref<string[]>([])
  // 批量时长勾选与输入
  const bulkPicked = ref<string[]>([])
  const bulkDuration = ref('')
  // 时长输入本地缓冲（未提交时优先展示用户输入）
  const durationDrafts = ref<Record<string, string>>({})
  // 改词区（单开）/ 版本画廊（单开）
  const promptShotId = ref<string | null>(null)
  const promptDraft = ref('')
  const galleryShotId = ref<string | null>(null)
  // 缩略图加载失败集合（回退占位）
  const thumbFailed = ref<string[]>([])

  // 产物预览
  const previewOpen = ref(false)
  const previewAssets = ref<Asset[]>([])
  const previewIndex = ref(0)
  const previewBusy = ref(false)

  // 大编辑器 / 拖拽重排 / 上传替换
  const editorOpen = ref(false)
  const dragShotId = ref<string | null>(null)
  const dropTarget = ref<{ shotId: string; side: 'left' | 'right' } | null>(
    null,
  )
  const uploadShotId = ref<string | null>(null)
  const uploadBusy = ref(false)
  const uploadInput = ref<HTMLInputElement | null>(null)

  const composeCfg = ref<ComposeConfig | null>(null)
  const cfgTransition = ref<ComposeTransition>('none')
  const cfgDur = ref(0.5)
  const cfgBusy = ref(false)
  const bgm = ref<Asset | null>(null)
  const composeSettingsOpen = ref(false)
  // 合成返修可用性（成片已产出→候选改选走本地返修闸；仅换版本可表达，结构性启用/剔除仍走原草稿+重合成）
  const composeRework = ref<{ supported: boolean; message: string }>({ supported: false, message: '' })
  // per-shot 音效（shotId → 绑定资产；镜头卡片「音效」按钮用）
  const sfxMap = ref<Record<string, Asset>>({})
  const sfxShotId = ref<string | null>(null)

  const shots = computed(() => board.value?.shots ?? [])
  const compose = computed(() => board.value?.compose ?? null)
  const repairable = computed(
    () => board.value?.repairable ?? { ok: false, reason: null },
  )
  const locked = computed(() => props.active || opBusy.value)
  const canOperate = computed(() => repairable.value.ok && !locked.value)
  // 审阅闸门暂停：整块工作台仍锁（canOperate=false），但逐镜重出可用——只点亮「重生成该镜」按钮，
  // 选片 / 上传 / 重合成 / 级联仍走 canOperate（闸门下保持禁用），与后端 gatePause 放行口径一一对应。
  const gateRegenerate = computed(() => board.value?.gateRegenerate === true)
  const canRegenerate = computed(
    () => !locked.value && (repairable.value.ok || gateRegenerate.value),
  )
  // 闸门改词（后端 gateEdit 仅对非轻松创作下发 true）：点亮改词铅笔/提示词框/保存/保存并重生成；
  // 轻松创作批准链冻结 prompt，gateEdit=false → 仍只可同词重出（与后端 creation_prompt_locked 硬拒同口径）。
  const gateEdit = computed(() => board.value?.gateEdit === true)
  const canEdit = computed(
    () => !locked.value && (repairable.value.ok || gateEdit.value),
  )
  const isVideoStep = computed(() => props.step.actionKey === 'ai_video')

  const summary = computed(() => {
    const total = shots.value.length
    const done = shots.value.filter((s) => s.versions.length > 0).length
    const failed = shots.value.filter((s) => s.task?.status === 'failed').length
    return `${total} 镜 · 已出 ${done}${failed ? ` · 失败 ${failed}` : ''}`
  })

  // 提示词主字段（ai_video=动效词；其余=出图词）
  const promptField = computed<'image_prompt' | 'motion_prompt'>(() =>
    isVideoStep.value ? 'motion_prompt' : 'image_prompt',
  )
  const promptFieldLabel = computed(() =>
    isVideoStep.value ? '动效提示词' : '出图提示词',
  )

  // ---- 操作域装配：函数体逐字在 use-shot-board-ops；同名解构保持装配面不变 ----
  const {
    durationValue,
    onDurationInput,
    commitDuration,
    applyBulkDuration,
    onGripDragStart,
    onCardDragOver,
    onCardDragLeave,
    clearDrag,
    onCardDrop,
    pickUpload,
    onUploadPicked,
    openEditor,
    onEditorSaved,
    doRecompose,
    cfgDirty,
    loadComposeCfg,
    saveTransition,
    openSfx,
    onSfxChanged,
    lineIdsOf,
    verQualityWarn,
    selectedQualityWarn,
    toggleVersionFavorite,
    doCleanupVersions,
  } = useShotBoardOps({
    props,
    emit,
    run,
    load,
    err,
    notice,
    opBusy,
    shots,
    compose,
    canOperate,
    selectedVersion,
    durationDrafts,
    bulkPicked,
    bulkDuration,
    dragShotId,
    dropTarget,
    uploadShotId,
    uploadBusy,
    uploadInput,
    editorOpen,
    composeCfg,
    cfgTransition,
    cfgDur,
    cfgBusy,
    bgm,
    sfxMap,
    sfxShotId,
  })

  // ---------- 数据加载 ----------

  async function load() {
    loading.value = true
    err.value = ''
    try {
      const data = await shotApi.board(props.runId, props.step.stepKey)
      board.value = data
      emit('compose', data.compose)
      // draft 清理：已不存在的镜头 / 已失效的版本
      const shotIds = new Set(data.shots.map((s) => s.shotId))
      draftExcluded.value = draftExcluded.value.filter((id) => shotIds.has(id))
      bulkPicked.value = bulkPicked.value.filter((id) => shotIds.has(id))
      const nextSel: Record<string, number> = {}
      for (const [sid, aid] of Object.entries(draftSelected.value)) {
        const shot = data.shots.find((s) => s.shotId === sid)
        if (shot?.versions.some((v) => v.id === aid)) nextSel[sid] = aid
      }
      draftSelected.value = nextSel
      const nextDur: Record<string, string> = {}
      for (const [sid, raw] of Object.entries(durationDrafts.value)) {
        if (shotIds.has(sid)) nextDur[sid] = raw
      }
      durationDrafts.value = nextDur
      if (data.compose?.stepKey) void probeComposeRework(data.compose.stepKey)
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  /** 操作封装：busy → 执行 → 成功 notice + 重拉 / 失败 err */
  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    if (locked.value) return null
    opBusy.value = true
    err.value = ''
    notice.value = ''
    try {
      const r = await fn()
      await load()
      return r
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
      return null
    } finally {
      opBusy.value = false
    }
  }

  // ---------- 选择模型 ----------

  /** 有效选中版本：draft > 当前 output 选中 > 最新版本 */
  function effSelected(shot: ShotBoardShot): number | null {
    const d = draftSelected.value[shot.shotId]
    if (d !== undefined) return d
    if (shot.selectedAssetId !== null) return shot.selectedAssetId
    return shot.versions.length
      ? shot.versions[shot.versions.length - 1]!.id
      : null
  }

  /** 启用态：draft 排除优先；显式选版 = 启用；否则以「在 output 中」为初始启用 */
  function isEnabled(shot: ShotBoardShot): boolean {
    if (draftExcluded.value.includes(shot.shotId)) return false
    if (draftSelected.value[shot.shotId] !== undefined) return true
    return shot.selectedAssetId !== null
  }

  function selectedVersion(shot: ShotBoardShot): ShotVersion | null {
    const id = effSelected(shot)
    if (id !== null) {
      const v = shot.versions.find((x) => x.id === id)
      if (v) return v
    }
    return shot.versions.length
      ? shot.versions[shot.versions.length - 1]!
      : null
  }

  function thumbUrl(shot: ShotBoardShot): string | null {
    const v = selectedVersion(shot)
    if (!v) return null
    if (v.urls.thumb) return v.urls.thumb
    return isVideoStep.value ? null : v.urls.file
  }

  function markThumbFailed(shotId: string) {
    if (!thumbFailed.value.includes(shotId))
      thumbFailed.value = [...thumbFailed.value, shotId]
  }

  // 版本条缩略图加载失败集合（回退占位，避免破损图）
  const verThumbFailed = ref<number[]>([])
  function markVerThumbFailed(id: number) {
    if (!verThumbFailed.value.includes(id))
      verThumbFailed.value = [...verThumbFailed.value, id]
  }

  /** draft 变更计数（被禁用的有产物镜 + 版本切换/恢复启用） */
  const draftCount = computed(() => {
    let n = 0
    for (const s of shots.value) {
      if (draftExcluded.value.includes(s.shotId)) {
        if (s.versions.length > 0) n += 1
        continue
      }
      const d = draftSelected.value[s.shotId]
      if (d !== undefined && d !== s.selectedAssetId) n += 1
    }
    return n
  })

  function toggleEnable(shot: ShotBoardShot) {
    if (isEnabled(shot)) {
      if (!draftExcluded.value.includes(shot.shotId)) {
        draftExcluded.value = [...draftExcluded.value, shot.shotId]
      }
      return
    }
    // 启用：移出排除表；初始不在 output 中（历史剔除/未选）时锚定最新版本
    draftExcluded.value = draftExcluded.value.filter((id) => id !== shot.shotId)
    if (
      draftSelected.value[shot.shotId] === undefined &&
      shot.selectedAssetId === null
    ) {
      const last = shot.versions[shot.versions.length - 1]
      if (last) draftSelected.value[shot.shotId] = last.id
    }
  }

  function togglePick(shotId: string) {
    bulkPicked.value = bulkPicked.value.includes(shotId)
      ? bulkPicked.value.filter((id) => id !== shotId)
      : [...bulkPicked.value, shotId]
  }

  const allPicked = computed(
    () =>
      shots.value.length > 0 &&
      shots.value.every((s) => bulkPicked.value.includes(s.shotId)),
  )

  function toggleAll(e: Event) {
    const on = (e.target as HTMLInputElement).checked
    bulkPicked.value = on ? shots.value.map((s) => s.shotId) : []
  }

  function toggleGallery(shot: ShotBoardShot) {
    galleryShotId.value =
      galleryShotId.value === shot.shotId ? null : shot.shotId
  }

  function pickVersion(shot: ShotBoardShot, assetId: number) {
    if (
      shot.selectedAssetId === assetId &&
      draftExcluded.value.includes(shot.shotId)
    ) {
      draftExcluded.value = draftExcluded.value.filter(
        (id) => id !== shot.shotId,
      )
    } else if (shot.selectedAssetId === assetId) {
      delete draftSelected.value[shot.shotId]
    } else {
      draftSelected.value[shot.shotId] = assetId
    }
    galleryShotId.value = null
  }

  // ---------- 选片提交 / 恢复默认 ----------

  async function applySelection() {
    const picks: ShotPick[] = []
    for (const s of shots.value) {
      if (!isEnabled(s)) continue
      const aid = effSelected(s)
      if (aid === null) continue
      picks.push({ shot_id: s.shotId, asset_id: aid })
    }
    if (picks.length === 0) {
      err.value = '至少保留一个有产物的镜头才能应用选择'
      return
    }
    // 合成返修闸：成片已产出且本次为「纯换版本」（候选改选）→ 走 preview→确认→本地重合成；
    // 结构性启用/剔除镜头不在 compose-input 四类内，保持原草稿直写 + 手动重合成（T5 在重合成时仍复验指纹/作废旧 gate）。
    if (composeRework.value.supported && !hasStructuralSelection()) {
      const changes = selectionReworkChanges()
      if (changes.length > 0) {
        await applySelectionViaRework(changes)
        return
      }
    }
    const res = await run(() =>
      shotApi.select(props.runId, props.step.stepKey, { picks }),
    )
    if (res) {
      draftSelected.value = {}
      draftExcluded.value = []
      notice.value = '镜头选择已应用（重新合成后生效）'
    }
  }

  /** 是否存在结构性改动（剔除当前在用镜 / 新启用未曾入选的镜）——这些不属于候选改选 */
  function hasStructuralSelection(): boolean {
    return shots.value.some((s) => {
      if (draftExcluded.value.includes(s.shotId) && s.selectedAssetId !== null) return true
      if (draftSelected.value[s.shotId] !== undefined && s.selectedAssetId === null) return true
      return false
    })
  }

  /** 暂存的纯换版本 → shot-select 变更集（仅当前已入选且版本改变的镜） */
  function selectionReworkChanges(): ComposeInputChangeView[] {
    const changes: ComposeInputChangeView[] = []
    for (const s of shots.value) {
      const d = draftSelected.value[s.shotId]
      if (d === undefined || s.selectedAssetId === null) continue
      if (d !== s.selectedAssetId) changes.push({ kind: 'shot-select', shotId: s.shotId, assetId: d })
    }
    return changes
  }

  /** 版本 id → 名称（未命中降级 #id） */
  function versionNameOf(shotId: string, assetId: unknown): string {
    if (assetId === null || assetId === undefined) return '（无）'
    const v = shots.value.find((x) => x.shotId === shotId)?.versions.find((x) => x.id === assetId)
    return v ? v.name : `#${String(assetId)}`
  }

  /** 确认文案：逐镜旧→新（取服务端 diff）+ 成本/影响诚实（前端零推算） */
  function buildSelectionConfirmMessage(pv: ComposeInputPreviewView): string {
    const lines = pv.diffs
      .filter((d) => d.kind === 'shot-select')
      .map((d) => `· 镜头 ${d.field}：${versionNameOf(d.field, d.before)} → ${versionNameOf(d.field, d.after)}`)
    const impact = pv.impact.resetSteps.length ? `重置步骤：${pv.impact.resetSteps.join('、')}` : ''
    return [
      ...lines,
      '',
      '本地重新合成：0 次模型调用、不计费，但需编码时间。',
      impact,
      '新版本需重新复核：旧成片批准不自动沿用。',
    ]
      .filter(Boolean)
      .join('\n')
  }

  /** 候选改选走合成返修闸：幂等预览→确认（携 previewHash）→本地重合成入队 */
  async function applySelectionViaRework(changes: ComposeInputChangeView[]): Promise<void> {
    if (opBusy.value) return
    const stepKey = compose.value?.stepKey ?? 'compose'
    const key = newRequestKey('selrw')
    opBusy.value = true
    err.value = ''
    notice.value = ''
    try {
      const pv = await composeInputReworkApi.preview(props.runId, key, changes, stepKey)
      const ok = await confirmDialog({
        title: '确认候选改选并本地重合成',
        message: buildSelectionConfirmMessage(pv.preview),
        confirmText: '确认并本地重合成',
        cancelText: '取消',
      })
      if (!ok) return
      await composeInputReworkApi.apply(props.runId, pv.request_id, pv.preview.previewHash)
      draftSelected.value = {}
      draftExcluded.value = []
      notice.value = '候选改选已确认：本地重合成已入队，旧成片批准已作废待复审'
      await load()
    } catch (e) {
      err.value = e instanceof ReworkApiError ? e.message : e instanceof Error ? e.message : '候选改选失败'
    } finally {
      opBusy.value = false
    }
  }

  /** 合成返修能力探测（单一真源，不前端自行判断；失败降级为不支持→回退直写） */
  async function probeComposeRework(stepKey: string): Promise<void> {
    try {
      const c = await composeInputReworkApi.capability(props.runId, stepKey)
      composeRework.value = { supported: c.capability.supported, message: c.capability.message }
    } catch {
      composeRework.value = { supported: false, message: '' }
    }
  }

  async function resetSelection() {
    const res = await run(() =>
      shotApi.select(props.runId, props.step.stepKey, { reset: true }),
    )
    if (res) {
      draftSelected.value = {}
      draftExcluded.value = []
      bulkPicked.value = []
      notice.value = '已恢复全量默认（全部有产物镜头 × 最新版本）'
    }
  }

  // ---------- 提示词编辑 / 单镜重生成 ----------

  function primaryPromptOf(shot: ShotBoardShot): string {
    return isVideoStep.value ? shot.motionPrompt : shot.imagePrompt
  }

  function togglePrompt(shot: ShotBoardShot) {
    if (promptShotId.value === shot.shotId) {
      promptShotId.value = null
      return
    }
    promptShotId.value = shot.shotId
    promptDraft.value = primaryPromptOf(shot)
  }

  function buildPromptItem(shot: ShotBoardShot, text: string): ShotEditItem {
    const item: ShotEditItem = { shot_id: shot.shotId }
    if (isVideoStep.value) item.motion_prompt = text
    else item.image_prompt = text
    return item
  }

  async function savePrompt(shot: ShotBoardShot) {
    if (!canEdit.value) return
    const text = promptDraft.value.trim()
    if (!text) {
      err.value = '提示词不能为空'
      return
    }
    if (text === primaryPromptOf(shot)) {
      notice.value = '提示词无变化'
      return
    }
    const res = await run(() =>
      shotApi.edit(props.runId, props.step.stepKey, [
        buildPromptItem(shot, text),
      ]),
    )
    if (res) {
      promptShotId.value = null
      notice.value = '提示词已保存到分镜（重生成 / 重新合成后生效）'
    }
  }

  async function doRegenerate(shot: ShotBoardShot, withPrompt = false) {
    if (!canRegenerate.value) return
    if (withPrompt && !canEdit.value) return
    const text = promptDraft.value.trim()
    const dirty = withPrompt && text !== '' && text !== primaryPromptOf(shot)
    const ok = await confirmDialog({
      title: '重生成镜头',
      message: `将重新调用供应商生成「${shot.shotId}」${dirty ? '（使用新提示词）' : ''}，重新计费；其余镜头自动跳过。完成后镜头列表与选片状态会重建（上传替换需重新应用）。`,
      confirmText: '开始重生成',
    })
    if (!ok) return
    const item: ShotEditItem = dirty
      ? buildPromptItem(shot, text)
      : { shot_id: shot.shotId }
    const res = await run(() =>
      shotApi.regenerate(props.runId, props.step.stepKey, item),
    )
    if (res) {
      promptShotId.value = null
      notice.value =
        '已入队：仅目标镜重跑；完成后镜头列表重建，请重新选择 / 合成'
      emit('changed')
    }
  }

  /** 预览器重检结果：同步预览列表对象 + 刷新 board 徽标 */
  function onPreviewAssetChanged(updated: Asset) {
    previewAssets.value = previewAssets.value.map((a) =>
      a.id === updated.id ? updated : a,
    )
    void load()
  }

  // ---------- 预览 ----------

  async function openPreview(shot: ShotBoardShot, firstId?: number) {
    if (previewBusy.value || !shot.versions.length) return
    previewBusy.value = true
    err.value = ''
    try {
      const list = await Promise.all(
        shot.versions.map((v) => assetApi.detail(v.id).then((r) => r.asset)),
      )
      const target =
        firstId ??
        effSelected(shot) ??
        shot.versions[shot.versions.length - 1]!.id
      previewAssets.value = list
      previewIndex.value = Math.max(
        0,
        shot.versions.findIndex((v) => v.id === target),
      )
      previewOpen.value = true
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
    } finally {
      previewBusy.value = false
    }
  }

  // ---------- 实时刷新 ----------

  let reloadTimer: number | undefined

  /** task.updated 高频 → 防抖合并刷新（500ms 尾沿；3s 轮询与 step.status watch 兜底） */
  function scheduleReload() {
    if (reloadTimer) window.clearTimeout(reloadTimer)
    reloadTimer = window.setTimeout(() => {
      reloadTimer = undefined
      void load()
    }, 500)
  }

  function onTaskUpdated(p: StudioEventMap['task.updated']) {
    if (p.runId !== props.runId) return
    scheduleReload()
  }

  onMounted(() => {
    void load()
    studioOn('task.updated', onTaskUpdated)
    timer = window.setInterval(() => {
      if (props.active) void load()
    }, 3000)
  })

  onBeforeUnmount(() => {
    studioOff('task.updated', onTaskUpdated)
    if (timer) window.clearInterval(timer)
    if (reloadTimer) window.clearTimeout(reloadTimer)
  })

  watch(
    () => props.active,
    (v) => {
      if (!v) void loadComposeCfg()
    },
  )

  watch(
    () => compose.value !== null,
    (v) => {
      if (v && !props.active) void loadComposeCfg()
    },
  )

  watch(
    () => props.step.status,
    () => {
      void load()
    },
  )

  // ---- sb 状态总线（装配新增；reactive 代理解包 ref/computed，模板与子组件读写均安全）----
  const sb = reactive({
    // 数据
    board,
    loading,
    err,
    notice,
    opBusy,
    // draft / 交互状态
    draftSelected,
    draftExcluded,
    bulkPicked,
    bulkDuration,
    durationDrafts,
    promptShotId,
    promptDraft,
    galleryShotId,
    thumbFailed,
    verThumbFailed,
    previewOpen,
    previewAssets,
    previewIndex,
    previewBusy,
    editorOpen,
    dragShotId,
    dropTarget,
    uploadShotId,
    uploadBusy,
    uploadInput,
    composeCfg,
    cfgTransition,
    cfgDur,
    cfgBusy,
    bgm,
    composeSettingsOpen,
    sfxMap,
    sfxShotId,
    // 派生视图
    shots,
    compose,
    repairable,
    locked,
    canOperate,
    gateRegenerate,
    canRegenerate,
    gateEdit,
    canEdit,
    isVideoStep,
    summary,
    promptField,
    promptFieldLabel,
    draftCount,
    allPicked,
    cfgDirty,
  })

  return {
    sb,
    // —— 视图层（index 解构直用；函数下传卡片/画廊/合成行子组件）——
    loading,
    err,
    notice,
    shots,
    compose,
    repairable,
    canOperate,
    canRegenerate,
    canEdit,
    summary,
    draftCount,
    allPicked,
    previewOpen,
    previewAssets,
    previewIndex,
    editorOpen,
    composeSettingsOpen,
    sfxShotId,
    sfxMap,
    uploadInput,
    isVideoStep,
    bulkDuration,
    bulkPicked,
    openEditor,
    doRecompose,
    applySelection,
    toggleAll,
    applyBulkDuration,
    doCleanupVersions,
    resetSelection,
    onUploadPicked,
    onPreviewAssetChanged,
    loadComposeCfg,
    onSfxChanged,
    onEditorSaved,
    saveTransition,
    isEnabled,
    openPreview,
    thumbUrl,
    markThumbFailed,
    lineIdsOf,
    selectedQualityWarn,
    onCardDragOver,
    onCardDragLeave,
    onCardDrop,
    onGripDragStart,
    clearDrag,
    togglePick,
    toggleEnable,
    durationValue,
    onDurationInput,
    commitDuration,
    togglePrompt,
    doRegenerate,
    pickUpload,
    toggleGallery,
    openSfx,
    savePrompt,
    effSelected,
    verQualityWarn,
    toggleVersionFavorite,
    markVerThumbFailed,
    pickVersion,
  }
}

/** sb 状态总线类型（装配）：供子组件 props 标注 */
export type ShotBoardState = ReturnType<typeof useShotBoard>['sb']
/** composable 返回 API 类型：子组件函数 props 以索引类型标注，签名漂移自动同步 */
export type ShotBoardApi = ReturnType<typeof useShotBoard>
