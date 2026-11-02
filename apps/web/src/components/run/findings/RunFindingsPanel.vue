<script setup lang="ts">
/**
 * M69 审片问题单面板（运行详情右栏，RunQcPanel 同级之后）。
 * - 只读播放器 + 镜头条定位；问题创建/关联返修/复检/人工终判。
 * - 一切状态、能力、证据文案来自服务端投影；复检 changed/unchanged 都不自动判过。
 * - 无成片且无历史问题单时整体隐藏；cancelled 只读（仍可改描述）。
 */
import { computed, onMounted, reactive, ref, toRef, watch } from 'vue'
import Icon from '../../common/Icon.vue'
import { findingsApi } from '../../../lib/api/findings'
import type { FindingView } from '../../../lib/types/findings'
import SubtitleReworkModal from '../subtitle-rework/SubtitleReworkModal.vue'
import ComposeInputReworkModal from '../compose-input-rework/ComposeInputReworkModal.vue'
import FindingForm from './FindingForm.vue'
import {
  CATEGORY_TEXT,
  RECHECK_TEXT,
  SEVERITY_BADGE,
  SEVERITY_TEXT,
  STATUS_BADGE,
  STATUS_TEXT,
  type FindingFormState,
  type FindingSegment,
} from './finding-ui'
import { useRunFindings } from './use-run-findings'

const props = defineProps<{
  runId: number
  projectId: number
  stepKey?: string
  /** 父级 run-detail 每次重载递增（run.updatedAt）：重新合成完成时同步刷新问题单 */
  refreshToken?: number
}>()

const {
  data,
  loading,
  acting,
  hidden,
  errText,
  notice,
  currentMs,
  formatMs,
  segments,
  totalMs,
  finalAssetId,
  currentShot,
  sortedFindings,
  load,
  setMs,
  seekTo,
  act,
  allowedScopes,
} = useRunFindings(toRef(props, 'runId'), props.stepKey ?? 'compose')

const videoEl = ref<HTMLVideoElement | null>(null)
/** 返修前/后对照：null = 当前成片；否则播放基准成片（base_final_asset_id） */
const compareId = ref<number | null>(null)
const srcUrl = computed(() => {
  const id = compareId.value ?? finalAssetId.value
  return id === null ? '' : `/api/v1/assets/${id}/file`
})

/** 换源后待应用的定位（毫秒）：媒体元素换 src 会自行重置，metadata 就绪后再 seek */
const pendingSeekMs = ref<number | null>(null)

function compareTo(f: FindingView): void {
  // 切到基准成片，并落到该问题的位置（spec §4.8-6：切源并 seek 到问题时间）
  const at = f.currentLocation?.startMs ?? f.startMs ?? 0
  compareId.value = f.baseFinalAssetId
  pendingSeekMs.value = at
  setMs(at)
}

function backToCurrent(): void {
  // 切回当前成片时保留当前时刻，便于同一画面对照
  const at = currentMs.value
  compareId.value = null
  pendingSeekMs.value = at
  setMs(at)
}

function onLoadedMetadata(): void {
  if (pendingSeekMs.value === null) return
  const at = pendingSeekMs.value
  pendingSeekMs.value = null
  if (videoEl.value) videoEl.value.currentTime = Math.max(0, at / 1000)
}

function onVideoError(): void {
  // 基准资产行可能已被删除：不猜、不白屏，切回当前成片并说明真实原因
  if (compareId.value !== null) {
    compareId.value = null
    notice.value = '基准成片文件不可用（可能已删除），已切回当前成片'
    return
  }
  notice.value = '当前成片文件不可用（可能未落盘或已删除）'
}
const showForm = ref(false)
const form = reactive<FindingFormState>({
  category: 'visual',
  severity: 'major',
  scopeKind: 'shot',
  shotId: '',
  startMs: 0,
  endMs: 2000,
  note: '',
})

const scopes = computed(() => allowedScopes(form.category))
const canCreate = computed(() => data.value?.capability.writable === true)
const needsShot = computed(() => form.scopeKind === 'shot')
/** 图片混剪等无镜头段的时间轴：镜头范围无锚点可选，默认落到时间窗 */
const hasShotSegments = computed(() => segments.value.some((s) => s.shotId))

type SegmentView = FindingSegment

/** 镜头条点击：seek + 预选该镜范围（类别不允许 shot 时只 seek） */
function pickSegment(s: SegmentView): void {
  seekTo(s.startMs, videoEl.value)
  if (!s.shotId) return
  form.startMs = s.startMs
  form.endMs = s.endMs
  if (!scopes.value.includes('shot')) return
  form.scopeKind = 'shot'
  form.shotId = s.shotId
  if (canCreate.value) showForm.value = true
}

const modal = ref<{ kind: 'subtitle' | 'compose'; findingId: number } | null>(
  null,
)

function openForm(): void {
  showForm.value = true
  form.shotId = currentShot.value?.shotId ?? ''
  form.startMs = Math.floor(currentMs.value)
  form.endMs = Math.min(totalMs.value, Math.floor(currentMs.value) + 2000)
  form.note = ''
  // 无镜头段（图片混剪）：shot 范围没有可选项，默认改为时间窗，避免提交按钮永远禁用
  if (!hasShotSegments.value && scopes.value.includes('time'))
    form.scopeKind = 'time'
}

async function submit(): Promise<void> {
  if (!canCreate.value) return
  const scope =
    form.scopeKind === 'shot'
      ? { kind: 'shot' as const, shot_id: form.shotId }
      : form.scopeKind === 'time'
        ? { kind: 'time' as const, start_ms: form.startMs, end_ms: form.endMs }
        : { kind: 'global' as const }
  const clientKey = `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await act(
    () =>
      findingsApi.create(props.runId, {
        client_key: clientKey,
        step_key: props.stepKey ?? 'compose',
        category: form.category,
        severity: form.severity,
        note: form.note,
        scope,
      }),
    '问题已记录',
  )
  if (!errText.value) showForm.value = false
}

function locate(f: FindingView): void {
  if (!f.currentLocation) return
  if (f.scopeKind === 'shot' && f.currentLocation.inRange) {
    const el = document.getElementById(`shot-${f.shotId}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('finding-flash')
      window.setTimeout(() => el.classList.remove('finding-flash'), 1600)
      return
    }
    // 锚点不存在（该镜不在当前页/已删）：明确告知，不静默失败，同时仍在播放器定位
    notice.value = '未找到镜头卡锚点，请在镜头工作台手动定位'
  }
  seekTo(f.currentLocation.startMs, videoEl.value)
}

function onTimeUpdate(e: Event): void {
  const el = e.target as HTMLVideoElement | null
  if (el) setMs(el.currentTime * 1000)
}

function onAppliedModal(requestId: string): void {
  const id = modal.value?.findingId
  const f = id ? sortedFindings.value.find((x) => x.id === id) : undefined
  if (f) void linkRequest(f, requestId)
}

function jumpToMark(): void {
  const loc = sortedFindings.value.find(
    (f) => f.currentLocation,
  )?.currentLocation
  if (loc) seekTo(loc.startMs, videoEl.value)
}

function verify(f: FindingView, result: 'verified' | 'reopened'): void {
  if (finalAssetId.value === null) return
  const note = window.prompt(
    result === 'verified' ? '确认已修复（可选备注）' : '仍未修复（可选备注）',
  )
  if (note === null) return // 取消 ≠ 空备注：不执行终判
  void act(
    () =>
      findingsApi.verify(props.runId, f.id, {
        result,
        final_asset_id: finalAssetId.value!,
        note: note.trim() || undefined,
      }),
    result === 'verified' ? '已确认修复' : '已重新打开',
  )
}

function dismiss(f: FindingView): void {
  const note = window.prompt('忽略原因（可选）')
  if (note === null) return // 取消不执行忽略
  void act(
    () => findingsApi.dismiss(props.runId, f.id, note.trim() || undefined),
    '已忽略',
  )
}

async function linkRequest(f: FindingView, requestId: string): Promise<void> {
  await act(() => findingsApi.link(props.runId, f.id, requestId), '已关联返修')
  modal.value = null
}

onMounted(load)
// 父级重新合成完成会重载 run（updatedAt 变）→ 同步刷新，避免面板停在旧成片
watch(
  () => props.refreshToken,
  () => {
    void load()
  },
)
</script>

<template>
  <div v-if="!hidden" class="panel mini findings">
    <div class="lhead">
      <span class="lt"><Icon name="flag" :size="13" /> 审片问题</span>
      <span
        v-if="data"
        class="badge"
        :class="data.summary.blockers_open ? 'failed' : 'skip'"
      >
        {{ data.summary.open + data.summary.in_rework }} 待处理
      </span>
      <span class="grow" />
      <button
        class="btn sm"
        :disabled="loading"
        title="刷新问题单"
        @click="load"
      >
        <Icon name="refresh" :size="12" />
      </button>
    </div>

    <div v-if="loading && !data" class="empty" style="padding: 8px 0">
      读取中…
    </div>
    <div v-else-if="errText && !data" class="empty err" style="padding: 8px 0">
      {{ errText }}
    </div>
    <p v-else-if="data && !data.capability.writable" class="muted cap">
      {{ data.capability.message }}
    </p>

    <template v-if="data">
      <!-- 播放器 -->
      <div v-if="finalAssetId !== null" class="player">
        <video
          ref="videoEl"
          :src="srcUrl"
          controls
          preload="metadata"
          @timeupdate="onTimeUpdate"
          @loadedmetadata="onLoadedMetadata"
          @error="onVideoError"
        />
        <div class="ptime mono">
          {{ formatMs(currentMs) }} / {{ formatMs(totalMs) }}
          <span v-if="currentShot?.shotId" class="badge skip">{{
            currentShot.shotId
          }}</span>
          <span v-else-if="currentShot" class="badge cancelled"
            >无镜头标记</span
          >
          <span v-else class="badge cancelled">片头/片尾/空隙</span>
          <span v-if="compareId !== null" class="badge queued">返修前</span>
          <button
            v-if="compareId !== null"
            class="btn sm"
            @click="backToCurrent"
          >
            回到当前
          </button>
          <span class="grow" />
          <button
            class="btn sm"
            :disabled="!sortedFindings.some((f) => f.currentLocation)"
            @click="jumpToMark"
          >
            跳到首个问题
          </button>
        </div>
      </div>
      <div v-else class="noplayer muted">当前无成片（仅可查看历史问题单）</div>

      <!-- 镜头条：缩略图 + 镜号 + 起点；点击 seek 并预选该镜 -->
      <div v-if="segments.length" class="strip">
        <button
          v-for="s in segments"
          :key="s.shotId ?? s.startMs"
          class="chip"
          :class="{ active: currentShot?.startMs === s.startMs }"
          :title="`${s.shotId ?? '镜头'} ${formatMs(s.startMs)}–${formatMs(s.endMs)}`"
          @click="pickSegment(s)"
        >
          <img
            v-if="s.assetId !== null"
            class="cthumb"
            :src="`/api/v1/assets/${s.assetId}/thumb`"
            alt=""
            loading="lazy"
          />
          <span>{{ s.shotId ?? '—' }}</span>
          <span class="ctime">{{ formatMs(s.startMs) }}</span>
        </button>
      </div>

      <!-- 新建 -->
      <template v-if="canCreate">
        <button v-if="!showForm" class="btn sm full" @click="openForm">
          <Icon name="plus" :size="12" /> 记录当前画面问题
        </button>
        <FindingForm
          v-else
          v-model="form"
          :segments="segments"
          :acting="acting"
          :needs-shot="needsShot"
          :format-ms="formatMs"
          @submit="submit"
          @cancel="showForm = false"
        />
      </template>

      <p v-if="notice" class="muted okmsg">{{ notice }}</p>
      <p v-if="errText" class="err">{{ errText }}</p>

      <!-- 列表 -->
      <div class="rows">
        <div v-for="f in sortedFindings" :key="f.id" class="frow-card">
          <div class="rline">
            <span class="rk"
              >{{ CATEGORY_TEXT[f.category] }} ·
              {{
                f.scopeKind === 'shot'
                  ? f.shotId
                  : f.scopeKind === 'time'
                    ? `${formatMs(f.startMs ?? 0)}–${formatMs(f.endMs ?? 0)}`
                    : '全片'
              }}</span
            >
            <span class="badge" :class="SEVERITY_BADGE[f.severity]">{{
              SEVERITY_TEXT[f.severity]
            }}</span>
            <span class="grow" />
            <span class="badge" :class="STATUS_BADGE[f.status]">{{
              STATUS_TEXT[f.status]
            }}</span>
          </div>
          <div class="fnote">{{ f.note }}</div>
          <div v-if="f.reworkNote" class="muted sub">
            返修备注：{{ f.reworkNote }}
          </div>
          <div v-if="f.needsRecheck" class="warn">新成片已生成，待复检</div>
          <div v-if="f.staleRecheck" class="warn">
            成片在复检后又变了，请重新复检
          </div>
          <div v-if="f.recheck" class="recheck">
            <span
              class="badge"
              :class="
                f.recheck.state === 'changed'
                  ? 'queued'
                  : f.recheck.state === 'unchanged'
                    ? 'skip'
                    : 'cancelled'
              "
            >
              {{ RECHECK_TEXT[f.recheck.state] }}
            </span>
            <span class="muted">{{ f.recheck.note }}</span>
          </div>
          <div v-if="f.resolutionNote" class="muted sub">
            结论：{{ f.resolutionNote }}
          </div>
          <div class="actions">
            <button v-if="f.currentLocation" class="btn sm" @click="locate(f)">
              {{ f.scopeKind === 'shot' ? '定位镜头' : '跳转时间' }}
            </button>
            <!-- 返修前/后对照：只有基准成片与当前成片不同（即确认换过片）才提供 -->
            <button
              v-if="
                compareId === null &&
                f.baseAvailable &&
                f.baseFinalAssetId !== finalAssetId
              "
              class="btn sm"
              @click="compareTo(f)"
            >
              看返修前
            </button>
            <button
              v-else-if="compareId !== null && compareId === f.baseFinalAssetId"
              class="btn sm"
              @click="backToCurrent"
            >
              回到当前
            </button>
            <button
              v-if="f.can.markRework"
              class="btn sm"
              :disabled="acting"
              @click="
                act(
                  () => findingsApi.markRework(props.runId, f.id),
                  '已标记返修',
                )
              "
            >
              标记已返修
            </button>
            <button
              v-if="f.can.recheck"
              class="btn sm"
              :disabled="acting"
              @click="
                act(
                  () => findingsApi.recheck(props.runId, f.id),
                  '复检完成，请人工确认',
                )
              "
            >
              复检
            </button>
            <template v-if="f.can.verify">
              <button
                class="btn sm primary"
                :disabled="acting"
                @click="verify(f, 'verified')"
              >
                确认已修复
              </button>
              <button
                class="btn sm"
                :disabled="acting"
                @click="verify(f, 'reopened')"
              >
                仍未修复
              </button>
            </template>
            <button
              v-if="f.can.reopen"
              class="btn sm"
              :disabled="acting"
              @click="
                act(() => findingsApi.reopen(props.runId, f.id), '已重新打开')
              "
            >
              重新打开
            </button>
            <button
              v-if="f.can.dismiss"
              class="btn sm"
              :disabled="acting"
              @click="dismiss(f)"
            >
              忽略
            </button>
            <button
              v-if="f.can.markRework && f.category === 'subtitle'"
              class="btn sm"
              @click="modal = { kind: 'subtitle', findingId: f.id }"
            >
              字幕返修
            </button>
            <button
              v-if="
                f.can.markRework &&
                (f.category === 'audio' || f.category === 'pacing')
              "
              class="btn sm"
              @click="modal = { kind: 'compose', findingId: f.id }"
            >
              合成输入返修
            </button>
          </div>
        </div>
        <div v-if="!sortedFindings.length" class="empty" style="padding: 6px 0">
          还没有问题单
        </div>
      </div>

      <p class="foot muted">
        复检只说明证据是否变化，不等于修好；视觉/口型/听感仍需人看片确认。
      </p>
    </template>

    <SubtitleReworkModal
      v-if="modal?.kind === 'subtitle'"
      :run-id="runId"
      :step-key="props.stepKey ?? 'compose'"
      @close="modal = null"
      @applied="onAppliedModal"
    />
    <ComposeInputReworkModal
      v-if="modal?.kind === 'compose' && projectId"
      :run-id="runId"
      :project-id="projectId"
      :step-key="props.stepKey ?? 'compose'"
      @close="modal = null"
      @applied="onAppliedModal"
    />
  </div>
</template>

<style scoped>
.mini {
  padding: 10px 14px;
}
.lhead {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.lt {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
  font-size: 13px;
}
.grow {
  flex: 1;
}
.cap {
  font-size: 11px;
  margin: 4px 0 8px;
}
.player video {
  width: 100%;
  border-radius: 6px;
  background: #000;
  display: block;
}
.ptime {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  margin: 4px 0 6px;
}
.strip {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  padding: 2px 8px 2px 2px;
  border-radius: 999px;
  border: 1px solid rgb(148 163 184 / 25%);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}
.chip.active {
  border-color: var(--accent, #6366f1);
  color: var(--text);
}
.cthumb {
  width: 26px;
  height: 18px;
  object-fit: cover;
  border-radius: 999px;
  background: #000;
}
.ctime {
  font-size: 10px;
  opacity: 0.75;
}
.noplayer {
  font-size: 11px;
  padding: 8px 0;
}
.full {
  width: 100%;
  justify-content: center;
}
.rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 420px;
  overflow-y: auto;
}
.frow-card {
  border: 1px solid rgb(148 163 184 / 14%);
  border-radius: 8px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rline {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.rk {
  font-weight: 500;
}
.fnote {
  font-size: 12px;
  line-height: 1.5;
}
.sub {
  font-size: 11px;
}
.recheck {
  display: flex;
  gap: 6px;
  align-items: baseline;
  font-size: 11px;
}
.warn {
  font-size: 11px;
  color: #d97706;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
.okmsg {
  color: #16a34a;
  font-size: 11px;
}
.err {
  color: #dc2626;
  font-size: 11px;
}
.foot {
  font-size: 10px;
  line-height: 1.6;
  margin-top: 6px;
}
:global(.finding-flash) {
  outline: 2px solid #f59e0b;
  outline-offset: 2px;
  transition: outline-color 0.3s;
}
</style>
