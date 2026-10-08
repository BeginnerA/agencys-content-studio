<script setup lang="ts">
import { ref } from 'vue'
import Icon from '../../components/common/Icon.vue'
import type { CreationRefsAnalysisEntry } from '../../lib/types'

/**
 * 「参考解析」产物区：把服务端规划期从参考视频实际读到的内容（时间轴场景/可听转写）
 * 显式渲染供用户检视——系统读到了什么、方案依据什么反推，全部可见可核对。
 * 只展示真源字段（截断有标记，缺失不编造）；无解析产物时父级完全不渲染。
 */
defineProps<{ entries: CreationRefsAnalysisEntry[] }>()

const open = ref<number[]>([])
const toggle = (i: number): void => {
  open.value = open.value.includes(i) ? open.value.filter((x) => x !== i) : [...open.value, i]
}
</script>

<template>
  <section class="ec-refs-analysis" aria-label="参考视频解析">
    <div class="sh">
      <Icon name="film" :size="13" /> 参考解析<span class="sh-hint"
        >系统从参考视频实际读到的内容 · 方案据此约束，不编造</span
      >
    </div>
    <div v-for="(e, i) in entries" :key="e.assetId" class="ra-item">
      <button class="ra-head" type="button" :aria-expanded="open.includes(i)" @click="toggle(i)">
        <Icon :name="open.includes(i) ? 'chevron-down' : 'chevron-right'" :size="13" />
        <span class="ra-name">{{ e.name }}</span>
        <span class="ra-meta muted">{{ e.duration.toFixed(1) }}s · {{ e.scenes.length }} 段场景{{ e.transcribed ? ' · 含人声转写' : '' }}</span>
      </button>
      <div v-if="open.includes(i)" class="ra-body">
        <ol class="ra-scenes">
          <li v-for="(s, si) in e.scenes" :key="si">
            <span class="mono ra-t">{{ s.t.toFixed(1) }}s</span>
            <span>{{ s.desc }}</span>
          </li>
        </ol>
        <p v-if="e.truncated?.scenes" class="ra-trunc muted">
          <Icon name="alert" :size="11" /> 场景超出展示上限，已截断（完整反推请走专业端）
        </p>
        <div v-if="e.transcript" class="ra-say">
          <div class="ra-say-h">可听内容（转写）</div>
          <p class="ra-say-t">{{ e.transcript }}</p>
          <p v-if="e.truncated?.transcript" class="ra-trunc muted">
            <Icon name="alert" :size="11" /> 转写超长已截断
          </p>
        </div>
        <p v-else class="ra-say-h muted">可听内容：（无转写内容）</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ec-refs-analysis {
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

.ra-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ra-head {
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

.ra-head:hover .ra-name {
  color: var(--accent);
}

.ra-name {
  font-weight: 700;
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ra-meta {
  font-size: 11.5px;
  white-space: nowrap;
}

.ra-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}

.ra-scenes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-2);
}

.ra-scenes li {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.ra-t {
  flex: none;
  font-size: 11px;
  color: var(--text-3);
  min-width: 48px;
}

.ra-say-h {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
}

.ra-say-t {
  margin: 3px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}

.ra-trunc {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  margin: 0;
}
</style>
