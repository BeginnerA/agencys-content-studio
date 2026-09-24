<script setup lang="ts">
/**
 * 对话内参考素材卡片气泡（自 ConversationPanel.vue 原样搬出，行为零变更）：
 * 缩略图 + 文件名 + 查看角标，整卡可点（键盘可达）；点击 emit open 由父级拉详情预览。
 * 注意：`.bubble` 基础样式与 `.msg.user .bubble` 反色仍留在父级 scoped（子组件根元素同承父作用域）。
 */
import Icon from '../../components/common/Icon.vue'
import type { CreationChatMessage, CreationShot } from '../../lib/types'
import { kindIcon, refKind, refName, refRoleLabel, refShotLabel, refThumb } from './ref-utils'

defineProps<{
  m: CreationChatMessage
  /** 该素材详情拉取中（refLoading 命中） */
  loading: boolean
  /** 当前方案镜头（镜号徽标按镜序派生；无方案回退裸 id） */
  shots?: CreationShot[] | null
}>()
const emit = defineEmits<{ open: [] }>()
</script>

<template>
  <div
    class="bubble ref-bubble"
    role="button"
    tabindex="0"
    :aria-label="'查看参考素材：' + refName(m)"
    :aria-busy="loading"
    @click="emit('open')"
    @keydown.enter.prevent="emit('open')"
    @keydown.space.prevent="emit('open')"
  >
    <span class="ref-thumb">
      <img
        v-if="refThumb(m)"
        :src="refThumb(m) ?? ''"
        :alt="refName(m)"
        loading="lazy"
      />
      <Icon v-else :name="kindIcon(refKind(m))" :size="18" />
      <span class="ref-view" aria-hidden="true">
        <Icon name="eye" :size="11" />
      </span>
      <span v-if="loading" class="ref-load" aria-hidden="true">
        <Icon name="refresh" :size="16" />
      </span>
    </span>
    <span class="ref-meta">
      <span class="ref-tag">
        <Icon :name="kindIcon(refKind(m))" :size="10" /> 参考 ·
        {{ refRoleLabel(m) }}
        <span v-if="refShotLabel(m, shots)" class="ref-shot-badge">{{ refShotLabel(m, shots) }}</span>
      </span>
      <span class="ref-file" :title="refName(m)">{{ refName(m) }}</span>
    </span>
  </div>
</template>

<style scoped>
/* 参考素材卡片气泡：缩略图 + 文件名 + 查看角标（整卡可点，键盘可达） */
.ref-bubble {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  max-width: 100%;
  text-align: left;
  cursor: pointer;
  transition:
    filter 0.15s ease,
    box-shadow 0.15s ease;
}

.ref-bubble:hover {
  filter: brightness(1.1);
  box-shadow: 0 8px 20px -12px rgb(79 70 229 / 85%);
}

.ref-bubble:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

.ref-thumb {
  position: relative;
  flex: none;
  width: 46px;
  height: 46px;
  border-radius: 8px;
  overflow: hidden;
  background: rgb(0 0 0 / 22%);
  border: 1px solid rgb(255 255 255 / 28%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}

.ref-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.ref-view {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 17px;
  height: 17px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 55%);
  color: #fff;
  pointer-events: none;
}

.ref-load {
  position: absolute;
  inset: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 45%);
  color: #fff;
}

.ref-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ref-tag {
  font-size: 10.5px;
  opacity: 0.92;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

/* 镜号徽标：不靠颜色单独表意（文本「第 N 镜」即语义） */
.ref-shot-badge {
  flex: none;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid rgb(255 255 255 / 45%);
  background: rgb(0 0 0 / 25%);
}

.ref-file {
  font-size: 12.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 190px;
}
</style>
