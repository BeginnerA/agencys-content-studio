<script setup lang="ts">
/**
 * [M7] 镜头级轻工作台（spec §3.5）
 * 挂载：RunDetailView 步骤卡内（actionKey ∈ {ai_image, ai_video}）
 * 交互约定（写死）：
 * - 时长编辑：change 即提交（单条 edit），刷新后输入框保留新值
 * - 版本选用 / 启用开关：本地 draft，头条「应用选择」统一提交 select
 * - 重生成：即时提交（可选改词），执行进度由 TaskPanel / socket 呈现
 * - 重新合成：确认弹窗 → recompose；active（run 运行中）时全部操作禁用
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { assetApi, shotApi } from '../lib/api'
import { confirmDialog } from '../lib/confirm'
import { fmtTime, taskStatus } from '../lib/format'
import type { Asset, RunStep, ShotBoardData, ShotBoardShot, ShotEditItem, ShotPick, ShotVersion } from '../lib/types'
import { studioOff, studioOn } from '../lib/socket'
import type { StudioEventMap } from '../lib/socket'
import AssetPreviewer from './AssetPreviewer.vue'
import Icon from './Icon.vue'

const props = defineProps<{ runId: number; step: RunStep; active: boolean }>()
const emit = defineEmits<{ changed: []; compose: [info: ShotBoardData['compose']] }>()

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
    message: `将重新调用供应商生成「${shot.shotId}」${dirty ? '（使用新提示词）' : ''}，重新计费；其余镜头自动跳过。完成后镜头列表与选片状态会重建。`,
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
  () => props.step.status,
  () => {
    void load()
  },
)
</script>

<template>
  <div class="wb">
    <!-- 头条：汇总 + stale 徽标 + 合成 / 应用选择 -->
    <div class="wb-head">
      <span class="wb-title"><Icon name="sliders" :size="13" /> 镜头工作台</span>
      <span class="muted wb-sum">{{ summary }}</span>
      <span
        v-if="compose?.stale === true"
        class="wb-tag warn"
        title="镜头选择 / 分镜 / 时长有更新，重新合成后生效"
      >
        <Icon name="alert" :size="11" /> 待重新合成
      </span>
      <span v-else-if="compose?.stale === false" class="wb-tag ok" title="成片与当前选择一致">合成已最新</span>
      <span class="grow" />
      <button v-if="compose" class="btn sm" :disabled="!canOperate" @click="doRecompose">
        <Icon name="film" :size="12" /> 重新合成
      </button>
      <button class="btn sm" :class="{ primary: draftCount > 0 }" :disabled="!canOperate || draftCount === 0" @click="applySelection">
        <Icon name="check" :size="12" /> 应用选择{{ draftCount ? ` (${draftCount})` : '' }}
      </button>
    </div>

    <div v-if="!repairable.ok && repairable.reason" class="wb-lock">
      <Icon name="alert" :size="12" /> {{ repairable.reason }}
    </div>
    <div v-else-if="props.active" class="wb-lock muted">
      <Icon name="clock" :size="12" /> run 执行中，返修操作暂不可用（完成后自动刷新）
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="notice" class="wb-notice"><Icon name="check" :size="12" /> {{ notice }}</div>

    <!-- 批量工具行 -->
    <div class="wb-tools">
      <label class="wb-ck" title="全选：批量时长应用目标">
        <input type="checkbox" :checked="allPicked" :disabled="!shots.length" @change="toggleAll" /> 全选
      </label>
      <span class="muted">批量时长</span>
      <input
        v-model="bulkDuration"
        type="number"
        min="0.5"
        max="60"
        step="0.5"
        placeholder="秒"
        class="wb-num"
        :disabled="!canOperate"
      />
      <button class="btn sm" :disabled="!canOperate || !bulkPicked.length" @click="applyBulkDuration">应用</button>
      <span v-if="bulkPicked.length" class="muted">已勾选 {{ bulkPicked.length }} 镜</span>
      <span class="grow" />
      <button class="btn sm" :disabled="!canOperate" @click="resetSelection">恢复全量默认</button>
    </div>

    <!-- 镜头网格 -->
    <div class="wb-grid">
      <div
        v-for="shot in shots"
        :key="shot.shotId"
        class="wb-card"
        :class="{ off: !isEnabled(shot), fail: shot.task?.status === 'failed' }"
      >
        <div class="wb-thumb" :title="`预览镜头 ${shot.shotId}`" @click="openPreview(shot)">
          <img
            v-if="thumbUrl(shot) && !thumbFailed.includes(shot.shotId)"
            :src="thumbUrl(shot)!"
            :alt="shot.shotId"
            loading="lazy"
            @error="markThumbFailed(shot.shotId)"
          />
          <span v-else class="wb-ph"><Icon :name="isVideoStep ? 'play' : 'photo'" :size="22" /></span>
          <span v-if="shot.versions.length > 1" class="wb-vcount">{{ shot.versions.length }} 版</span>
          <span v-if="draftSelected[shot.shotId] !== undefined" class="wb-dot" title="已切换版本（待应用）" />
        </div>

        <div class="wb-meta">
          <label class="wb-ck" title="勾选参与批量时长">
            <input type="checkbox" :checked="bulkPicked.includes(shot.shotId)" @change="togglePick(shot.shotId)" />
          </label>
          <span class="wb-id mono">{{ shot.shotId }}</span>
          <span v-if="shot.task" class="badge" :class="shot.task.status" :title="shot.task.errorMsg ?? ''">
            {{ taskStatus(shot.task.status).text }}
          </span>
          <span v-else class="badge pending">无任务</span>
          <span class="grow" />
          <button
            class="wb-eye"
            :class="{ off: !isEnabled(shot) }"
            :disabled="!canOperate || !shot.versions.length"
            :title="!shot.versions.length ? '暂无产物版本' : isEnabled(shot) ? '停用：不进成片（应用选择后生效）' : '启用：纳入成片'"
            @click="toggleEnable(shot)"
          >
            <Icon name="eye" :size="13" />
          </button>
        </div>

        <div class="wb-row">
          <span class="muted wb-lb">时长</span>
          <input
            type="number"
            class="wb-num"
            min="0.5"
            max="60"
            step="0.5"
            placeholder="默认"
            :value="durationValue(shot)"
            :disabled="!canOperate"
            @input="onDurationInput(shot, $event)"
            @blur="commitDuration(shot)"
            @keyup.enter="commitDuration(shot)"
          />
          <span class="muted">s</span>
          <span class="grow" />
          <button class="wb-mini" :disabled="!canOperate" @click="togglePrompt(shot)">
            {{ promptShotId === shot.shotId ? '收起' : '改词' }}
          </button>
          <button
            class="wb-mini"
            :disabled="!canOperate || !shot.task"
            :title="shot.task ? '重生成该镜（重新计费）' : '该镜无生成任务'"
            @click="doRegenerate(shot)"
          >
            重生成
          </button>
          <button class="wb-mini" :disabled="!shot.versions.length" @click="toggleGallery(shot)">
            版本 {{ shot.versions.length }}
          </button>
        </div>

        <div v-if="promptShotId === shot.shotId" class="wb-prompt">
          <div class="muted wb-lb">{{ promptFieldLabel }}</div>
          <textarea v-model="promptDraft" rows="3" spellcheck="false" :disabled="!canOperate"></textarea>
          <div class="wb-pa">
            <button class="btn sm" :disabled="!canOperate" @click="savePrompt(shot)">保存到分镜</button>
            <button class="btn sm" :disabled="!canOperate" @click="doRegenerate(shot, true)">保存并重生成</button>
          </div>
        </div>

        <div v-if="galleryShotId === shot.shotId" class="wb-gallery">
          <div
            v-for="v in shot.versions"
            :key="v.id"
            class="wb-ver"
            :class="{ sel: effSelected(shot) === v.id }"
          >
            <div class="wb-vthumb" :title="`预览 ${v.name}`" @click="openPreview(shot, v.id)">
              <img v-if="v.urls.thumb" :src="v.urls.thumb" :alt="v.name" loading="lazy" />
              <span v-else class="wb-ph sm"><Icon :name="isVideoStep ? 'play' : 'photo'" :size="14" /></span>
            </div>
            <div class="wb-vmeta">
              <span class="muted mono wb-vtime">{{ fmtTime(v.createdAt) }}</span>
              <button class="wb-mini" :disabled="!canOperate" @click="pickVersion(shot, v.id)">
                {{ effSelected(shot) === v.id ? '当前' : '选用' }}
              </button>
            </div>
          </div>
          <div v-if="!shot.versions.length" class="muted wb-tip">暂无历史版本</div>
        </div>

        <div v-if="shot.task?.errorMsg" class="wb-err mono" :title="shot.task.errorMsg">{{ shot.task.errorMsg }}</div>
      </div>

      <div v-if="!shots.length && !loading" class="empty wb-empty">无镜头数据（分镜为空或解析失败）</div>
    </div>

    <AssetPreviewer v-if="previewOpen" :assets="previewAssets" :index="previewIndex" @close="previewOpen = false" />
  </div>
</template>

<style scoped>
.wb {
  margin-top: 10px;
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}

.wb-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 6px;
}

.wb-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
}

.wb-sum {
  font-size: 12px;
}

.wb-lock {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--warn);
  background: var(--warn-weak);
  border: 1px solid rgb(245 158 11 / 20%);
  border-radius: 8px;
  padding: 5px 10px;
  margin: 6px 0;
}

.wb-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ok);
  background: var(--ok-weak);
  border: 1px solid rgb(34 197 94 / 20%);
  border-radius: 8px;
  padding: 5px 10px;
  margin: 6px 0;
}

/* stale 徽标三态（true=warn / false=ok；null 不显示） */
.wb-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  border-radius: 999px;
  padding: 1px 9px;
  border: 1px solid transparent;
}

.wb-tag.warn {
  color: var(--warn);
  background: var(--warn-weak);
  border-color: rgb(245 158 11 / 24%);
}

.wb-tag.ok {
  color: var(--ok);
  background: var(--ok-weak);
  border-color: rgb(34 197 94 / 22%);
}

/* ---------- 批量工具行 ---------- */
.wb-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  margin: 6px 0;
}

.wb-ck {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  flex: none;
}

.wb-ck input {
  accent-color: var(--accent);
  cursor: pointer;
}

.wb-num {
  width: 64px;
  background: var(--code-bg);
  border: 1px solid var(--border-strong);
  color: var(--text);
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 12px;
  font-family: inherit;
}

.wb-num:disabled {
  opacity: 0.5;
}

/* ---------- 镜头网格 ---------- */
.wb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(156px, 1fr));
  gap: 10px;
  margin-top: 8px;
}

.wb-card {
  border: 1px solid var(--border);
  background: var(--panel-2);
  border-radius: 10px;
  overflow: hidden;
  min-width: 0;
  transition: border-color 0.15s, opacity 0.2s;
}

.wb-card:hover {
  border-color: var(--border-strong);
}

/* 停用：半透明 + 缩略图去饱和 */
.wb-card.off {
  opacity: 0.55;
}

.wb-card.off .wb-thumb img {
  filter: grayscale(0.9);
}

.wb-card.fail {
  border-color: rgb(248 113 113 / 34%);
}

.wb-thumb {
  position: relative;
  display: block;
  aspect-ratio: 3 / 4;
  background: var(--img-ph);
  cursor: zoom-in;
  overflow: hidden;
}

.wb-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.wb-ph {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--text-3);
  background: radial-gradient(112% 78% at 50% 8%, rgb(99 102 241 / 12%), transparent 62%), var(--img-ph);
}

.wb-ph.sm {
  position: static;
  width: 100%;
  height: 100%;
}

.wb-vcount {
  position: absolute;
  right: 5px;
  bottom: 5px;
  font-size: 10.5px;
  color: #fff;
  background: rgb(10 14 24 / 62%);
  backdrop-filter: blur(4px);
  border-radius: 999px;
  padding: 0 7px;
}

.wb-dot {
  position: absolute;
  left: 5px;
  top: 5px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-h);
  box-shadow: 0 0 0 3px rgb(139 92 246 / 25%);
}

.wb-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px 0;
}

.wb-id {
  font-size: 11px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-meta .badge {
  font-size: 10.5px;
  line-height: 17px;
  padding: 0 7px;
  flex: none;
}

.wb-eye {
  border: none;
  background: none;
  color: var(--accent-h);
  cursor: pointer;
  padding: 2px;
  display: inline-flex;
  flex: none;
}

.wb-eye.off {
  color: var(--text-3);
  opacity: 0.7;
}

.wb-eye:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.wb-row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 7px;
  font-size: 12px;
  flex-wrap: wrap;
}

.wb-lb {
  font-size: 11.5px;
}

.wb-mini {
  border: none;
  background: none;
  color: var(--accent-h);
  font-size: 11.5px;
  cursor: pointer;
  padding: 0 2px;
  transition: color 0.15s;
  flex: none;
}

.wb-mini:hover {
  color: #fff;
  text-decoration: underline;
}

.wb-mini:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  text-decoration: none;
}

/* ---------- 改词区 ---------- */
.wb-prompt {
  padding: 0 7px 7px;
}

.wb-prompt textarea {
  width: 100%;
  background: var(--code-bg);
  border: 1px solid var(--border-strong);
  color: var(--text);
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 12px;
  font-family: inherit;
  resize: vertical;
  margin-top: 4px;
}

.wb-pa {
  display: flex;
  gap: 6px;
  margin-top: 5px;
}

/* ---------- 版本画廊 ---------- */
.wb-gallery {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding: 0 7px 8px;
}

.wb-ver {
  flex: none;
  width: 72px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--panel);
}

.wb-ver.sel {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgb(99 102 241 / 22%);
}

.wb-vthumb {
  aspect-ratio: 3 / 4;
  background: var(--img-ph);
  cursor: zoom-in;
  overflow: hidden;
}

.wb-vthumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.wb-vmeta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 3px 5px;
}

.wb-vtime {
  font-size: 9.5px;
  white-space: nowrap;
  overflow: hidden;
}

.wb-tip {
  font-size: 11.5px;
}

.wb-err {
  margin: 0 7px 7px;
  font-size: 11px;
  color: var(--bad);
  background: var(--bad-weak);
  border-radius: 6px;
  padding: 4px 7px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wb-empty {
  grid-column: 1 / -1;
  padding: 18px 0;
}

@media (prefers-reduced-motion: reduce) {
  .wb-card,
  .wb-mini {
    transition: none;
  }
}
</style>
