<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import AssetPreviewer from '../../components/asset/previewer/index.vue'
import CreationCandidates from './CreationCandidates.vue'
import CreationRework from './CreationRework.vue'
import Icon from '../../components/common/Icon.vue'
import { assetApi, creationChatApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import type { Asset, CreationArtifact, CreationCandidateStep, ShotBoardData } from '../../lib/types'
import type { useEasyCreate } from './use-creation-chat'

/**
 * [M42] 成果面板：逐镜成果（含复用标记）+ 候选版本选择 + 本地重新合成入口 + 局部返修入口。
 * 候选块只在「run 已收敛」且「该镜该模态有 >1 个可用候选」时出现：制作中不展示，避免对着半成品选版本。
 * 选片零计费、不改成片（只写在用指针），因此必须再走一次本地重新合成才落到成片 —— 由 selectionDirty 驱动提示。
 * 返修入口同样只给已收敛的 run（解析要先花一次文本模型费用，制作中不给出计费出口）。
 */
const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()
const artifacts = computed(() => props.s.state.detail?.artifacts)
const preview = ref<Asset | null>(null)
const loading = ref<number | null>(null)
const error = ref('')
const brokenThumbs = ref<number[]>([])
let request = 0
watch(() => props.s.state.currentId, () => {
  request++
  preview.value = null
  loading.value = null
  error.value = ''
  brokenThumbs.value = []
  resetCandidates()
})
// [M42] 返修成功后该镜会有新版本：候选缓存与展开态一并丢弃，下一轮投影回显后再重新拉 board
watch(() => props.s.rework.state.stamp, () => resetCandidates())

// ===== [M42] 候选版本：展开态 / 待应用选择 / board 缓存（按步共享，不逐镜重复拉） =====

const SETTLED = new Set(['completed', 'failed'])
const CANDIDATE_STEPS: CreationCandidateStep[] = ['images', 'frames', 'motion']
/** run 收敛才允许改版本（制作中产物还在长，选了也不知道最终是哪版） */
const settled = computed(() => SETTLED.has(props.s.state.detail?.progress?.status ?? ''))
/** 画面模态走哪一步由方案决定：图文成片=images，动态镜头首帧=frames（与服务端投影同一判定） */
const imageStep = computed<CreationCandidateStep>(
  () => (props.s.state.detail?.session.plan?.mode === 'slideshow' ? 'images' : 'frames'),
)

const expanded = reactive(new Set<string>())
const pending = reactive<Record<string, number | null>>({})
const boards = reactive<Partial<Record<CreationCandidateStep, ShotBoardData | null>>>({})
const boardError = reactive<Partial<Record<CreationCandidateStep, string>>>({})
const boardLoading = ref<CreationCandidateStep | null>(null)
// 重合成说明按需展开（不常驻，避免和「应用选择」的提示抢视线）
const recomposing = ref(false)
let boardEpoch = 0

function resetCandidates(): void {
  expanded.clear()
  for (const k of Object.keys(pending)) delete pending[k]
  for (const step of CANDIDATE_STEPS) {
    delete boards[step]
    delete boardError[step]
  }
  boardLoading.value = null
  boardEpoch++
  recomposing.value = false
}

/** 该镜该模态是否值得给出候选入口（缺文件的占位不可选，不计入可用数） */
function showCandidates(choice: { candidates: CreationArtifact[] }): boolean {
  return settled.value && choice.candidates.filter((c) => c.available).length > 1
}

async function ensureBoard(step: CreationCandidateStep): Promise<void> {
  if (boards[step] || boardLoading.value === step) return
  const id = props.s.state.currentId
  if (!id) return
  const token = ++boardEpoch
  boardLoading.value = step
  boardError[step] = ''
  try {
    const board = await creationChatApi.board(id, step)
    if (token === boardEpoch && id === props.s.state.currentId) boards[step] = board
  } catch (e) {
    if (token === boardEpoch) {
      boardError[step] = e instanceof Error ? e.message : '候选信息读取失败，可收起后重试。'
    }
  } finally {
    if (token === boardEpoch) boardLoading.value = null
  }
}

const keyOf = (step: CreationCandidateStep, shotId: string) => `${step}:${shotId}`
async function toggleCandidates(step: CreationCandidateStep, shotId: string): Promise<void> {
  const key = keyOf(step, shotId)
  if (expanded.has(key)) {
    expanded.delete(key)
    pending[key] = null
    return
  }
  expanded.add(key)
  await ensureBoard(step)
}

function pickCandidate(step: CreationCandidateStep, shotId: string, assetId: number): void {
  pending[keyOf(step, shotId)] = assetId
}

/** 应用选择：只提交这一镜的改动（其余镜头由服务端按在用值补全）；成功后清空本地待应用态 */
async function applyCandidate(step: CreationCandidateStep, shotId: string): Promise<void> {
  const key = keyOf(step, shotId)
  const assetId = pending[key]
  if (assetId == null) return
  if (await props.s.applySelection(step, shotId, assetId)) pending[key] = null
}

async function onRecompose(): Promise<void> {
  const ok = await confirmDialog({
    title: '重新合成成片',
    message: '本地合成：只把现有素材重新拼成成片，不调用任何付费生成模型、不产生生成费用。确认开始？',
    confirmText: '重新合成',
  })
  if (!ok) return
  recomposing.value = false
  await props.s.recompose()
}

const selected = (choice: { selected: CreationArtifact | null }): CreationArtifact | null => choice.selected

async function open(a: CreationArtifact): Promise<void> {
  if (!a.available || loading.value !== null) return
  const token = ++request
  loading.value = a.assetId
  error.value = ''
  try {
    const { asset } = await assetApi.detail(a.assetId)
    if (token === request) preview.value = asset
  } catch {
    if (token === request) error.value = '素材当前不可用，请更新状态后重试。'
  } finally {
    if (token === request) loading.value = null
  }
}
</script>

<template>
  <section v-if="s.state.detail?.progress" class="panel ec-artifacts" aria-label="已有成果">
    <header class="ec-artifacts-head">
      <div>
        <h2>已有成果</h2>
        <p class="muted">只读预览，恢复制作时会继续复用可用成果。</p>
      </div>
      <div v-if="s.state.selectionDirty" class="ec-artifacts-recompose">
        <span class="badge queued">已改选版本 · 待重新合成</span>
        <button class="btn sm primary" type="button" :disabled="s.state.busyAction" @click="onRecompose">
          <Icon name="refresh" :size="13" /> 重新合成
        </button>
        <button class="ec-artifacts-more" type="button" :aria-expanded="recomposing" @click="recomposing = !recomposing">
          {{ recomposing ? '收起说明' : '会再花钱吗？' }}
        </button>
        <p v-if="recomposing" class="muted">不会。重新合成只在本地把现有画面/视频素材拼成新成片，不调用任何付费生成模型。</p>
      </div>
      <!-- [M42] 局部返修：独立于消息输入框的计费入口（默认发信仍是「记录下一版建议」） -->
      <button
        v-if="s.rework.canUse.value && !s.rework.state.open"
        class="btn sm ec-rework-open"
        type="button"
        aria-controls="ec-rework"
        @click="s.rework.toggle()"
      >
        <Icon name="pencil" :size="13" /> 局部返修
      </button>
    </header>
    <CreationRework v-if="s.rework.canUse.value" :s="s" />
    <p v-if="!artifacts?.shots.length && !artifacts?.documents.length" class="muted">暂无可核实的成果。素材生成后会自动显示。</p>
    <p v-if="error" role="alert" class="err-text">{{ error }}</p>
    <ol class="ec-artifacts-shots">
      <li v-for="shot in artifacts?.shots ?? []" :key="shot.shotId" class="ec-artifacts-shot">
        <h3>第 {{ shot.index }} 镜 · {{ shot.duration }} 秒</h3>
        <p>{{ shot.text || '此镜无台词' }}</p>
        <button v-if="selected(shot.image)?.available" class="ec-artifacts-image" type="button" :disabled="loading !== null" :aria-label="`预览第 ${shot.index} 镜画面`" @click="open(selected(shot.image)!)">
          <img v-if="!brokenThumbs.includes(selected(shot.image)!.assetId)" :src="`/api/v1/assets/${selected(shot.image)!.assetId}/thumb?v=2`" :alt="`第 ${shot.index} 镜画面`" loading="lazy" @error="brokenThumbs.push(selected(shot.image)!.assetId)" />
          <span v-else>缩略图暂不可用，点击查看原图</span>
        </button>
        <div v-else class="ec-artifacts-image ec-artifacts-placeholder">{{ selected(shot.image) ? '画面素材不可用' : '画面尚未生成' }}</div>
        <template v-if="showCandidates(shot.image)">
          <CreationCandidates
            :index="shot.index"
            :shot-id="shot.shotId"
            label="画面"
            :candidates="shot.image.candidates"
            :selected-id="selected(shot.image)?.assetId ?? null"
            :pending="pending[keyOf(imageStep, shot.shotId)] ?? null"
            :open="expanded.has(keyOf(imageStep, shot.shotId))"
            :busy="s.state.busyAction"
            :board="boards[imageStep] ?? null"
            @toggle="toggleCandidates(imageStep, shot.shotId)"
            @pick="pickCandidate(imageStep, shot.shotId, $event)"
            @apply="applyCandidate(imageStep, shot.shotId)"
            @cancel="pending[keyOf(imageStep, shot.shotId)] = null"
          />
          <p v-if="boardError[imageStep] && expanded.has(keyOf(imageStep, shot.shotId))" role="alert" class="err-text">{{ boardError[imageStep] }}</p>
        </template>
        <div class="ec-artifacts-actions">
          <span v-if="selected(shot.image)?.reused" class="badge">画面已复用</span>
          <button v-if="selected(shot.video)" class="btn sm" type="button" :disabled="!selected(shot.video)!.available || loading !== null" @click="open(selected(shot.video)!)">{{ selected(shot.video)!.available ? '预览视频' : '视频素材不可用' }}{{ selected(shot.video)!.reused ? ' · 已复用' : '' }}</button>
          <span v-else class="muted">暂无视频</span>
          <button v-for="(voice, i) in shot.voices" :key="voice.assetId" class="btn sm" type="button" :disabled="!voice.available || loading !== null" @click="open(voice)">{{ voice.available ? `试听配音 ${i + 1}` : '配音不可用' }}{{ voice.reused ? ' · 已复用' : '' }}</button>
          <span v-if="!shot.voices.length" class="muted">暂无配音</span>
        </div>
        <CreationCandidates
          v-if="showCandidates(shot.video)"
          :index="shot.index"
          :shot-id="shot.shotId"
          label="视频"
          :candidates="shot.video.candidates"
          :selected-id="selected(shot.video)?.assetId ?? null"
          :pending="pending[keyOf('motion', shot.shotId)] ?? null"
          :open="expanded.has(keyOf('motion', shot.shotId))"
          :busy="s.state.busyAction"
          :board="boards.motion ?? null"
          @toggle="toggleCandidates('motion', shot.shotId)"
          @pick="pickCandidate('motion', shot.shotId, $event)"
          @apply="applyCandidate('motion', shot.shotId)"
          @cancel="pending[keyOf('motion', shot.shotId)] = null"
        />
      </li>
    </ol>
    <div v-if="artifacts?.documents.length" class="ec-artifacts-documents">
      <h3>字幕与批准文本</h3>
      <button v-for="doc in artifacts.documents" :key="`${doc.label}-${doc.assetId}`" class="btn sm" type="button" :disabled="!doc.available || loading !== null" @click="open(doc)">{{ doc.label }}{{ doc.available ? '' : ' · 素材不可用' }}{{ doc.reused ? ' · 已复用' : '' }}</button>
    </div>
    <p v-if="loading !== null" role="status">正在加载预览…</p>
    <AssetPreviewer v-if="preview" :assets="[preview]" :index="0" @close="preview = null" />
  </section>
</template>

<style scoped>
.ec-artifacts { padding: 16px 18px; min-width: 0; }
.ec-artifacts-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.ec-artifacts-head h2 { font-size: 16px; margin: 0 0 8px; }
.ec-artifacts-recompose { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ec-artifacts-more { border: 0; background: none; color: var(--text-3); font: inherit; font-size: 12px; text-decoration: underline; cursor: pointer; min-height: 44px; }
.ec-artifacts-shot > .ec-artifacts-recompose, .ec-artifacts-recompose .muted { width: 100%; }
.ec-artifacts h3 { font-size: 14px; margin: 0; }
.ec-artifacts p { line-height: 1.6; overflow-wrap: anywhere; }
.ec-artifacts-shots { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.ec-artifacts-shot { padding: 12px; border: 1px solid var(--border); border-radius: 10px; min-width: 0; background: var(--panel-2); }
.ec-artifacts-image { width: 100%; aspect-ratio: 16 / 9; display: flex; align-items: center; justify-content: center; padding: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; color: var(--text-2); background: var(--panel); }
button.ec-artifacts-image { cursor: pointer; }
.ec-artifacts-image img { width: 100%; height: 100%; object-fit: contain; }
.ec-artifacts-placeholder { font-size: 13px; }
.ec-artifacts-actions, .ec-artifacts-documents { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; align-items: center; }
.ec-artifacts-documents h3 { width: 100%; }
.ec-artifacts .btn { min-height: 44px; white-space: normal; }
.ec-artifacts button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 600px) { .ec-artifacts-shots { grid-template-columns: 1fr; } }
</style>
