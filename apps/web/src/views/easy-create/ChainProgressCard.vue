<script setup lang="ts">
/**
 * 执行链进度卡：服务端 sideCards 下发 key='chainProgress' 时渲染（chain 制作中）。
 * 段序列取自服务端落的 chain-start 消息 payload.segments（模板 key 列表）——不新造 workflow 详情接口，
 * 逐段状态由下方「制作进度卡」按当前 run 呈现；段间批准在左侧对话流完成（安全默认：不自动级联计费）。
 */
import { computed } from 'vue'
import Icon from '../../components/common/Icon.vue'
import type { useEasyCreate } from './use-creation-chat'

const props = defineProps<{
  s: ReturnType<typeof useEasyCreate>
  workflowId?: number
}>()

const detail = computed(() => props.s.state.detail)
const wfId = computed(
  () => props.workflowId ?? detail.value?.session.workflowId ?? null,
)
// 从最新一条 chain-start 消息取段序列（服务端真源，前端不臆造模板名）
const segments = computed<string[]>(() => {
  const msgs = detail.value?.messages ?? []
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const p = msgs[i]?.payload
    if (p?.kind === 'chain-start' && Array.isArray(p.segments))
      return p.segments as string[]
  }
  return []
})
</script>

<template>
  <div v-if="segments.length" class="card panel" aria-label="执行链进度">
    <header class="ph">
      <h2>
        <Icon name="layers" :size="16" /> 执行链（{{ segments.length }} 段）
      </h2>
      <RouterLink v-if="wfId" class="wl" :to="`/workflows/${wfId}`">
        <Icon name="external" :size="12" /> 链详情
      </RouterLink>
    </header>
    <ol class="segs">
      <li v-for="(seg, i) in segments" :key="i">
        <span class="idx">{{ i + 1 }}</span>
        <code class="tk">{{ seg }}</code>
      </li>
    </ol>
    <p class="hint">
      段间将在每段落定后暂停，回到左侧对话请求你的批准再继续（不自动级联计费）。当前段制作进度见下方进度卡。
    </p>
  </div>
</template>

<style scoped>
.card {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ph {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
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
.wl {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
  text-decoration: none;
  padding: 4px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel-2);
}
.wl:hover {
  border-color: var(--accent);
  color: #fff;
}
.segs {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.segs li {
  display: flex;
  align-items: center;
  gap: 9px;
}
.segs .idx {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--accent-weak);
  color: var(--accent-h);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
}
.segs .tk {
  font-size: 12px;
  color: var(--text-2);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px 8px;
  overflow-wrap: anywhere;
}
.hint {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.6;
  margin: 0;
}
</style>
