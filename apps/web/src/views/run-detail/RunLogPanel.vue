<script setup lang="ts">
import type { RunDetailApi } from './use-run-detail'
const props = defineProps<{ u: RunDetailApi }>()
const { showLog, logText, autoScroll, logEl } = props.u
</script>

<template>
          <div v-if="showLog" class="panel logbox">
            <div class="lhead">
              <span class="lt">运行日志</span>
              <label class="autosc"><input v-model="autoScroll" type="checkbox" /> 自动滚动</label>
            </div>
            <pre ref="logEl" class="log mono">{{ logText || '（暂无日志）' }}</pre>
          </div>
</template>

<style scoped>
.logbox {
  padding: 10px 14px;
}

.lhead {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.lt {
  font-weight: 600;
  font-size: 13px;
}

.autosc {
  font-size: 11.5px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 4px;
}

.log {
  margin: 0;
  max-height: 420px;
  overflow-y: auto;
  background: var(--code-bg);
  color: #b9c7dc;
  font-size: 11px;
  line-height: 1.6;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  white-space: pre-wrap;
  word-break: break-all;
}

</style>
