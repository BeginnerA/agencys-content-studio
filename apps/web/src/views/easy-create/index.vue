<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../../components/common/Icon.vue'
import { fmtTime } from '../../lib/format'
import { creationStatusLabel, creationStatusTone } from '../../lib/types'
import { memoryApi, templateApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import type { CreationSessionListItem, RecommendItem } from '../../lib/types'
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
  if (f.startsWith('drama') || f.startsWith('anime'))
    return `用 45 秒把「${title}」拍成有故事感的短剧视频，竖屏。`
  if (f.startsWith('talking'))
    return `口播一条 30 秒的短视频：「${title}」，轻松一点。`
  if (f === 'article' || f === 'note')
    return `把「${title}」做成 30 秒短视频，图文配音即可。`
  return `做一条 30 秒的短视频：「${title}」，竖屏，轻松一点。`
}

/** 从候选池随机取 3 条（不足全取）；池为空则回退静态示例 */
function rollChips(): void {
  const pool = topicPool.value
  if (!pool.length) {
    chips.value = [...EXAMPLES]
    return
  }
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
  } catch {
    /* 静默：保留静态示例 */
  }
}

// 一句话成片的流程步骤（视觉化「流程感」，非可点击导航）
const STEPS = ['一句话', '方案', '确认', '成片']

onMounted(() => {
  void s.loadSessions()
  void loadTopicChips()
})

async function go(): Promise<void> {
  const text = idea.value.trim()
  if (!text) return
  const id = await s.startIdea(text)
  if (id) void router.push(`/create/${id}`)
}

// [M35 G7] idea debounce → 模板推荐提示（仅展示，不预选、不路由）
const ideaRec = ref<RecommendItem | null>(null)
let ideaRecTimer: ReturnType<typeof setTimeout> | null = null
async function fireIdeaRecommend(text: string): Promise<void> {
  const t = text.trim()
  if (!t || t.length < 6) {
    ideaRec.value = null
    return
  }
  try {
    const r = await templateApi.recommend(t, 1)
    ideaRec.value = r.items[0] ?? null
  } catch {
    ideaRec.value = null
  }
}
function onIdeaInput(): void {
  if (ideaRecTimer) clearTimeout(ideaRecTimer)
  ideaRecTimer = setTimeout(() => void fireIdeaRecommend(idea.value), 800)
}

// 状态 → 卡片左侧强调条 + 徽标色（走共享 creationStatusTone；started 控制态按 run 真实状态派生已完成/失败/取消）

// ===== [M40+] 删除创作记录：未立项时一并回收影子项目，已立项只删对话（项目保留） =====
const delBusy = ref(0)
const delNotice = ref('')
const delError = ref('')

async function removeItem(c: CreationSessionListItem): Promise<void> {
  const launched = c.status === 'started' || !!c.runId
  const ok = await confirmDialog({
    title: '删除创作记录',
    message: launched
      ? `删除「${c.name}」这条创作记录？\n已立项的作品会原样保留在项目列表（含全部产物），只删这次对话记录。`
      : `删除「${c.name}」？\n还没点「开始制作」，删掉不会留任何项目。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  delBusy.value = c.id
  delNotice.value = ''
  delError.value = ''
  const res = await s.removeSession(c.id)
  delBusy.value = 0
  // 失败就当场说清（在途制作/规划未结束会被服务端拒），不假称已删
  if (!res) {
    delError.value = s.state.error
    return
  }
  delNotice.value =
    res.mode === 'draft_purged'
      ? '已删除（尚未立项，没留任何项目）'
      : res.reason || '已删除创作记录（项目保留）'
}
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
          @input="onIdeaInput"
          @keydown.enter.exact.prevent="go"
        />
        <span class="count mono">{{ idea.length }} / 6000</span>
      </div>

      <div class="ex">
        <span class="ex-l muted"
          ><Icon :name="hasTopics ? 'sparkles' : 'chat'" :size="13" />
          {{ hasTopics ? '选题库推荐：' : '试试：' }}</span
        >
        <button
          v-for="(e, i) in chips"
          :key="`${rollSeq}-${i}`"
          class="chip q"
          type="button"
          :title="
            hasTopics ? '来自「选题雷达」沉淀的选题库，点击填入' : '点击填入'
          "
          @click="idea = e"
        >
          {{ e }}
        </button>
        <button
          v-if="hasTopics"
          class="chip q roll"
          type="button"
          title="从选题库再随机换一批"
          @click="rollChips"
        >
          <Icon name="refresh" :size="12" /> 换一批
        </button>
      </div>

      <div v-if="s.state.error" class="err-text">{{ s.state.error }}</div>

      <!-- [M35 G7] 创意→模板推荐提示（零成本 embedding，仅展示不预选不自动路由） -->
      <div v-if="ideaRec" class="idea-rec" role="status">
        <Icon name="sparkles" :size="13" />
        <span>
          此创意接近模板「<b>{{ ideaRec.name }}</b>」（score
          {{ ideaRec.score.toFixed(2) }}）——发送后助手会基于该模板风格推进规划。
        </span>
      </div>

      <div class="pfoot">
        <span class="muted hint"
          ><Icon name="alert" :size="13" /> 发送后开始规划（会产生
          LLM 费用），确认前不生成媒体、不立项；点「开始制作」才创建项目，名称/载体/模板/标签/简介自动填好、可改。</span
        >
        <button
          class="cta"
          type="button"
          :disabled="s.state.busySend || !idea.trim()"
          @click="go"
        >
          <Icon name="bolt" :size="16" />
          {{ s.state.busySend ? '规划中…' : '开始创作' }}
        </button>
      </div>
    </section>

    <!-- ===== 我的创作 ===== -->
    <section class="recent">
      <div class="rh">
        <h2 class="rt"><Icon name="film" :size="16" /> 我的创作</h2>
        <span v-if="s.state.sessions.length" class="rcnt mono">{{
          s.state.sessions.length
        }}</span>
      </div>

      <div v-if="s.state.loadingList" class="empty">加载中…</div>
      <div v-else-if="!s.state.sessions.length" class="empty-card">
        <Icon name="inbox" :size="26" />
        <p>还没有创作记录</p>
        <span class="muted">从上方写下你的一句话，开始第一条成片。</span>
        <RouterLink
          v-if="!hasTopics"
          class="guide"
          :to="{ path: '/canvas', query: { template: 'topic-radar' } }"
        >
          <Icon name="sparkles" :size="13" />
          还没跑过选题雷达？先跑一次，让「试试」推荐你自己的选题
          <Icon name="arrow-left" :size="13" class="flip" />
        </RouterLink>
      </div>
      <div v-else class="grid">
        <RouterLink
          v-for="c in s.state.sessions"
          :key="c.id"
          class="item panel"
          :to="`/create/${c.id}`"
        >
          <span
            class="bar"
            :class="creationStatusTone(c.status, c.runStatus)"
            aria-hidden="true"
          />
          <div class="it-top">
            <span
              class="badge"
              :class="creationStatusTone(c.status, c.runStatus)"
            >
              {{ creationStatusLabel(c.status, c.confirmable, c.runStatus) }}
            </span>
            <span class="it-meta">
              <span class="it-time muted">{{ fmtTime(c.updatedAt) }}</span>
              <button
                class="it-del"
                type="button"
                title="删除这条创作记录"
                aria-label="删除这条创作记录"
                :disabled="delBusy > 0"
                @click.prevent.stop="removeItem(c)"
              >
                <Icon
                  :name="delBusy === c.id ? 'refresh' : 'trash'"
                  :size="13"
                />
              </button>
            </span>
          </div>
          <div class="it-name">{{ c.name }}</div>
          <div class="it-go">
            继续创作 <Icon name="arrow-left" :size="13" class="flip" />
          </div>
        </RouterLink>
      </div>
      <div v-if="delNotice" class="del-notice" role="status">
        <Icon name="check" :size="13" /> {{ delNotice }}
      </div>
      <div v-if="delError" class="del-notice err" role="alert">
        <Icon name="alert" :size="13" /> {{ delError }}
      </div>
    </section>
  </div>
</template>

<style scoped src="./easy-create-home.css"></style>
