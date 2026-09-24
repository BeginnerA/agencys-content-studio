<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import { exportApi } from '../../lib/api'
import { fmtSize } from '../../lib/format'
import type { ExtrasApi } from './use-run-extras'
const props = defineProps<{ e: ExtrasApi }>()
const { showExport, exportsList, runAssets, removeExport } = props.e
</script>

<template>
  <!-- 导出包（purpose=export 资产） -->
  <div class="panel mini">
    <div class="lhead">
      <span class="lt">导出包</span>
      <button
        class="btn sm"
        :disabled="!runAssets.length"
        @click="showExport = true"
      >
        <Icon name="download" :size="12" /> 新建
      </button>
    </div>
    <div v-if="exportsList.length" class="mrows">
      <div v-for="ex in exportsList" :key="ex.id" class="mrow">
        <span class="enm" :title="ex.name">{{ ex.name }}</span>
        <span class="muted">{{ fmtSize(ex.fileSize) }}</span>
        <span class="grow" />
        <a class="btn sm" :href="exportApi.fileUrl(ex.id, true)"
          ><Icon name="download" :size="12" /> 下载</a
        >
        <button class="btn sm danger" @click="removeExport(ex)">删除</button>
      </div>
    </div>
    <div v-else class="empty" style="padding: 10px 0">
      还没有导出包——选择产物一键打包下载
    </div>
  </div>
</template>

<style scoped>
/* 右栏辅助面板（成本 / 导出包 / 发布记录） */
.mini {
  padding: 10px 14px;
}

.mrows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
  max-height: 220px;
  overflow-y: auto;
}

.mrow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.grow {
  flex: 1;
}

.enm {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
</style>
