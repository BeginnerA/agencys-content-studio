<script setup lang="ts">
/**
 * 字幕精确返修入口（可复用按钮 + 弹窗）：一处组件收口四入口
 * （轻松创作成果区 / 运行详情合成卡 / 镜头工作台 ComposeBar / 合成节点抽屉）。
 * - 自治探测：挂载拉一次读模型，按后端 capability 决定是否可用；入口不自行判断依赖或费用（规格 §9）。
 * - 不支持链路不伪造可编辑态：按钮 title 与弹窗内展示后端返回的真实原因。
 * - 探测请求失败（网络 / 非该 run）→ 隐藏，不打扰；成功即显示入口，点开由弹窗呈现编辑或原因。
 */
import { onMounted, ref } from 'vue'
import Icon from '../../common/Icon.vue'
import SubtitleReworkModal from './SubtitleReworkModal.vue'
import { subtitleReworkApi } from '../../../lib/api/rework'

const props = defineProps<{ runId: number; stepKey?: string; disabled?: boolean }>()
defineEmits<{ applied: [] }>()

const show = ref(false)
const open = ref(false)
const reason = ref('')

onMounted(async () => {
  try {
    const rm = await subtitleReworkApi.subtitles(props.runId, props.stepKey ?? 'compose')
    reason.value = rm.capability?.message ?? ''
    show.value = true
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
    :title="reason || '核对字幕并精确返修（本地修订，零模型计费）'"
    @click="open = true"
  >
    <Icon name="pencil" :size="12" /> 字幕返修
  </button>

  <SubtitleReworkModal
    v-if="open"
    :run-id="runId"
    :step-key="stepKey"
    @close="open = false"
    @applied="$emit('applied')"
  />
</template>
