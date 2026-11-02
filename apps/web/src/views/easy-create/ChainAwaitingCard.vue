<script setup lang="ts">
/**
 * 段间批准卡（G1；接线）：服务端 sideCards 下发 key='chainAwaiting' 时渲染。
 * 「本段已完成·待你批准继续下一段」的段序/总数取自服务端落的 chain-await 消息 payload（后端为真源，前端不臆造）。
 * 当前段声明跨集承接（session.chainContinuityBlock，paused/continuity 阻塞也可见）时，
 * 先打开共享承接预览并冻结批准，再经 s.advanceChain 携包推进；advance 目标绑定 workflow/seq/previousRun。
 * 取消预览 → 不提交（零请求）；切会话/离开由 use-creation-chain 的 epoch 防旧响应写回。
 */
import { computed, ref, watch } from 'vue'
import Icon from '../../components/common/Icon.vue'
import ContinuityPreview from '../../components/run/ContinuityPreview.vue'
import { workflowTarget } from '../../lib/continuity-entry'
import { useCreationContinuity } from './use-creation-continuity'
import type { useEasyCreate } from './use-creation-chat'

const props = defineProps<{
  s: ReturnType<typeof useEasyCreate>
  workflowId?: number
}>()

const detail = computed(() => props.s.state.detail)
const wfId = computed(
  () => props.workflowId ?? detail.value?.session.workflowId ?? null,
)
// 最新一条 chain-await 消息（服务端续跑钩子回写）→ 已完成段序 / 下一段序 / 总段数
const awaiting = computed(() => {
  const msgs = detail.value?.messages ?? []
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const p = msgs[i]?.payload as {
      kind?: unknown
      seq?: unknown
      nextSeq?: unknown
      totalSegments?: unknown
    } | null
    if (p?.kind === 'chain-await') {
      return {
        doneSeq: Number(p.seq),
        nextSeq: Number(p.nextSeq),
        total: Number(p.totalSegments),
      }
    }
  }
  return null
})
/** paused 且 continuity 阻塞时服务端给目标签名（无 chain-await 消息也要可预览推进） */
const block = computed(() => detail.value?.session.chainContinuityBlock ?? null)
const summary = computed(
  () =>
    awaiting.value ??
    (block.value
      ? {
          doneSeq: block.value.target.nextSeq - 1,
          nextSeq: block.value.target.nextSeq,
          total: 0,
        }
      : null),
)
const continuity = useCreationContinuity(
  computed(() => detail.value?.session.projectId ?? 0),
)
const showPreview = ref(false)
const busy = computed(() => props.s.advanceBusy.busy)

function openPreview() {
  const b = block.value
  if (!b) {
    void props.s.advanceChain()
    return
  }
  continuity.setTarget(
    workflowTarget(
      b.target.workflowId,
      b.target.nextSeq,
      b.target.previousRunId,
    ),
  )
  showPreview.value = true
  void continuity.state.load()
}

async function advance() {
  if (block.value) {
    if (!continuity.approval.value) {
      openPreview()
      return
    }
    const ok = await props.s.advanceChain({
      approval: continuity.approval.value,
      requiresApproval: true,
    })
    if (ok) {
      showPreview.value = false
      continuity.clear()
    }
    return
  }
  await props.s.advanceChain()
}

// 推进位置/会话变化（跨会话或新 run）→ 旧批准与在途预览立即失效
watch(
  [
    () => block.value?.target.nextSeq,
    () => block.value?.target.previousRunId,
    () => detail.value?.session.id,
  ],
  () => {
    showPreview.value = false
    continuity.clear()
  },
)
</script>

<template>
  <div v-if="summary" class="card panel" aria-label="段间批准">
    <header class="ph">
      <h2>
        <Icon name="play" :size="16" /> 第 {{ summary.doneSeq + 1 }} 段已完成
      </h2>
      <RouterLink v-if="wfId" class="wl" :to="`/workflows/${wfId}`">
        <Icon name="external" :size="12" /> 链详情
      </RouterLink>
    </header>
    <p class="hint">
      <template v-if="summary.total > 0">共 {{ summary.total }} 段。</template>
      本段成果见左侧对话与下方进度卡。核对无误后批准，再启动第
      {{ summary.nextSeq + 1 }} 段（段间不自动级联计费）。
    </p>
    <p v-if="block" class="hint cont-hint">
      本段声明了跨集剧情连续性：需先核对承接包（缺口与费用风险）并冻结批准，未批准不会启动下一段。
    </p>
    <div v-if="showPreview && block" class="preview">
      <ContinuityPreview
        :state="continuity.state"
        @frozen="showPreview = false"
      />
      <button type="button" class="ghost" @click="showPreview = false">
        取消（不推进）
      </button>
    </div>
    <button class="act" :disabled="busy" @click="advance">
      <Icon name="check" :size="15" />
      {{
        busy
          ? '正在启动下一段…'
          : block && !continuity.frozen.value
            ? '预览承接并批准下一段'
            : '批准并继续下一段'
      }}
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
.hint {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.6;
  margin: 0;
}
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
.act:hover:not(:disabled) {
  filter: brightness(1.08);
}
.act:disabled {
  opacity: 0.6;
  cursor: default;
}
.cont-hint {
  color: var(--accent-h);
}
.preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ghost {
  align-self: flex-start;
  font-size: 12.5px;
  color: var(--text-2);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 6px 12px;
  cursor: pointer;
}
.ghost:hover {
  border-color: var(--accent);
  color: #fff;
}
</style>
