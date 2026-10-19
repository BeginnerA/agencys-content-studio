<script setup lang="ts">
/**
 * 「待你补充」卡：服务端 sideCards 下发 key='clarify' 时渲染（draft·无方案·无 run 且最新一轮为 clarify）。
 * 取代固定 guide 空闲卡，让右侧面板随对话上下文呈现「助手在等你确认什么」：
 *   展示助手最近一条追问说明（content）+ 待选项列表（payload.questions，与对话区可点 chips 同源，此处只读汇总）。
 * 纯展示、不重复发送逻辑（可点选项仍在左侧对话输入区），零副作用。
 */
import { computed } from 'vue'
import Icon from '../../components/common/Icon.vue'
import type { useEasyCreate } from './use-creation-chat'

const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()

interface ClarifyPayload { kind?: string; questions?: unknown }
const lastClarify = computed(() => {
  const msgs = props.s.state.detail?.messages ?? []
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i]!
    if (m.role !== 'assistant') continue
    const p = (m.payload ?? null) as ClarifyPayload | null
    if (p?.kind === 'clarify' && Array.isArray(p.questions) && p.questions.length) {
      return { content: m.content, questions: p.questions.filter((q): q is string => typeof q === 'string') }
    }
    return null
  }
  return null
})
const questions = computed(() => lastClarify.value?.questions ?? [])
</script>

<template>
  <div class="card panel clarify" aria-label="待你补充">
    <header class="ph">
      <h2><Icon name="chat" :size="16" /> 等你补充一下</h2>
    </header>
    <p v-if="lastClarify?.content" class="lead">{{ lastClarify.content }}</p>
    <ul v-if="questions.length" class="qs">
      <li v-for="(q, i) in questions" :key="i">{{ q }}</li>
    </ul>
    <p class="muted">点下方对话区的选项，或直接补充一句，助手会继续规划。此阶段不立项、不产生任何媒体制作费用。</p>
  </div>
</template>

<style scoped>
.card {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
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
.lead {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text);
}
.qs {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.qs li {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-2);
}
.muted {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
}
</style>
