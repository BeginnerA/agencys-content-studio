<script setup lang="ts">
/**
 * 引导 / 规划中卡片（M63 切片 5）：服务端 sideCards 下发 key='guide'|'planning' 时渲染。
 * 取代旧 detail.vue 里硬编码的 idle 静态块——显隐由后端裁决，组件只按当前会话态呈现：
 *   planning → 阶段式进度（复用 session.planning 的 phase/elapsedSec，与对话气泡同源）；
 *   其余（draft / 需求含糊）→ 引导文案，诚实告知「确认前不立项、不计费」。
 */
import { computed } from 'vue'
import Icon from '../../components/common/Icon.vue'
import type { useEasyCreate } from './use-creation-chat'

const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()

const session = computed(() => props.s.state.detail?.session ?? null)
const planning = computed(() => session.value?.status === 'planning')
const PHASE_LABELS: Record<string, string> = {
  analyzing: '理解需求中',
  refs: '核验并理解参考素材中（多模态解析，可能较慢）',
  caps: '探测模型能力与预检条件中',
  model: '调度模型规划执行方案中（推理模型整段思考后才返回，请耐心等待）',
  validating: '方案校验与制作预检中',
}
const phaseLabel = computed(() => {
  const p = session.value?.planning
  return p ? PHASE_LABELS[p.phase] ?? '规划中' : '接收请求中'
})
const elapsed = computed(() => session.value?.planning?.elapsedSec ?? 0)
</script>

<template>
  <div class="card panel" :class="{ guide: !planning }" aria-label="智能创作">
    <template v-if="planning">
      <header class="ph">
        <h2><Icon name="sparkles" :size="16" /> 智能规划中</h2>
      </header>
      <div class="wait">
        <span class="dot" /><span class="dot" /><span class="dot" />
        <span>{{ phaseLabel }} · 已进行 {{ elapsed }}s</span>
      </div>
      <p class="muted">Agent 正在判断执行模式（单条成片 / 命中模板 / 多步链 / 临时编排）并规划调度，规划阶段仅调用文本模型。</p>
    </template>
    <template v-else>
      <span class="idle-ic"><Icon name="wand" :size="22" /></span>
      <p class="idle-t">智能创作助手正在听你描述</p>
      <p class="muted">
        左侧描述需求，助手会智能判断该怎么执行并在此生成执行计划。确认执行计划前不立项、不产生任何媒体制作费用。
      </p>
    </template>
  </div>
</template>

<style scoped>
.card {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.card.guide {
  padding: 30px 22px;
  align-items: center;
  text-align: center;
}
.ph h2 {
  font-size: 15px;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 700;
}
.ph h2 .ic {
  color: var(--accent-h);
}
.idle-ic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-h);
}
.idle-t {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.muted {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-2);
  max-width: 320px;
}
.wait {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  color: var(--text-2);
  font-size: 13px;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--run);
  display: inline-block;
  animation: blink 1.1s infinite;
}
.dot:nth-child(2) { animation-delay: 0.18s; }
.dot:nth-child(3) { animation-delay: 0.36s; }
@keyframes blink {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .dot { animation: none; }
}
</style>
