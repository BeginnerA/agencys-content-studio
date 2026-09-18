<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import Icon from '../../components/common/Icon.vue'
import type { useEasyCreate } from './use-creation-chat'

const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()
const draft = ref('')
const scroller = ref<HTMLElement | null>(null)

// 新消息滚动到底部（尊重 reduced-motion：无平滑）
watch(
  () => [props.s.state.detail?.messages.length ?? 0, props.s.state.detail?.session.status],
  () => void nextTick(() => { if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight }),
)

function submit(): void {
  const text = draft.value.trim()
  if (!text || props.s.state.busySend) return
  draft.value = ''
  void props.s.send(text)
}

// 追问问题：点击填入输入框，便于用户直接作答
function useQuestion(q: string): void {
  draft.value = draft.value.trim() ? `${draft.value.trim()}\n${q}` : q
}

const planning = () => props.s.state.detail?.session.status === 'planning' || props.s.state.busySend
</script>

<template>
  <section class="conv panel" aria-label="创作对话">
    <div ref="scroller" class="msgs" role="log" aria-live="polite">
      <div v-if="!s.state.detail?.messages.length" class="hello">
        <Icon name="sparkles" :size="18" />
        <p>用一句话描述你想做的视频，比如「做一条 30 秒的咖啡科普短视频，轻松一点」。</p>
        <p class="muted">未指定时默认竖屏 9:16、中文旁白、30 秒、动态镜头。产品参数、价格、功效缺失不会编造。</p>
      </div>
      <div v-for="m in s.state.detail?.messages ?? []" :key="m.id" class="msg" :class="m.role">
        <div class="who">{{ m.role === 'user' ? '我' : '策划' }}</div>
        <div class="bubble">{{ m.content }}</div>
        <div v-if="m.payload?.kind === 'clarify' && m.payload.questions?.length" class="qs">
          <button v-for="(q, i) in m.payload.questions" :key="i" class="chip q" type="button" @click="useQuestion(q)">
            {{ q }}
          </button>
        </div>
      </div>
      <div v-if="planning()" class="msg assistant">
        <div class="who">策划</div>
        <div class="bubble wait"><span class="dot" /><span class="dot" /><span class="dot" /> 正在理解需求并生成方案…（本步骤会调用大模型，产生少量费用）</div>
      </div>
    </div>

    <div v-if="s.state.error" class="err-text pad">{{ s.state.error }}</div>

    <form class="composer" @submit.prevent="submit">
      <textarea
        v-model="draft"
        rows="2"
        :maxlength="6000"
        :disabled="planning()"
        placeholder="补充要求或修改方案，例如：换成温暖风格 / 改成图文模式 / 时长 45 秒"
        aria-label="创作需求"
        @keydown.enter.exact.prevent="submit"
      />
      <div class="crow">
        <span class="muted cost-hint"><Icon name="alert" :size="12" /> 对话规划会产生 LLM 费用；媒体制作在确认方案后进行。</span>
        <button class="btn primary" type="submit" :disabled="planning() || !draft.trim()">
          <Icon name="send" :size="14" /> {{ planning() ? '处理中…' : '发送' }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.conv {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.msgs {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.hello {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.7;
  border: 1px dashed var(--border-strong);
  border-radius: 10px;
  padding: 14px 16px;
  background: var(--hover);
}
.hello p { margin: 6px 0 0; }
.hello .ic { color: var(--accent-h); vertical-align: -3px; margin-right: 4px; }
.msg .who { font-size: 11px; color: var(--text-3); margin-bottom: 3px; }
.msg.user .who { text-align: right; }
.bubble {
  display: inline-block;
  max-width: 92%;
  padding: 9px 13px;
  border-radius: 12px;
  font-size: 13.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--panel-2);
  border: 1px solid var(--border);
}
.msg.user { text-align: right; }
.msg.user .bubble { background: linear-gradient(135deg, rgb(139 92 246 / 22%), rgb(79 70 229 / 18%)); border-color: rgb(99 102 241 / 40%); color: #fff; }
.msg.assistant .bubble.wait { color: var(--text-2); display: inline-flex; align-items: center; gap: 6px; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--run); display: inline-block; animation: blink 1.1s infinite; }
.dot:nth-child(2) { animation-delay: 0.18s; }
.dot:nth-child(3) { animation-delay: 0.36s; }
.qs { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 7px; }
.chip.q { cursor: pointer; border-color: var(--border-strong); background: var(--raised); color: var(--text); padding: 4px 11px; }
.chip.q:hover { border-color: var(--accent); color: #fff; }
.pad { padding: 0 16px; margin: 0; }
.composer { border-top: 1px solid var(--border); padding: 12px 16px; background: var(--panel); }
.composer textarea { font-size: 13.5px; }
.crow { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
.cost-hint { display: inline-flex; align-items: center; gap: 5px; margin-left: auto; text-align: right; }
.cost-hint .ic { color: var(--warn); }
@media (prefers-reduced-motion: reduce) {
  .dot { animation: none; }
}
</style>
