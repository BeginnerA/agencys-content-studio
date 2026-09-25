<script setup lang="ts">
import { computed } from 'vue'
import Icon from '../../components/common/Icon.vue'
import type { CreationArtifact, ShotBoardData } from '../../lib/types'

/**
 * 单镜候选版本选择（成果面板展开块，父级受控：只在展开时挂载）。
 * 可用性只认投影 candidates（文件在不在 / 是否删除），时间来源等富信息用工作台同一份 board 按 assetId 叠加（展开时才拉，只读）。
 * 改选别的版本只落本地 pending，点「应用选择」才提交：选片零计费、不触发执行，重新合成后才落到成片。
 */
const props = defineProps<{
  /** 第几镜（读法与成果面板一致） */
  index: number
  shotId: string
  /** 模态读法：画面 / 视频 */
  label: string
  candidates: CreationArtifact[]
  selectedId: number | null
  pending: number | null
  busy: boolean
  board: ShotBoardData | null
}>()
const emit = defineEmits<{
  (e: 'pick', assetId: number): void
  (e: 'apply'): void
  (e: 'cancel'): void
}>()

const groupLabel = computed(() => `第 ${props.index} 镜候选${props.label}`)
const usableCount = computed(
  () => props.candidates.filter((c) => c.available).length,
)
/** 单选态：已改选未应用时以 pending 为准（这才是要提交的目标） */
const activeId = computed(() => props.pending ?? props.selectedId)
const dirty = computed(
  () => props.pending != null && props.pending !== props.selectedId,
)

/** board 里该镜该资产的版本元信息（未取到 board 或该版本不在册 → null，只降级为不带时间来源） */
const versionOf = (assetId: number) =>
  props.board?.shots
    .find((s) => s.shotId === props.shotId)
    ?.versions.find((v) => v.id === assetId) ?? null
const thumbOf = (c: CreationArtifact) =>
  versionOf(c.assetId)?.urls.thumb ?? `/api/v1/assets/${c.assetId}/thumb?v=2`
const metaOf = (c: CreationArtifact): string => {
  const v = versionOf(c.assetId)
  if (!v) return c.reused ? '复用历史成果' : ''
  const day = new Date(v.createdAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${day} · ${v.source === 'upload' ? '本地上传' : '生成'}`
}
function badgeOf(c: CreationArtifact, i: number): string {
  if (c.assetId === props.selectedId) return '在用'
  if (c.assetId === props.pending) return '待应用'
  return `版本 ${i + 1}`
}
</script>

<template>
  <div class="ec-cand">
    <p class="ec-cand-title">
      第 {{ index }} 镜 · {{ label }}候选 {{ usableCount }} 版
    </p>
    <p v-if="!board" role="status" class="muted ec-cand-loading">
      正在读取版本信息…
    </p>
    <ul class="ec-cand-list" role="radiogroup" :aria-label="groupLabel">
      <li v-for="(c, i) in candidates" :key="c.assetId">
        <button
          class="ec-cand-item"
          type="button"
          role="radio"
          :aria-checked="activeId === c.assetId"
          :disabled="!c.available || busy"
          :aria-label="`第 ${index} 镜${label}版本 ${i + 1}（${badgeOf(c, i)}）`"
          @click="emit('pick', c.assetId)"
        >
          <img
            v-if="c.available"
            :src="thumbOf(c)"
            :alt="`${groupLabel} ${i + 1}`"
            loading="lazy"
          />
          <span v-else class="ec-cand-missing">文件已删除<br />不可选</span>
          <span
            class="ec-cand-badge"
            :class="{ used: c.assetId === selectedId }"
            >{{ badgeOf(c, i) }}</span
          >
          <span class="ec-cand-meta">{{ metaOf(c) }}</span>
        </button>
      </li>
    </ul>

    <div v-if="dirty" class="ec-cand-apply">
      <span class="ec-cand-hint">
        <Icon name="alert" :size="13" />
        应用后仅改用这一版，重新合成时才会落到成片。
      </span>
      <span class="ec-cand-rows">
        <button
          class="btn sm"
          type="button"
          :disabled="busy"
          @click="emit('apply')"
        >
          应用选择
        </button>
        <button
          class="btn sm"
          type="button"
          :disabled="busy"
          @click="emit('cancel')"
        >
          取消
        </button>
      </span>
    </div>
    <p v-else-if="pending == null" class="muted ec-cand-hint">
      选其他版本再点「应用选择」即可改用；这一步不产生费用。
    </p>
  </div>
</template>

<style scoped>
.ec-cand {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
  min-width: 0;
}

.ec-cand-title {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.ec-cand-loading {
  font-size: 12px;
}

.ec-cand-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 8px;
}

.ec-cand-item {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  min-height: 44px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--panel-2);
  color: var(--text-2);
  font: inherit;
  cursor: pointer;
}

.ec-cand-item[aria-checked='true'] {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-weak);
}

.ec-cand-item:disabled {
  cursor: default;
  opacity: 0.6;
}

.ec-cand-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.ec-cand-missing {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  flex-direction: column;
  font-size: 11.5px;
  line-height: 1.5;
  text-align: center;
}

.ec-cand-badge {
  position: absolute;
  left: 4px;
  top: 4px;
  padding: 1px 5px;
  border-radius: 5px;
  font-size: 11px;
  background: rgb(9 9 11 / 72%);
  color: #fff;
}

.ec-cand-badge.used {
  background: var(--accent);
  color: #fff;
}

.ec-cand-meta {
  position: absolute;
  left: 4px;
  bottom: 4px;
  right: 4px;
  font-size: 10.5px;
  line-height: 1.4;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: #fff;
  text-shadow: 0 1px 2px rgb(0 0 0 / 80%);
}

.ec-cand-apply {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ec-cand-hint {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
}

.ec-cand-rows {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* 应用/取消按钮尺寸由全局 .btn 管（桌面紧凑 / 触屏兜底） */

.ec-cand :is(button):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (max-width: 600px) {
  .ec-cand-list {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
