<script setup lang="ts">
import Icon from '../common/Icon.vue'
import Modal from '../common/Modal.vue'
import { fmtSize, fmtTime, purposeText } from '../../lib/format'
import type { Asset } from '../../lib/types'

defineProps<{
  loading: boolean
  items: Asset[]
  /** 正在操作的条目 id（还原/彻底删除期间禁用全部条目按钮） */
  acting: number | null
  /** 清空回收站进行中 */
  emptyBusy: boolean
}>()
const emit = defineEmits<{
  close: []
  restore: [a: Asset]
  purge: [a: Asset]
  empty: []
}>()
</script>

<template>
  <!-- 资产回收站（软删资产：还原 / 彻底删除） -->
  <Modal title="回收站" :width="640" @close="emit('close')">
    <div class="muted mini">
      已删除的资产（文件尚在原位时可直接还原）。「清空回收站」会移除全部条目与文件（被字幕修订引用的条目跳过保留）；逐条彻底删除仅处理单条，均不可撤销。
    </div>
    <div v-if="loading" class="muted">加载中…</div>
    <div v-else-if="!items.length" class="muted">回收站是空的。</div>
    <div v-else class="trash-list">
      <div v-for="a in items" :key="a.id" class="trash-item">
        <div class="ti-main">
          <div class="ti-name" :title="a.name">{{ a.name }}</div>
          <div class="muted mini">
            {{ purposeText(a.purpose) }} · {{ fmtSize(a.fileSize) }} · 删除于
            {{ fmtTime(a.deletedAt) }}
          </div>
        </div>
        <span class="sp" />
        <button
          type="button"
          class="btn sm"
          :disabled="acting != null"
          title="还原到资产列表（需磁盘文件仍在）"
          @click="emit('restore', a)"
        >
          <Icon name="undo" :size="11" /> 还原
        </button>
        <button
          type="button"
          class="btn sm danger"
          :disabled="acting != null"
          title="物理删除文件并移除记录（不可恢复）"
          @click="emit('purge', a)"
        >
          <Icon name="trash" :size="11" /> 彻底删除
        </button>
      </div>
    </div>
    <template #footer>
      <div class="ft">
        <button
          type="button"
          class="btn sm danger"
          :disabled="emptyBusy || loading || !items.length"
          title="彻底删除回收站内所有资产：物理删除文件并移除记录（不可逆；被字幕修订/历史成片引用的条目跳过保留）"
          @click="emit('empty')"
        >
          清空回收站
        </button>
        <span class="sp" />
        <button type="button" class="btn" @click="emit('close')">关闭</button>
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.sp {
  flex: 1;
}

.mini {
  font-size: 11px;
}

.ft {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.trash-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 50vh;
  overflow-y: auto;
  margin-top: 10px;
}

.trash-item {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--code-bg);
  padding: 8px 10px;
}

.ti-main {
  min-width: 0;
}

.ti-name {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
