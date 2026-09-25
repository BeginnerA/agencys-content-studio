/**
 * 镜头工作台操作域（自 use-shot-board.ts 逐字搬出，行为零变更）：
 * 时长编辑 / 拖拽重排 / 上传替换 / 大编辑器 / 重新合成 / 合成设置 / 音效 / 版本收藏与清理。
 * —— 装配约定：状态真源（refs/computed/run/load/selectedVersion）经 ctx 注入，函数体逐字保留；
 * 主文件同名解构，return 键面与 sb 总线冻结。
 */
import { computed } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { assetApi, composeApi, shotApi } from '../../../lib/api'
import { confirmDialog } from '../../../lib/confirm'
import { qualityText } from '../../../lib/format'
import type {
  Asset,
  ComposeConfig,
  ComposeTransition,
  ShotBoardData,
  ShotBoardShot,
  ShotEditItem,
  ShotVersion,
} from '../../../lib/types'
import { asTransition } from './internals'
import type { ShotBoardEmitFn, ShotBoardProps } from './internals'

export function useShotBoardOps(ctx: {
  props: ShotBoardProps
  emit: ShotBoardEmitFn
  run: <T>(fn: () => Promise<T>) => Promise<T | null>
  load: () => Promise<void>
  err: Ref<string>
  notice: Ref<string>
  opBusy: Ref<boolean>
  shots: ComputedRef<ShotBoardShot[]>
  compose: ComputedRef<ShotBoardData['compose']>
  canOperate: ComputedRef<boolean>
  selectedVersion: (shot: ShotBoardShot) => ShotVersion | null
  durationDrafts: Ref<Record<string, string>>
  bulkPicked: Ref<string[]>
  bulkDuration: Ref<string>
  dragShotId: Ref<string | null>
  dropTarget: Ref<{ shotId: string; side: 'left' | 'right' } | null>
  uploadShotId: Ref<string | null>
  uploadBusy: Ref<boolean>
  uploadInput: Ref<HTMLInputElement | null>
  editorOpen: Ref<boolean>
  composeCfg: Ref<ComposeConfig | null>
  cfgTransition: Ref<ComposeTransition>
  cfgDur: Ref<number>
  cfgBusy: Ref<boolean>
  bgm: Ref<Asset | null>
  sfxMap: Ref<Record<string, Asset>>
  sfxShotId: Ref<string | null>
}) {
  const {
    props, emit, run, load, err, notice, opBusy, shots, compose, canOperate,
    selectedVersion, durationDrafts, bulkPicked, bulkDuration, dragShotId,
    dropTarget, uploadShotId, uploadBusy, uploadInput, editorOpen, composeCfg,
    cfgTransition, cfgDur, cfgBusy, bgm, sfxMap, sfxShotId,
  } = ctx

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
    const res = await run(() =>
      shotApi.edit(props.runId, props.step.stepKey, [
        { shot_id: shot.shotId, duration: rounded },
      ]),
    )
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
    const items: ShotEditItem[] = bulkPicked.value.map((sid) => ({
      shot_id: sid,
      duration: Math.round(v * 10) / 10,
    }))
    const res = await run(() =>
      shotApi.edit(props.runId, props.step.stepKey, items),
    )
    if (res) {
      bulkPicked.value = []
      bulkDuration.value = ''
      notice.value = `已更新 ${res.edited} 个镜头时长（重新合成后生效）`
    }
  }

  // ---------- 拖拽重排 ----------

  function onGripDragStart(shot: ShotBoardShot, e: DragEvent) {
    if (!canOperate.value) return
    dragShotId.value = shot.shotId
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', shot.shotId)
    }
  }

  function onCardDragOver(shot: ShotBoardShot, e: DragEvent) {
    if (
      !canOperate.value ||
      !dragShotId.value ||
      dragShotId.value === shot.shotId
    )
      return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const side = e.clientX - rect.left < rect.width / 2 ? 'left' : 'right'
    dropTarget.value = { shotId: shot.shotId, side }
  }

  function onCardDragLeave(shot: ShotBoardShot, e: DragEvent) {
    const card = e.currentTarget as HTMLElement
    if (e.relatedTarget instanceof Node && card.contains(e.relatedTarget))
      return
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
    const res = await run(() =>
      shotApi.mutate(props.runId, props.step.stepKey, [
        { op: 'reorder', order: without },
      ]),
    )
    if (res) notice.value = '镜头顺序已更新（重新合成后生效）'
  }

  // ---------- 上传替换 ----------

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

  // ---------- 大编辑器 ----------

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
      message:
        '将重新执行合成（镜头选择 / 分镜 / 时长的最新值生效）；已成功的镜头步骤全部跳过。',
      confirmText: '重新合成',
    })
    if (!ok) return
    const res = await run(() => shotApi.recompose(props.runId, c.stepKey))
    if (res) {
      notice.value = '已重新入队合成（进度见步骤时间线与日志）'
      emit('changed')
    }
  }

  // ---------- 合成设置 ----------

  const cfgDirty = computed(() => {
    const c = composeCfg.value
    if (!c) return false
    const curT = asTransition(c.transition)
    const curD =
      typeof c.transition_duration === 'number' ? c.transition_duration : 0.5
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
      cfgDur.value =
        typeof r.config.transition_duration === 'number'
          ? r.config.transition_duration
          : 0.5
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

  // ---------- 镜头音效（SFX） ----------

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
    return Array.isArray(l)
      ? l.filter((x): x is string => typeof x === 'string' && !!x.trim())
      : []
  }

  // ---------- 质量徽标 / 收藏 / 版本清理 ----------

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

  /** 版本组批量清理（每组保留最新 / 收藏 / 在用；其余移入回收站可还原） */
  async function doCleanupVersions() {
    const ok = await confirmDialog({
      title: '清理旧版本',
      message:
        '将清理本步骤的历史产物：每个镜头保留最新 1 版、已收藏的、以及正在使用的（成片引用）；其余移入回收站（可在资产页「回收站」还原）。不影响当前选中与成片。',
      confirmText: '开始清理',
    })
    if (!ok) return
    const res = await run(() =>
      shotApi.cleanup(props.runId, props.step.stepKey),
    )
    if (res) {
      notice.value =
        res.cleaned > 0
          ? `已清理 ${res.cleaned} 个历史版本（保留 ${res.kept} 个）`
          : '没有可清理的历史版本'
    }
  }

  return {
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
  }
}
