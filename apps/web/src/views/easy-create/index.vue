<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../../components/common/Icon.vue'
import { fmtTime } from '../../lib/format'
import { useEasyCreate } from './use-creation-chat'

const s = useEasyCreate()
const router = useRouter()
const idea = ref('')

const EXAMPLES = [
  '做一条 30 秒的咖啡科普短视频，轻松一点。',
  '用 45 秒讲一个温暖的睡前小故事，竖屏。',
  '介绍一款保温杯的卖点，30 秒，图文配音即可。',
]

onMounted(() => void s.loadSessions())

async function go(): Promise<void> {
  const text = idea.value.trim()
  if (!text) return
  const id = await s.startIdea(text)
  if (id) void router.push(`/create/${id}`)
}

const STATUS_TEXT: Record<string, string> = {
  draft: '草稿', planning: '规划中', ready: '待确认', starting: '启动中', started: '制作中',
}
</script>

<template>
  <div class="ec">
    <div class="page-h">
      <h1>轻松创作</h1>
      <span class="sub">一句话 → 方案 → 确认 → 成片</span>
    </div>

    <section class="hero panel">
      <label class="hl" for="idea">描述你想要的视频</label>
      <textarea
        id="idea"
        v-model="idea"
        rows="3"
        :maxlength="6000"
        :disabled="s.state.busySend"
        placeholder="例如：做一条 30 秒的咖啡科普短视频，轻松一点。"
        @keydown.enter.exact.prevent="go"
      />
      <div class="ex">
        <button v-for="e in EXAMPLES" :key="e" class="chip q" type="button" @click="idea = e">{{ e }}</button>
      </div>
      <div class="hfoot">
        <span class="muted hint"><Icon name="alert" :size="12" /> 发送后自动创建创作草稿并开始规划（会产生 LLM 费用）；确认方案前不会生成任何媒体。</span>
        <button class="btn primary" type="button" :disabled="s.state.busySend || !idea.trim()" @click="go">
          <Icon name="sparkles" :size="15" /> {{ s.state.busySend ? '规划中…' : '开始创作' }}
        </button>
      </div>
      <div v-if="s.state.error" class="err-text">{{ s.state.error }}</div>
    </section>

    <section class="recent">
      <h2 class="rt">我的创作</h2>
      <div v-if="s.state.loadingList" class="empty">加载中…</div>
      <div v-else-if="!s.state.sessions.length" class="empty">还没有创作记录，从上面一句话开始吧。</div>
      <div v-else class="grid">
        <RouterLink v-for="c in s.state.sessions" :key="c.id" class="item panel" :to="`/create/${c.id}`">
          <div class="it-top">
            <span class="badge" :class="c.status === 'started' ? 'running' : c.status === 'ready' ? 'pending' : c.status === 'draft' ? 'cancelled' : 'pending'">
              {{ STATUS_TEXT[c.status] ?? c.status }}
            </span>
            <span class="it-time muted">{{ fmtTime(c.updatedAt) }}</span>
          </div>
          <div class="it-name">{{ c.name }}</div>
          <div class="it-go">继续 <Icon name="chevron-right" :size="13" /></div>
        </RouterLink>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ec { max-width: 980px; }
.hero { padding: 18px 20px; display: flex; flex-direction: column; gap: 10px; }
.hl { font-size: 13px; color: var(--text-2); font-weight: 600; }
.hero textarea { font-size: 14.5px; line-height: 1.6; }
.ex { display: flex; flex-wrap: wrap; gap: 8px; }
.chip.q { cursor: pointer; border: 1px solid var(--border-strong); background: var(--raised); color: var(--text-2); padding: 4px 11px; border-radius: 999px; font-size: 12px; }
.chip.q:hover { border-color: var(--accent); color: #fff; }
.hfoot { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.hint { display: inline-flex; gap: 5px; align-items: center; flex: 1; min-width: 220px; }
.hint .ic { color: var(--warn); }
.recent { margin-top: 26px; }
.rt { font-size: 14px; margin: 0 0 12px; color: var(--text-2); font-weight: 600; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.item { padding: 13px 15px; display: flex; flex-direction: column; gap: 8px; text-decoration: none; color: inherit; transition: border-color 0.15s, background 0.15s; }
.item:hover { border-color: rgb(99 102 241 / 55%); background: var(--panel-2); text-decoration: none; }
.it-top { display: flex; align-items: center; justify-content: space-between; }
.it-name { font-size: 14px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.it-time { font-size: 11.5px; }
.it-go { font-size: 12px; color: var(--accent-h); display: inline-flex; align-items: center; gap: 3px; }
</style>
