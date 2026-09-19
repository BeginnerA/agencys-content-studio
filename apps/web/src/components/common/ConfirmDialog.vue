<script setup lang="ts">
/**
 * 通用确认弹窗（展示组件）：基于 Modal，danger 危险语义 + 自定义按钮文案。
 * 命令式调用见 lib/confirm.ts（confirmDialog）；模板直用：
 *   <ConfirmDialog v-if="show" title="…" message="…" danger @confirm="…" @cancel="…" />
 * 取消路径统一为 cancel：取消按钮 / 遮罩点击 / Esc / 右上关闭。
 */
import Modal from './Modal.vue'
import Icon from './Icon.vue'

defineProps<{
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}>()

const emit = defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <Modal :title="title" :width="430" :z-index="200" @close="emit('cancel')">
    <div class="cfm" :class="{ danger }">
      <span v-if="danger" class="ai"><Icon name="alert" :size="17" /></span>
      <p class="msg">{{ message }}</p>
    </div>
    <template #footer>
      <button class="btn" @click="emit('cancel')">
        {{ cancelText ?? '取消' }}
      </button>
      <button
        class="btn"
        :class="danger ? 'danger' : 'primary'"
        @click="emit('confirm')"
      >
        {{ confirmText ?? '确认' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.cfm {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  background: var(--panel-2);
  border-radius: 8px;
  padding: 10px 13px;
}

.cfm.danger {
  background: var(--bad-weak);
}

.ai {
  color: var(--bad);
  display: inline-flex;
  flex: none;
  margin-top: 1.5px;
}

.msg {
  margin: 0;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.cfm.danger .msg {
  color: #fca5a5;
}
</style>
