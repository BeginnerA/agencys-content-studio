<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { confirmDialog } from '../../lib/confirm'
import Icon from '../../components/common/Icon.vue'
import AssetPreviewer from '../../components/asset/previewer/index.vue'
import { assetApi } from '../../lib/api'
import type { Asset, CreationArtifact } from '../../lib/types'
import type { useEasyCreate } from './use-creation-chat'

/**
 * [M42] 中途审阅面板：run 挂在闸门上时（progress.review）置顶展示待审产物与两个决策出口。
 * 只读投影 + 一次决策请求：不预测费用数字（单价随供应商配置变化），改由文案明示「会继续调用生成、可能计费」。
 * 驳回语义按引擎既有行为如实说明：该阶段整体重做，且重跑轮不再二次暂停。
 */
const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()

const review = computed(() => props.s.state.detail?.progress?.review ?? null)
const busy = computed(() => props.s.state.busyAction)
const note = ref('')
const rejecting = ref(false)
const MAX_NOTE = 500

// 切会话/换闸门步即收起驳回态，避免把上一阶段的意见误提交到新的等待步
watch(
  () => `${props.s.state.currentId}:${review.value?.stepKey ?? ''}`,
  () => {
    note.value = ''
    rejecting.value = false
  },
)

// 待审产物：图文画面（slideshow）与动态首帧（i2v）都是逐镜 image，复用成果投影的在用版本
// [M42] 投影已候选化（{selected, candidates}）：审阅只看正在用的那一版，逐镜换版走成果面板的候选选择
const frames = computed<Array<{ index: number; artifact: CreationArtifact }>>(() =>
  (props.s.state.detail?.artifacts.shots ?? [])
    .map((shot) => ({ index: shot.index, artifact: shot.image.selected }))
    .filter((row): row is { index: number; artifact: CreationArtifact } => !!row.artifact),
)
const usableCount = computed(() => frames.value.filter((f) => f.artifact.available).length)

const preview = ref<Asset | null>(null)
const loading = ref<number | null>(null)
let request = 0
async function open(a: CreationArtifact): Promise<void> {
  if (!a.available || loading.value !== null) return
  const token = ++request
  loading.value = a.assetId
  try {
    const { asset } = await assetApi.detail(a.assetId)
    if (token === request) preview.value = asset
  } catch {
    if (token === request) props.s.state.error = '素材当前不可用，请更新状态后再审阅。'
  } finally {
    if (token === request) loading.value = null
  }
}

async function onApprove(): Promise<void> {
  if (!review.value) return
  await props.s.decideGate(review.value.stepKey, 'approve', note.value)
}

/** 驳回＝该阶段整体重做（可能再次计费）+ 重跑轮不再二次暂停：两条后果都必须先让用户看到 */
async function onReject(): Promise<void> {
  const r = review.value
  if (!r) return
  const ok = await confirmDialog({
    title: '驳回并重做该阶段',
    message: `「${r.title}」的全部产物都会重新生成，会再次调用图片生成，可能产生费用。重做完成后制作会自动继续，不会再暂停等你确认。确认驳回？`,
    confirmText: '确认驳回并重做',
  })
  if (!ok) return
  await props.s.decideGate(r.stepKey, 'reject', note.value)
  rejecting.value = false
}
</script>

<template>
  <section v-if="review" class="panel ec-review" aria-label="等待审阅">
    <header class="rh">
      <h2><Icon name="eye" :size="16" /> 等待审阅</h2>
      <span class="badge waiting_input">{{ review.title }} · 待确认</span>
    </header>
    <p class="rm" role="status">{{ review.message }}</p>

    <p v-if="frames.length" class="muted">
      本阶段已生成 {{ usableCount }}/{{ frames.length }} 镜画面，点开可放大查看。
    </p>
    <ul v-if="frames.length" class="thumbs">
      <li v-for="f in frames" :key="f.artifact.assetId">
        <button
          class="thumb"
          type="button"
          :disabled="!f.artifact.available || loading !== null"
          :aria-label="`放大查看第 ${f.index} 镜画面`"
          @click="open(f.artifact)"
        >
          <img
            v-if="f.artifact.available"
            :src="`/api/v1/assets/${f.artifact.assetId}/thumb?v=2`"
            :alt="`第 ${f.index} 镜画面`"
            loading="lazy"
          />
          <span v-else class="off">素材不可用</span>
          <span class="idx">第 {{ f.index }} 镜</span>
        </button>
      </li>
    </ul>

    <div class="ec-review-note">
      <label class="nl" for="ec-review-note-input">审阅意见（可选，驳回时会带入该阶段重做）</label>
      <textarea
        id="ec-review-note-input"
        v-model="note"
        rows="2"
        :maxlength="MAX_NOTE"
        :disabled="busy"
        placeholder="例如：第 2 镜光线太暗，希望整体更明亮"
      />
      <small class="muted">{{ note.length }}/{{ MAX_NOTE }}</small>
    </div>

    <div class="rf">
      <button class="btn ok big" type="button" :disabled="busy" @click="onApprove">
        <Icon name="bolt" :size="15" /> {{ busy ? '处理中…' : '继续制作' }}
      </button>
      <button
        v-if="!rejecting"
        class="btn danger sm"
        type="button"
        :disabled="busy"
        @click="rejecting = true"
      >
        <Icon name="refresh" :size="13" /> 驳回重做该阶段
      </button>
      <template v-else>
        <span class="warnline">
          <Icon name="alert" :size="13" />
          将重新生成该阶段全部画面并自动继续制作，可能再次计费。
        </span>
        <div class="rrow">
          <button class="btn danger sm" type="button" :disabled="busy" @click="onReject">
            确认驳回并重做
          </button>
          <button class="btn sm" type="button" :disabled="busy" @click="rejecting = false">
            取消
          </button>
        </div>
      </template>
      <button class="btn sm" type="button" :disabled="busy" @click="s.refreshStatus()">
        <Icon name="refresh" :size="13" /> 更新状态
      </button>
    </div>
    <p v-if="rejecting" class="muted">
      只想改个别镜头？驳回会整阶段重做。逐镜调整可在成片完成后用「局部返修」。
    </p>

    <p v-if="loading !== null" role="status">正在加载预览…</p>
    <AssetPreviewer v-if="preview" :assets="[preview]" :index="0" @close="preview = null" />
  </section>
</template>

<style scoped>
.ec-review {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 11px;
  border-color: rgb(245 158 11 / 34%);
  background:
    linear-gradient(180deg, rgb(245 158 11 / 7%), transparent 55%), var(--panel);
}

.rh {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.rh h2 {
  font-size: 15px;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 700;
}

.rh h2 .ic {
  color: var(--warn);
}

.rm {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text);
  font-weight: 600;
}

.ec-review p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
}

.thumbs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
  gap: 8px;
}

.thumb {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--panel-2);
  color: var(--text-2);
  cursor: pointer;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb:disabled {
  cursor: default;
  opacity: 0.55;
}

.thumb .idx {
  position: absolute;
  left: 5px;
  bottom: 5px;
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 5px;
  background: rgb(9 9 11 / 72%);
  color: #fff;
}

.thumb .off {
  font-size: 12px;
}

.ec-review-note {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nl {
  font-size: 12px;
  color: var(--text-2);
}

.ec-review-note textarea {
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  resize: vertical;
  min-height: 44px;
}

.ec-review-note small {
  font-size: 11px;
  align-self: flex-end;
}

.rf {
  display: flex;
  flex-direction: column;
  gap: 9px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}

.rf .big {
  align-self: stretch;
  justify-content: center;
}

.rrow {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.rrow .btn {
  min-height: 44px;
}

.warnline {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  font-size: 12.5px;
  color: var(--warn);
  line-height: 1.55;
}

.warnline .ic {
  flex: none;
  margin-top: 2px;
}

.ec-review :is(button, textarea, a):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (max-width: 600px) {
  .thumbs {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
