<script setup lang="ts">
/**
 * 合成输入本地返修入口（可复用按钮 + 弹窗）：与字幕返修同构的自治探测组件（切片2 §6）。
 * - 挂载拉一次能力探测，按后端 capability.supported 决定是否显示；入口不自行判断依赖/费用/过期（规格 §9）。
 * - 不支持链路不伪造可返修态：按钮 title 展示后端真实原因（无成片 / 在途 / 下游付费等）。
 * - 探测失败（网络 / 非该 run）→ 隐藏，不打扰；此时用户仍走 ComposeSettingsModal 的草稿直写（双模）。
 */
import { onMounted, ref } from 'vue'
import Icon from '../../common/Icon.vue'
import ComposeInputReworkModal from './ComposeInputReworkModal.vue'
import { composeInputReworkApi } from '../../../lib/api/rework'

const props = defineProps<{ runId: number; projectId: number; stepKey?: string; disabled?: boolean }>()
defineEmits<{ applied: [] }>()

const show = ref(false)
const open = ref(false)
const reason = ref('')

onMounted(async () => {
  try {
    const res = await composeInputReworkApi.capability(props.runId, props.stepKey ?? 'compose')
    if (res.capability.supported) {
      reason.value = '核对合成输入并受控返修（本地重合成，零模型费用）'
      show.value = true
    } else {
      reason.value = res.capability.message || ''
      show.value = false
    }
  } catch {
    show.value = false
  }
})
</script>

<template>
  <button
    v-if="show"
    type="button"
    class="btn sm"
    :disabled="disabled"
    :title="reason || '合成输入受控返修（预览→确认→本地重合成）'"
    @click="open = true"
  >
    <Icon name="sliders" :size="12" /> 合成返修
  </button>

  <ComposeInputReworkModal
    v-if="open"
    :run-id="runId"
    :project-id="projectId"
    :step-key="stepKey"
    @close="open = false"
    @applied="$emit('applied')"
  />
</template>
