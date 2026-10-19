<script setup lang="ts">
/**
 * 段间批准卡（M64 G1）：服务端 sideCards 下发 key='chainAwaiting' 时渲染（chain 段间待续跑批准）。
 * 「本段已完成·待你批准继续下一段」的段序/总数取自服务端落的 chain-await 消息 payload（后端为真源，前端不臆造）。
 * 「继续下一段」经 s.advanceChain → POST /advance-chain → 编排器单段推进（预算/输入/幂等与自动级联同源，不新造编排逻辑）。
 */
import { computed } from 'vue'
import Icon from '../../components/common/Icon.vue'
import type { useEasyCreate } from './use-creation-chat'

const props = defineProps<{ s: ReturnType<typeof useEasyCreate>; workflowId?: number }>()

const detail = computed(() => props.s.state.detail)
const wfId = computed(() => props.workflowId ?? detail.value?.session.workflowId ?? null)
// 最新一条 chain-await 消息（服务端续跑钩子回写）→ 已完成段序 / 下一段序 / 总段数
const awaiting = computed(() => {
  const msgs = detail.value?.messages ?? []
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const p = msgs[i]?.payload as { kind?: unknown; seq?: unknown; nextSeq?: unknown; totalSegments?: unknown } | null
    if (p?.kind === 'chain-await') {
      return { doneSeq: Number(p.seq), nextSeq: Number(p.nextSeq), total: Number(p.totalSegments) }
    }
  }
  return null
})
const busy = computed(() => props.s.advanceBusy.busy)
</script>

<template>
  <div v-if="awaiting" class="card panel" aria-label="段间批准">
    <header class="ph">
      <h2><Icon name="play" :size="16" /> 第 {{ awaiting.doneSeq + 1 }} 段已完成</h2>
      <RouterLink v-if="wfId" class="wl" :to="`/workflows/${wfId}`">
        <Icon name="external" :size="12" /> 链详情
      </RouterLink>
    </header>
    <p class="hint">共 {{ awaiting.total }} 段。本段成果见左侧对话与下方进度卡。核对无误后批准，再启动第 {{ awaiting.nextSeq + 1 }} 段（段间不自动级联计费）。</p>
    <button class="act" :disabled="busy" @click="s.advanceChain()">
      <Icon name="check" :size="15" /> {{ busy ? '正在启动下一段…' : '批准并继续下一段' }}
    </button>
  </div>
</template>

<style scoped>
.card {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-color: var(--accent);
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
.ph h2 .ic { color: var(--accent-h); }
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
.wl:hover { border-color: var(--accent); color: #fff; }
.hint { font-size: 12px; color: var(--text-2); line-height: 1.6; margin: 0; }
.act {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13.5px;
  font-weight: 700;
  color: #fff;
  background: var(--accent);
  border: none;
  border-radius: 8px;
  padding: 9px 16px;
  cursor: pointer;
}
.act:hover:not(:disabled) { filter: brightness(1.08); }
.act:disabled { opacity: 0.6; cursor: default; }
</style>
