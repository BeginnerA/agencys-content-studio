<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../../components/common/Icon.vue'
import { fmtTime } from '../../lib/format'
import { creationStatusLabel, creationStatusTone } from '../../lib/types'
import { memoryApi } from '../../lib/api'
import { useEasyCreate } from './use-creation-chat'

const s = useEasyCreate()
const router = useRouter()
const idea = ref('')

const EXAMPLES = [
  '做一条 30 秒的咖啡科普短视频，轻松一点。',
  '用 45 秒讲一个温暖的睡前小故事，竖屏。',
  '介绍一款保温杯的卖点，30 秒，图文配音即可。',
]

// ===== 「试试」智能推荐：读「选题雷达」沉淀的选题库（memory type=topics），零新端点零计费 =====
// 无选题沉淀 / 接口失败 / 解析为空 → 静默回退静态 EXAMPLES（不编造原则）。
const topicPool = ref<string[]>([])
const hasTopics = ref(false)
const chips = ref<string[]>([...EXAMPLES])
const rollSeq = ref(0)

/** 解析选题清单标题行：契约格式「## T01｜{选题方向}（{content_format}…，{type}）」（见 prompts/topic-radar.md） */
function parseTopicLines(md: string): { title: string; format: string }[] {
  const out: { title: string; format: string }[] = []
  const re = /^##\s*T\d+\s*[｜|]\s*(.+?)\s*（([^（）]+?)，/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(md))) {
    const title = (m[1] ?? '').trim()
    const format = (m[2] ?? '').split('·')[0]!.trim().toLowerCase()
    if (title) out.push({ title, format })
  }
  return out
}

/** 选题 → 轻松创作一句话：按内容形态给贴合的句式（视频/短剧/口播/图文长文） */
function topicSentence(t: { title: string; format: string }): string {
  const title = t.title.length > 48 ? `${t.title.slice(0, 48)}…` : t.title
  const f = t.format
  if (f.startsWith('drama') || f.startsWith('anime')) return `用 45 秒把「${title}」拍成有故事感的短剧视频，竖屏。`
  if (f.startsWith('talking')) return `口播一条 30 秒的短视频：「${title}」，轻松一点。`
  if (f === 'article' || f === 'note') return `把「${title}」做成 30 秒短视频，图文配音即可。`
  return `做一条 30 秒的短视频：「${title}」，竖屏，轻松一点。`
}

/** 从候选池随机取 3 条（不足全取）；池为空则回退静态示例 */
function rollChips(): void {
  const pool = topicPool.value
  if (!pool.length) { chips.value = [...EXAMPLES]; return }
  const idx = pool.map((_, i) => i).sort(() => Math.random() - 0.5)
  chips.value = idx.slice(0, Math.min(3, pool.length)).map((i) => pool[i]!)
  rollSeq.value++
}

async function loadTopicChips(): Promise<void> {
  try {
    const res = await memoryApi.list('?type=topics&limit=3')
    const sentences: string[] = []
    for (const mem of res.items ?? []) {
      for (const t of parseTopicLines(mem.content ?? '')) {
        const sent = topicSentence(t)
        if (!sentences.includes(sent)) sentences.push(sent)
        if (sentences.length >= 12) break
      }
      if (sentences.length >= 12) break
    }
    if (sentences.length) {
      topicPool.value = sentences
      hasTopics.value = true
      rollChips()
    }
  } catch { /* 静默：保留静态示例 */ }
}

// 一句话成片的流程步骤（视觉化「流程感」，非可点击导航）
const STEPS = ['一句话', '方案', '确认', '成片']

onMounted(() => { void s.loadSessions(); void loadTopicChips() })

async function go(): Promise<void> {
  const text = idea.value.trim()
  if (!text) return
  const id = await s.startIdea(text)
  if (id) void router.push(`/create/${id}`)
}

// 状态 → 卡片左侧强调条 + 徽标色（走共享 creationStatusTone；started 控制态按 run 真实状态派生已完成/失败/取消）
</script>

<template>
  <div class="ec">
    <!-- ===== Hero：品牌标题 + 流程步骤 ===== -->
    <header class="hero">
      <div class="hero-glow" aria-hidden="true" />
      <div class="hero-in">
        <h1 class="title"><Icon name="sparkles" :size="26" /> 轻松创作</h1>
        <p class="tagline">一句话，交给策划助手 —— 从灵感到成片。</p>
        <ol class="steps" aria-label="创作流程">
          <li v-for="(st, i) in STEPS" :key="st" class="step">
            <span class="dot">{{ i + 1 }}</span>
            <span class="st-t">{{ st }}</span>
            <span v-if="i < STEPS.length - 1" class="link" aria-hidden="true" />
          </li>
        </ol>
      </div>
    </header>

    <!-- ===== Prompt 卡 ===== -->
    <section class="prompt panel">
      <label class="hl" for="idea">
        <Icon name="wand" :size="15" /> 描述你想要的视频
      </label>
      <div class="field">
        <textarea
          id="idea"
          v-model="idea"
          rows="4"
          :maxlength="6000"
          :disabled="s.state.busySend"
          placeholder="例如：做一条 30 秒的咖啡科普短视频，轻松一点。"
          @keydown.enter.exact.prevent="go"
        />
        <span class="count mono">{{ idea.length }} / 6000</span>
      </div>

      <div class="ex">
        <span class="ex-l muted"><Icon :name="hasTopics ? 'sparkles' : 'chat'" :size="13" /> {{ hasTopics ? '选题库推荐：' : '试试：' }}</span>
        <button
          v-for="(e, i) in chips"
          :key="`${rollSeq}-${i}`"
          class="chip q"
          type="button"
          :title="hasTopics ? '来自「选题雷达」沉淀的选题库，点击填入' : '点击填入'"
          @click="idea = e"
        >{{ e }}</button>
        <button v-if="hasTopics" class="chip q roll" type="button" title="从选题库再随机换一批" @click="rollChips">
          <Icon name="refresh" :size="12" /> 换一批
        </button>
      </div>

      <div v-if="s.state.error" class="err-text">{{ s.state.error }}</div>

      <div class="pfoot">
        <span class="muted hint"><Icon name="alert" :size="13" /> 发送后自动创建草稿并开始规划（会产生 LLM 费用）；确认方案前不会生成任何媒体。</span>
        <button class="cta" type="button" :disabled="s.state.busySend || !idea.trim()" @click="go">
          <Icon name="bolt" :size="16" /> {{ s.state.busySend ? '规划中…' : '开始创作' }}
        </button>
      </div>
    </section>

    <!-- ===== 我的创作 ===== -->
    <section class="recent">
      <div class="rh">
        <h2 class="rt"><Icon name="film" :size="16" /> 我的创作</h2>
        <span v-if="s.state.sessions.length" class="rcnt mono">{{ s.state.sessions.length }}</span>
      </div>

      <div v-if="s.state.loadingList" class="empty">加载中…</div>
      <div v-else-if="!s.state.sessions.length" class="empty-card">
        <Icon name="inbox" :size="26" />
        <p>还没有创作记录</p>
        <span class="muted">从上方写下你的一句话，开始第一条成片。</span>
        <RouterLink v-if="!hasTopics" class="guide" :to="{ path: '/canvas', query: { template: 'topic-radar' } }">
          <Icon name="sparkles" :size="13" /> 还没跑过选题雷达？先跑一次，让「试试」推荐你自己的选题
          <Icon name="arrow-left" :size="13" class="flip" />
        </RouterLink>
      </div>
      <div v-else class="grid">
        <RouterLink v-for="c in s.state.sessions" :key="c.id" class="item panel" :to="`/create/${c.id}`">
          <span class="bar" :class="creationStatusTone(c.status, c.runStatus)" aria-hidden="true" />
          <div class="it-top">
            <span class="badge" :class="creationStatusTone(c.status, c.runStatus)">
              {{ creationStatusLabel(c.status, c.confirmable, c.runStatus) }}
            </span>
            <span class="it-time muted">{{ fmtTime(c.updatedAt) }}</span>
          </div>
          <div class="it-name">{{ c.name }}</div>
          <div class="it-go">继续创作 <Icon name="arrow-left" :size="13" class="flip" /></div>
        </RouterLink>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ec { width: 100%; max-width: 1600px; margin: 0 auto; }

/* ---------- Hero ---------- */
.hero { position: relative; padding: 30px 0 26px; }
.hero-glow {
  position: absolute; top: -60px; left: 50%; transform: translateX(-50%);
  width: min(720px, 90%); height: 240px; pointer-events: none;
  background: radial-gradient(60% 60% at 50% 40%, rgb(99 102 241 / 26%), transparent 72%);
  filter: blur(6px);
}
.hero-in { position: relative; text-align: center; }
.title {
  display: inline-flex; align-items: center; gap: 10px; margin: 0;
  font-size: 30px; font-weight: 800; letter-spacing: 0.5px;
  background: linear-gradient(120deg, #8b5cf6, #a5b4fc 55%, #e0e7ff);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.title .ic { color: var(--accent-h); }
.tagline { margin: 8px 0 20px; color: var(--text-2); font-size: 14px; }

.steps { list-style: none; margin: 0; padding: 0; display: inline-flex; align-items: center; gap: 0; flex-wrap: wrap; justify-content: center; }
.step { display: inline-flex; align-items: center; }
.step .dot {
  width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; color: #dbe3ff; background: var(--accent-weak); border: 1px solid rgb(99 102 241 / 45%);
}
.st-t { margin: 0 8px; font-size: 13px; color: var(--text-2); font-weight: 500; }
.step .link { width: 30px; height: 1px; background: linear-gradient(90deg, rgb(99 102 241 / 45%), rgb(148 163 184 / 16%)); }

/* ---------- Prompt 卡 ---------- */
.prompt {
  position: relative; padding: 22px 24px; display: flex; flex-direction: column; gap: 12px;
  box-shadow: var(--shadow-lg), 0 0 0 1px rgb(99 102 241 / 8%) inset;
  background: linear-gradient(180deg, rgb(99 102 241 / 5%), transparent 42%), var(--panel);
}
.hl { display: inline-flex; align-items: center; gap: 7px; font-size: 13.5px; color: var(--text); font-weight: 600; }
.hl .ic { color: var(--accent-h); }
.field { position: relative; }
.field textarea { font-size: 15px; line-height: 1.7; padding-bottom: 26px; resize: vertical; min-height: 108px; }
.count { position: absolute; right: 12px; bottom: 10px; font-size: 11px; color: var(--text-3); pointer-events: none; }

.ex { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.ex-l { display: inline-flex; align-items: center; gap: 4px; }
.ex-l .ic { color: var(--text-3); }
.chip.q { cursor: pointer; border: 1px solid var(--border-strong); background: var(--raised); color: var(--text-2); padding: 5px 12px; border-radius: 999px; font-size: 12px; transition: border-color 0.15s, color 0.15s, background 0.15s; }
.chip.q:hover { border-color: var(--accent); color: #fff; background: var(--accent-weak); }
.chip.q.roll { display: inline-flex; align-items: center; gap: 4px; color: var(--accent-h); border-color: rgb(99 102 241 / 40%); }

.pfoot { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-top: 2px; }
.hint { display: inline-flex; gap: 6px; align-items: center; flex: 1; min-width: 240px; line-height: 1.5; }
.hint .ic { color: var(--warn); flex: none; }
.cta {
  display: inline-flex; align-items: center; gap: 8px; border: none; cursor: pointer;
  background: var(--grad-brand); color: #fff; font-size: 14.5px; font-weight: 600;
  padding: 11px 24px; border-radius: 11px; box-shadow: 0 8px 22px -10px rgb(79 70 229 / 75%);
  transition: filter 0.15s, transform 0.1s, box-shadow 0.15s;
}
.cta:hover:not(:disabled) { filter: brightness(1.08); box-shadow: 0 10px 26px -10px rgb(79 70 229 / 85%); }
.cta:active:not(:disabled) { transform: translateY(1px); }
.cta:disabled { opacity: 0.5; cursor: not-allowed; }

/* ---------- 我的创作 ---------- */
.recent { margin-top: 34px; }
.rh { display: flex; align-items: center; gap: 9px; margin: 0 0 14px; }
.rt { display: inline-flex; align-items: center; gap: 8px; font-size: 15px; margin: 0; color: var(--text); font-weight: 700; }
.rt .ic { color: var(--accent-h); }
.rcnt { font-size: 11.5px; color: var(--text-3); background: var(--chip-bg); border-radius: 999px; padding: 1px 8px; }

.empty-card {
  display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center;
  border: 1px dashed var(--border-strong); border-radius: 14px; padding: 40px 20px; color: var(--text-2); background: var(--hover);
}
.empty-card .ic { color: var(--text-3); margin-bottom: 6px; }
.empty-card p { margin: 0; font-size: 14px; font-weight: 600; color: var(--text); }
.empty-card span { font-size: 12.5px; }
.guide {
  display: inline-flex; align-items: center; gap: 5px; margin-top: 10px;
  font-size: 12.5px; color: var(--accent-h); text-decoration: none;
  border: 1px solid rgb(99 102 241 / 35%); background: var(--accent-weak);
  padding: 6px 14px; border-radius: 999px; transition: border-color 0.15s, color 0.15s;
}
.guide:hover { border-color: var(--accent); color: #fff; text-decoration: none; }
.guide .flip { transform: rotate(180deg); }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.item {
  position: relative; overflow: hidden; padding: 15px 16px 15px 20px; display: flex; flex-direction: column; gap: 9px;
  text-decoration: none; color: inherit; transition: border-color 0.16s, background 0.16s, transform 0.16s, box-shadow 0.16s;
}
.item:hover { border-color: rgb(99 102 241 / 55%); background: var(--panel-2); transform: translateY(-2px); box-shadow: var(--shadow-lg); text-decoration: none; }
.item .bar { position: absolute; left: 0; top: 0; bottom: 0; width: 3px; }
.bar.running { background: linear-gradient(180deg, #8b5cf6, #6366f1); }
.bar.pending { background: linear-gradient(180deg, #fbbf24, #f59e0b); }
.bar.completed { background: linear-gradient(180deg, #22c55e, #16a34a); }
.bar.failed { background: linear-gradient(180deg, #f87171, #dc2626); }
.bar.cancelled { background: rgb(148 163 184 / 40%); }
.it-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.it-name { font-size: 14.5px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.it-time { font-size: 11.5px; flex: none; }
.it-go { font-size: 12px; color: var(--accent-h); display: inline-flex; align-items: center; gap: 4px; }
.it-go .flip { transform: rotate(180deg); }

@media (max-width: 640px) {
  .title { font-size: 24px; }
  .step .link { width: 18px; }
  .prompt { padding: 18px; }
}
</style>
