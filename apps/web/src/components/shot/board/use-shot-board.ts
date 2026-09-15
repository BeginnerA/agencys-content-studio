/**
 * [M28] 镜头工作台状态与操作（自 ShotBoard.vue 逐字迁移）
 * —— 装配约定：函数体逐字保留；props/emit 经参数注入；包裹层缩进 +2（机械转换）
 * —— sb 状态总线（reactive 代理）：供模板与各面板子组件安全读写全部状态
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { assetApi, composeApi, shotApi } from '../../../lib/api'
import { confirmDialog } from '../../../lib/confirm'
import { qualityText } from '../../../lib/format'
import type {
  Asset, ComposeConfig, ComposeTransition, ShotBoardData, ShotBoardShot, ShotEditItem, ShotPick, ShotVersion,
} from '../../../lib/types'
import { studioOff, studioOn } from '../../../lib/socket'
import type { StudioEventMap } from '../../../lib/socket'
import { asTransition } from './internals'
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

  // [M10] 大编辑器 / 拖拽重排 / 上传替换
  const editorOpen = ref(false)
  const dragShotId = ref<string | null>(null)
  const dropTarget = ref<{ shotId: string; side: 'left' | 'right' } | null>(null)
  const uploadShotId = ref<string | null>(null)
  const uploadBusy = ref(false)
  const uploadInput = ref<HTMLInputElement | null>(null)


  const composeCfg = ref<ComposeConfig | null>(null)
  const cfgTransition = ref<ComposeTransition>('none')
  const cfgDur = ref(0.5)
  const cfgBusy = ref(false)
  const bgm = ref<Asset | null>(null)
  const composeSettingsOpen = ref(false)
  // [M19] per-shot 音效（shotId → 绑定资产；镜头卡片「音效」按钮用）
  const sfxMap = ref<Record<string, Asset>>({})
  const sfxShotId = ref<string | null>(null)


  const shots = computed(() => board.value?.shots ?? [])
  const compose = computed(() => board.value?.compose ?? null)
  const repairable = computed(() => board.value?.repairable ?? { ok: false, reason: null })
  const locked = computed(() => props.active || opBusy.value)
  const canOperate = computed(() => repairable.value.ok && !locked.value)
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
  const promptFieldLabel = computed(() => (isVideoStep.value ? '动效提示词' : '出图提示词'))


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
    return shot.versions.length ? shot.versions[shot.versions.length - 1]!.id : null
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
    return shot.versions.length ? shot.versions[shot.versions.length - 1]! : null
  }

  function thumbUrl(shot: ShotBoardShot): string | null {
    const v = selectedVersion(shot)
    if (!v) return null
    if (v.urls.thumb) return v.urls.thumb
    return isVideoStep.value ? null : v.urls.file
  }

  function markThumbFailed(shotId: string) {
    if (!thumbFailed.value.includes(shotId)) thumbFailed.value = [...thumbFailed.value, shotId]
  }

  // 版本条缩略图加载失败集合（回退占位，避免破损图）
  const verThumbFailed = ref<number[]>([])
  function markVerThumbFailed(id: number) {
    if (!verThumbFailed.value.includes(id)) verThumbFailed.value = [...verThumbFailed.value, id]
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
    if (draftSelected.value[shot.shotId] === undefined && shot.selectedAssetId === null) {
      const last = shot.versions[shot.versions.length - 1]
      if (last) draftSelected.value[shot.shotId] = last.id
    }
  }

  function togglePick(shotId: string) {
    bulkPicked.value = bulkPicked.value.includes(shotId)
      ? bulkPicked.value.filter((id) => id !== shotId)
      : [...bulkPicked.value, shotId]
  }

  const allPicked = computed(() => shots.value.length > 0 && shots.value.every((s) => bulkPicked.value.includes(s.shotId)))

  function toggleAll(e: Event) {
    const on = (e.target as HTMLInputElement).checked
    bulkPicked.value = on ? shots.value.map((s) => s.shotId) : []
  }

  function toggleGallery(shot: ShotBoardShot) {
    galleryShotId.value = galleryShotId.value === shot.shotId ? null : shot.shotId
  }

  function pickVersion(shot: ShotBoardShot, assetId: number) {
    if (shot.selectedAssetId === assetId && draftExcluded.value.includes(shot.shotId)) {
      draftExcluded.value = draftExcluded.value.filter((id) => id !== shot.shotId)
    } else if (shot.selectedAssetId === assetId) {
      delete draftSelected.value[shot.shotId]
    } else {
      draftSelected.value[shot.shotId] = assetId
    }
    galleryShotId.value = null
  }


  // ---------- 时长编辑（change 即提交） ----------

  function durationValue(shot: ShotBoardShot): string {
    const d = durationDrafts.value[shot.shotId]
    if (d !== undefined) return d
    return shot.duration === null ? '' : String(shot.duration)
  }

  function onDurationInput(shot: ShotBoardShot, e: Event) {
    durationDrafts.value[shot.shotId] = (e.target as HTMLInputElement).value
  }

  async function commitDuration(shot: ShotBoardShot) {
    const raw = durationDrafts.value[shot.shotId]
    if (raw === undefined) return
    if (raw.trim() === '') {
      delete durationDrafts.value[shot.shotId]
      return
    }
    const v = Number(raw)
    if (!Number.isFinite(v) || v <= 0 || v > 60) {
      err.value = `镜头 ${shot.shotId} 时长需在 (0, 60] 秒内`
      return
    }
    const rounded = Math.round(v * 10) / 10
    if (shot.duration !== null && rounded === shot.duration) {
      delete durationDrafts.value[shot.shotId]
      return
    }
    const res = await run(() => shotApi.edit(props.runId, props.step.stepKey, [{ shot_id: shot.shotId, duration: rounded }]))
    if (res) {
      delete durationDrafts.value[shot.shotId]
      notice.value = `镜头 ${shot.shotId} 时长 ${rounded}s 已保存（重新合成后生效）`
    }
  }

  async function applyBulkDuration() {
    const v = Number(bulkDuration.value)
    if (!Number.isFinite(v) || v <= 0 || v > 60) {
      err.value = '批量时长需在 (0, 60] 秒内'
      return
    }
    if (!bulkPicked.value.length) {
      err.value = '先勾选要应用时长的镜头'
      return
    }
    const items: ShotEditItem[] = bulkPicked.value.map((sid) => ({ shot_id: sid, duration: Math.round(v * 10) / 10 }))
    const res = await run(() => shotApi.edit(props.runId, props.step.stepKey, items))
    if (res) {
      bulkPicked.value = []
      bulkDuration.value = ''
      notice.value = `已更新 ${res.edited} 个镜头时长（重新合成后生效）`
    }
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
    const res = await run(() => shotApi.select(props.runId, props.step.stepKey, { picks }))
    if (res) {
      draftSelected.value = {}
      draftExcluded.value = []
      notice.value = '镜头选择已应用（重新合成后生效）'
    }
  }

  async function resetSelection() {
    const res = await run(() => shotApi.select(props.runId, props.step.stepKey, { reset: true }))
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
    const text = promptDraft.value.trim()
    if (!text) {
      err.value = '提示词不能为空'
      return
    }
    if (text === primaryPromptOf(shot)) {
      notice.value = '提示词无变化'
      return
    }
    const res = await run(() => shotApi.edit(props.runId, props.step.stepKey, [buildPromptItem(shot, text)]))
    if (res) {
      promptShotId.value = null
      notice.value = '提示词已保存到分镜（重生成 / 重新合成后生效）'
    }
  }

  async function doRegenerate(shot: ShotBoardShot, withPrompt = false) {
    const text = promptDraft.value.trim()
    const dirty = withPrompt && text !== '' && text !== primaryPromptOf(shot)
    const ok = await confirmDialog({
      title: '重生成镜头',
      message: `将重新调用供应商生成「${shot.shotId}」${dirty ? '（使用新提示词）' : ''}，重新计费；其余镜头自动跳过。完成后镜头列表与选片状态会重建（上传替换需重新应用）。`,
      confirmText: '开始重生成',
    })
    if (!ok) return
    const item: ShotEditItem = dirty ? buildPromptItem(shot, text) : { shot_id: shot.shotId }
    const res = await run(() => shotApi.regenerate(props.runId, props.step.stepKey, item))
    if (res) {
      promptShotId.value = null
      notice.value = '已入队：仅目标镜重跑；完成后镜头列表重建，请重新选择 / 合成'
      emit('changed')
    }
  }


  // ---------- [M10] 拖拽重排 ----------

  function onGripDragStart(shot: ShotBoardShot, e: DragEvent) {
    if (!canOperate.value) return
    dragShotId.value = shot.shotId
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', shot.shotId)
    }
  }

  function onCardDragOver(shot: ShotBoardShot, e: DragEvent) {
    if (!canOperate.value || !dragShotId.value || dragShotId.value === shot.shotId) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const side = e.clientX - rect.left < rect.width / 2 ? 'left' : 'right'
    dropTarget.value = { shotId: shot.shotId, side }
  }

  function onCardDragLeave(shot: ShotBoardShot, e: DragEvent) {
    const card = e.currentTarget as HTMLElement
    if (e.relatedTarget instanceof Node && card.contains(e.relatedTarget)) return
    if (dropTarget.value?.shotId === shot.shotId) dropTarget.value = null
  }

  function clearDrag() {
    dragShotId.value = null
    dropTarget.value = null
  }

  async function onCardDrop(shot: ShotBoardShot, e: DragEvent) {
    const src = dragShotId.value
    let side: 'left' | 'right' = 'left'
    if (dropTarget.value?.shotId === shot.shotId) {
      side = dropTarget.value.side
    } else {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      side = e.clientX - rect.left < rect.width / 2 ? 'left' : 'right'
    }
    clearDrag()
    if (!canOperate.value || !src || src === shot.shotId) return
    const ids = shots.value.map((s) => s.shotId)
    const without = ids.filter((id) => id !== src)
    const targetIdx = without.indexOf(shot.shotId)
    if (targetIdx < 0) return
    without.splice(side === 'left' ? targetIdx : targetIdx + 1, 0, src)
    if (without.join(',') === ids.join(',')) return
    const res = await run(() => shotApi.mutate(props.runId, props.step.stepKey, [{ op: 'reorder', order: without }]))
    if (res) notice.value = '镜头顺序已更新（重新合成后生效）'
  }


  // ---------- [M10] 上传替换 ----------

  function pickUpload(shot: ShotBoardShot) {
    if (!canOperate.value || uploadBusy.value) return
    uploadShotId.value = shot.shotId
    uploadInput.value?.click()
  }

  async function onUploadPicked(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    const shotId = uploadShotId.value
    uploadShotId.value = null
    if (!file || !shotId || !canOperate.value) return
    const ok = await confirmDialog({
      title: '上传替换镜头',
      message: `将上传「${file.name}」作为镜头 ${shotId} 的产物并设为当前选中（重新合成后生效；整步重跑会重建产物，需重新应用）。`,
      confirmText: '上传替换',
    })
    if (!ok) return
    uploadBusy.value = true
    err.value = ''
    notice.value = ''
    try {
      await shotApi.uploadShot(props.runId, props.step.stepKey, shotId, file)
      await load()
      notice.value = `镜头 ${shotId} 已替换为上传文件（重新合成后生效）`
    } catch (ex) {
      err.value = ex instanceof Error ? ex.message : String(ex)
    } finally {
      uploadBusy.value = false
    }
  }


  // ---------- [M10] 大编辑器 ----------

  function openEditor() {
    if (!canOperate.value) return
    editorOpen.value = true
  }

  function onEditorSaved() {
    editorOpen.value = false
    notice.value = '分镜已保存（重新合成后生效）'
    void load()
  }


  // ---------- 重新合成 ----------

  async function doRecompose() {
    const c = compose.value
    if (!c) return
    const ok = await confirmDialog({
      title: '重新合成',
      message: '将重新执行合成（镜头选择 / 分镜 / 时长的最新值生效）；已成功的镜头步骤全部跳过。',
      confirmText: '重新合成',
    })
    if (!ok) return
    const res = await run(() => shotApi.recompose(props.runId, c.stepKey))
    if (res) {
      notice.value = '已重新入队合成（进度见步骤时间线与日志）'
      emit('changed')
    }
  }

  // ---------- [M11] 合成设置 ----------



  const cfgDirty = computed(() => {
    const c = composeCfg.value
    if (!c) return false
    const curT = asTransition(c.transition)
    const curD = typeof c.transition_duration === 'number' ? c.transition_duration : 0.5
    return cfgTransition.value !== curT || cfgDur.value !== curD
  })

  /** 配置回显（活跃期服务端拒绝 → 静默降级 null；run 收敛后 watch 补拉） */
  async function loadComposeCfg() {
    if (!compose.value) {
      composeCfg.value = null
      sfxMap.value = {}
      return
    }
    try {
      const r = await composeApi.getConfig(props.runId)
      composeCfg.value = r.config
      cfgTransition.value = asTransition(r.config.transition)
      cfgDur.value = typeof r.config.transition_duration === 'number' ? r.config.transition_duration : 0.5
      const b = await composeApi.getBgm(props.runId)
      bgm.value = b.bgm
      const s = await composeApi.listSfx(props.runId)
      const m: Record<string, Asset> = {}
      for (const it of s.items) m[it.shotId] = it.asset
      sfxMap.value = m
    } catch {
      composeCfg.value = null
    }
  }

  async function saveTransition() {
    if (!canOperate.value || !composeCfg.value) return
    cfgBusy.value = true
    err.value = ''
    notice.value = ''
    try {
      const dur = Math.min(2, Math.max(0.1, Number(cfgDur.value) || 0.5))
      const r = await composeApi.updateConfig(props.runId, {
        transition: cfgTransition.value,
        transition_duration: dur,
      })
      composeCfg.value = r.config
      cfgDur.value = dur
      notice.value = '合成设置已保存（重新合成后生效）'
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
    } finally {
      cfgBusy.value = false
    }
  }


  // ---------- [M19] 镜头音效（SFX） ----------

  function openSfx(shot: ShotBoardShot) {
    if (!canOperate.value) return
    sfxShotId.value = shot.shotId
  }

  /** 弹窗内操作成功后重拉列表（弹窗内已提示，不重复 notice） */
  async function onSfxChanged() {
    try {
      const s = await composeApi.listSfx(props.runId)
      const m: Record<string, Asset> = {}
      for (const it of s.items) m[it.shotId] = it.asset
      sfxMap.value = m
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** 台词角标：分镜 raw.lines（字符串数组） */
  function lineIdsOf(shot: ShotBoardShot): string[] {
    const l = shot.raw['lines']
    return Array.isArray(l) ? l.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []
  }


  // ---------- [M12] 收藏 / 质量徽标 / 版本清理 ----------

  /** 版本质量异常文案（ok===false 才返回；null/正常不显示徽标） */
  function verQualityWarn(v: ShotVersion): string | null {
    if (!v.quality || v.quality.ok !== false) return null
    return qualityText(v.quality.reason)
  }

  /** 当前有效选中版本的异常提示（主缩略图角标） */
  function selectedQualityWarn(shot: ShotBoardShot): string | null {
    const v = selectedVersion(shot)
    return v ? verQualityWarn(v) : null
  }

  /** 收藏切换（本地即时更新；不整板重拉） */
  async function toggleVersionFavorite(v: ShotVersion) {
    if (opBusy.value) return
    err.value = ''
    const next = v.isFavorite !== 1
    try {
      const r = await assetApi.favorite(v.id, next)
      v.isFavorite = r.asset.isFavorite
      notice.value = next ? `版本 ${v.name} 已收藏（清理时保留）` : '已取消收藏'
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** 版本组批量清理（每组保留最新 / 收藏 / 在用；软删可回溯） */
  async function doCleanupVersions() {
    const ok = await confirmDialog({
      title: '清理旧版本',
      message: '将清理本步骤的历史产物：每个镜头保留最新 1 版、已收藏的、以及正在使用的（成片引用）；其余软删除（回收空间前可回溯）。不影响当前选中与成片。',
      confirmText: '开始清理',
    })
    if (!ok) return
    const res = await run(() => shotApi.cleanup(props.runId, props.step.stepKey))
    if (res) {
      notice.value = res.cleaned > 0 ? `已清理 ${res.cleaned} 个历史版本（保留 ${res.kept} 个）` : '没有可清理的历史版本'
    }
  }

  /** 预览器重检结果：同步预览列表对象 + 刷新 board 徽标 */
  function onPreviewAssetChanged(updated: Asset) {
    previewAssets.value = previewAssets.value.map((a) => (a.id === updated.id ? updated : a))
    void load()
  }

  // ---------- 预览 ----------

  async function openPreview(shot: ShotBoardShot, firstId?: number) {
    if (previewBusy.value || !shot.versions.length) return
    previewBusy.value = true
    err.value = ''
    try {
      const list = await Promise.all(shot.versions.map((v) => assetApi.detail(v.id).then((r) => r.asset)))
      const target = firstId ?? effSelected(shot) ?? shot.versions[shot.versions.length - 1]!.id
      previewAssets.value = list
      previewIndex.value = Math.max(0, shot.versions.findIndex((v) => v.id === target))
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

  // ---- sb 状态总线（M28 装配新增；reactive 代理解包 ref/computed，模板与子组件读写均安全）----
  const sb = reactive({
    // 数据
    board, loading, err, notice, opBusy,
    // draft / 交互状态
    draftSelected, draftExcluded, bulkPicked, bulkDuration, durationDrafts,
    promptShotId, promptDraft, galleryShotId, thumbFailed, verThumbFailed,
    previewOpen, previewAssets, previewIndex, previewBusy,
    editorOpen, dragShotId, dropTarget, uploadShotId, uploadBusy, uploadInput,
    composeCfg, cfgTransition, cfgDur, cfgBusy, bgm, composeSettingsOpen,
    sfxMap, sfxShotId,
    // 派生视图
    shots, compose, repairable, locked, canOperate, isVideoStep, summary,
    promptField, promptFieldLabel, draftCount, allPicked, cfgDirty,
  })

  return {
    sb,
    // —— 视图层（index 解构直用；函数下传卡片/画廊/合成行子组件）——
    loading, err, notice, shots, compose, repairable, canOperate, summary, draftCount, allPicked,
    previewOpen, previewAssets, previewIndex, editorOpen, composeSettingsOpen, sfxShotId, sfxMap,
    uploadInput, isVideoStep, bulkDuration, bulkPicked,
    openEditor, doRecompose, applySelection, toggleAll, applyBulkDuration, doCleanupVersions, resetSelection,
    onUploadPicked, onPreviewAssetChanged, loadComposeCfg, onSfxChanged, onEditorSaved, saveTransition,
    isEnabled, openPreview, thumbUrl, markThumbFailed, lineIdsOf, selectedQualityWarn,
    onCardDragOver, onCardDragLeave, onCardDrop, onGripDragStart, clearDrag,
    togglePick, toggleEnable, durationValue, onDurationInput, commitDuration,
    togglePrompt, doRegenerate, pickUpload, toggleGallery, openSfx, savePrompt,
    effSelected, verQualityWarn, toggleVersionFavorite, markVerThumbFailed, pickVersion,
  }
}

/** sb 状态总线类型（M28 装配）：供子组件 props 标注 */
export type ShotBoardState = ReturnType<typeof useShotBoard>['sb']
/** composable 返回 API 类型：子组件函数 props 以索引类型标注，签名漂移自动同步 */
export type ShotBoardApi = ReturnType<typeof useShotBoard>
