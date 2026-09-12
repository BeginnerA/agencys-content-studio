<script setup lang="ts">
/**
 * 命令式确认弹窗宿主：桥接 lib/confirm 单例状态与 ConfirmDialog。
 * 全局唯一，挂载于 App.vue；业务方通过 confirmDialog() 调用即可。
 */
import ConfirmDialog from './ConfirmDialog.vue'
import { confirmState, settleConfirm } from '../lib/confirm'
</script>

<template>
  <ConfirmDialog
    v-if="confirmState.active"
    v-bind="confirmState.active.opts"
    @confirm="settleConfirm(true)"
    @cancel="settleConfirm(false)"
  />
</template>
