<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import type { EntitiesApi } from './use-entities'
const props = defineProps<{ s: EntitiesApi }>()
const { REFGEN_STATUS_TEXT, refBusyTask, refPid, refTasks, refLive, refPct, resetRefPanel, cancelRefTask, retryRefTask } = props.s
</script>

<template>
    <!-- [M19 P6] 批量生成进度（socket 驱动 + 轮询兜底；行内可取消 / 失败重试） -->
    <div v-if="refTasks.length" class="refgen panel">
      <div class="rg-head">
        <span class="rg-t"><Icon name="imageplus" :size="13" /> 参考图生成进度（项目#{{ refPid }}）</span>
        <span class="muted">{{ refTasks.length - refLive.length }}/{{ refTasks.length }} · {{ refPct }}%</span>
        <button class="btn tiny" type="button" @click="resetRefPanel">收起</button>
      </div>
      <div class="bar"><span class="fill" :style="{ width: refPct + '%' }" /></div>
      <div class="rg-rows">
        <div v-for="t in refTasks" :key="t.id" class="rg-row">
          <span class="badge" :class="t.status">{{ REFGEN_STATUS_TEXT[t.status] }}</span>
          <span class="rg-nm">{{ t.entityName }}</span>
          <span class="muted rg-v">变体 {{ t.variantIndex + 1 }}</span>
          <span class="muted rg-msg">
            <template v-if="t.errorMsg">{{ t.errorMsg }}</template>
            <template v-else-if="t.status === 'succeeded' && t.resultAssetId">已挂接 asset#{{ t.resultAssetId }}</template>
          </span>
          <span class="rg-ops">
            <button
              v-if="t.status === 'pending' || t.status === 'processing'"
              class="btn tiny"
              :disabled="refBusyTask !== 0"
              @click="cancelRefTask(t)"
            >
              <Icon name="stop" :size="11" /> 取消
            </button>
            <button v-else-if="t.status === 'failed'" class="btn tiny" :disabled="refBusyTask !== 0" @click="retryRefTask(t)">
              <Icon name="refresh" :size="11" /> 重试
            </button>
          </span>
        </div>
      </div>
      <div v-if="refLive.length" class="muted rg-tip">并发上限 2，其余排队中；完成后本页自动刷新卡片参考图张数。</div>
    </div>
</template>

<style scoped>
/* ===== [M19 P6] 批量生成参考图：页内进度面板 + 弹窗 ===== */
.refgen {
  margin-bottom: 14px;
  padding: 11px 13px 12px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.rg-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
}

.rg-t {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-right: auto;
  font-weight: 600;
}

.bar {
  height: 5px;
  border-radius: 999px;
  background: rgb(148 163 184 / 14%);
  overflow: hidden;
}

.bar .fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--indigo-deep), var(--run));
  transition: width 0.3s ease;
}

.rg-rows {
  display: flex;
  flex-direction: column;
  max-height: 246px;
  overflow-y: auto;
}

.rg-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  border-top: 1px solid rgb(148 163 184 / 8%);
}

.rg-row:first-child {
  border-top: none;
}

.rg-row .badge {
  flex: none;
  font-size: 11px;
}

.rg-nm {
  flex: none;
  max-width: 150px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rg-v {
  flex: none;
  font-size: 11px;
}

.rg-msg {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rg-ops {
  flex: none;
  display: flex;
  gap: 6px;
}

.rg-tip {
  font-size: 11.5px;
}
.btn.tiny {
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 7px;
}
</style>
