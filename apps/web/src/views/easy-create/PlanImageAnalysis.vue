<script setup lang="ts">
import { ref } from 'vue'
import Icon from '../../components/common/Icon.vue'
import type { CreationImageAnalysisEntry } from '../../lib/types'

/**
 * 「图片反推」产物区：把服务端规划期从参考图实际反推出的可投产提示词
 * （正向 image_prompt / 负向 / 风格 / 主体 / 主色板）显式渲染供用户检视复制——
 * 系统从图里读到了什么、方案据此约束，全部可见可核对。
 * 只展示真源字段（缺失不编造）；无反推产物时父级完全不渲染。
 */
defineProps<{ entries: CreationImageAnalysisEntry[] }>()

const open = ref<number[]>([])
const toggle = (i: number): void => {
  open.value = open.value.includes(i) ? open.value.filter((x) => x !== i) : [...open.value, i]
}

const copied = ref<number | null>(null)
async function copy(e: CreationImageAnalysisEntry, i: number): Promise<void> {
  try {
    await navigator.clipboard.writeText(e.imagePrompt)
    copied.value = i
    setTimeout(() => { if (copied.value === i) copied.value = null }, 1600)
  } catch {
    /* 剪贴板不可用：静默（不阻断浏览） */
  }
}
</script>

<template>
  <section class="ec-img-analysis" aria-label="参考图片反推">
    <div class="sh">
      <Icon name="sparkles" :size="13" /> 图片反推<span class="sh-hint"
        >系统从参考图实际反推的可投产提示词 · 方案据此约束，不编造</span
      >
    </div>
    <div v-for="(e, i) in entries" :key="e.assetId" class="ia-item">
      <button class="ia-head" type="button" :aria-expanded="open.includes(i)" @click="toggle(i)">
        <Icon :name="open.includes(i) ? 'chevron-down' : 'chevron-right'" :size="13" />
        <span class="ia-name">{{ e.name }}</span>
        <span v-if="e.style || e.subject" class="ia-meta muted">{{ [e.style, e.subject].filter(Boolean).join(' · ') }}</span>
      </button>
      <div v-if="open.includes(i)" class="ia-body">
        <div class="ia-field">
          <div class="ia-label">
            正向提示词
            <button class="ia-copy" type="button" @click="copy(e, i)">
              <Icon :name="copied === i ? 'check' : 'copy'" :size="11" /> {{ copied === i ? '已复制' : '复制' }}
            </button>
          </div>
          <p class="ia-prompt mono">{{ e.imagePrompt }}</p>
        </div>
        <div v-if="e.negativePrompt" class="ia-field">
          <div class="ia-label">负向提示词</div>
          <p class="ia-prompt ia-neg mono">{{ e.negativePrompt }}</p>
        </div>
        <div v-if="e.palette?.length" class="ia-field">
          <div class="ia-label">主色板</div>
          <div class="ia-swatches">
            <span v-for="(c, ci) in e.palette" :key="ci" class="ia-swatch" :title="c">
              <i :style="{ background: c }" /> {{ c }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ec-img-analysis {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
}

.sh {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.sh .ic {
  color: var(--accent);
}

.sh-hint {
  font-weight: 400;
  font-size: 11.5px;
  color: var(--text-3);
  margin-left: 2px;
}

.ia-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ia-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  text-align: left;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: var(--text);
}

.ia-head:hover .ia-name {
  color: var(--accent);
}

.ia-name {
  font-weight: 700;
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ia-meta {
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ia-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}

.ia-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ia-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
}

.ia-copy {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  font-weight: 400;
  color: var(--accent);
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
}

.ia-prompt {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}

.ia-neg {
  color: var(--text-3);
}

.ia-swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ia-swatch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-3);
}

.ia-swatch i {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  border: 1px solid var(--border);
  display: inline-block;
}
</style>
