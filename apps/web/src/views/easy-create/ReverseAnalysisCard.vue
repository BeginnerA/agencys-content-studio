<script setup lang="ts">
/**
 * 图片反推成果卡：服务端 sideCards 下发 key='reverseAnalysis' 时渲染。
 * 场景：用户只要从参考图反推提示词（如「反推图片提示词」）而非生成成片时，会话回到 draft、无方案、无 run，
 * 反推交付物此前只随追问消息透出在左侧对话流；现由后端裁决抬到右侧成果区，与成片方案卡 / 成片结果
 * 同属「当前会话权威成果」语义。数据仍取消息 payload.imageAnalysis（后端已下发，不重复传输）。
 * 组件只呈现，显隐裁决权在后端 computeSideCards。
 */
import { computed } from 'vue'
import Icon from '../../components/common/Icon.vue'
import PlanImageAnalysis from './PlanImageAnalysis.vue'
import type { CreationImageAnalysisEntry } from '../../lib/types'
import type { useEasyCreate } from './use-creation-chat'

const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()

// 取最新一条携带反推产物的 assistant 消息（draft 态下即本轮 fallback 落库的交付物）
const entries = computed<CreationImageAnalysisEntry[]>(() => {
  const msgs = props.s.state.detail?.messages ?? []
  const m = [...msgs].reverse().find((x) => x.role === 'assistant' && !!x.payload?.imageAnalysis?.length)
  return m?.payload?.imageAnalysis ?? []
})
</script>

<template>
  <div v-if="entries.length" class="card panel" aria-label="图片反推结果">
    <header class="hd">
      <h2><Icon name="sparkles" :size="16" /> 图片反推结果</h2>
      <p class="muted">从你上传的参考图实际反推出的可投产提示词，可直接复制使用；本轮未生成视频方案。</p>
    </header>
    <PlanImageAnalysis :entries="entries" />
  </div>
</template>

<style scoped>
.card {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.hd {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.hd h2 {
  font-size: 15px;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 700;
}
.hd h2 .ic {
  color: var(--accent-h);
}
.muted {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-2);
}
</style>
