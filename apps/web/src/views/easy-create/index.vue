<script setup lang="ts">
import { onMounted, onBeforeUnmount, nextTick, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import AttachmentTray from './AttachmentTray.vue'
import AssetPickerModal from './AssetPickerModal.vue'
import Icon from '../../components/common/Icon.vue'
import { fmtTime } from '../../lib/format'
import { creationStatusLabel, creationStatusTone } from '../../lib/types'
import { memoryApi, templateApi, stylePresetApi, entityApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import type { Asset, CreationSessionListItem, RecommendItem, StylePresetItem, EntityItem } from '../../lib/types'
import { useEasyCreate } from './use-creation-chat'

const s = useEasyCreate()
const router = useRouter()
const idea = ref('')
const areaEl = ref<HTMLTextAreaElement | null>(null)

// Composer 输入台：textarea 随内容自动扩高（上限 280px，超出后内部滚动）
function grow(): void {
  const el = areaEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight + 2, 280)}px`
}
const showPicker = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

// ===== [batch5] 首轮「风格 / 角色预设」多选下拉（软提示基线，零计费）=====
// 选项复用现有 style-presets / entities?kind=character 列表（零新端点）；选中 id 同步进共享 state，
// 由 startIdea→首提时随 body 下发。截断到 cap（风格 6 / 角色 4）与后端契约一致；超出的选中项自动取消。
const MAX_STYLE = 6
const MAX_CAST = 4
const styleOptions = ref<StylePresetItem[]>([])
const castOptions = ref<EntityItem[]>([])
const selStyle = ref<string[]>([])
const selCast = ref<string[]>([])
async function loadPresets(): Promise<void> {
  try { styleOptions.value = (await stylePresetApi.list('?active=1')).items } catch { /* 无预设不阻断创作 */ }
  try { castOptions.value = (await entityApi.list('character')).items } catch { /* 同上 */ }
}
watch(selStyle, (v) => { s.state.stylePresetIds = v.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_STYLE) })
watch(selCast, (v) => { s.state.characterPresetIds = v.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_CAST) })
// 锁定（上传中）时禁止展开预设面板
function guardLocked(e: Event): void {
  if (s.first.locked.value) e.preventDefault()
}
// 预设气泡互斥：一个展开时自动收起另一个（同时只出现一个）
const stylePopEl = ref<HTMLDetailsElement | null>(null)
const castPopEl = ref<HTMLDetailsElement | null>(null)
function exclusivePop(openEl: HTMLDetailsElement | null, closeEl: HTMLDetailsElement | null): void {
  if (openEl?.open && closeEl?.open) closeEl.open = false
}

let departed = false
let handoffPath = ''
onBeforeRouteLeave((to) => {
  departed = true
  if (to.path !== handoffPath) s.leave()
})
onBeforeUnmount(() => { if (ideaRecTimer) clearTimeout(ideaRecTimer) })
async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  for (const file of files) { if (departed) break; await s.addAttachment(file) }
}
async function onPickAssets(assets: Asset[]) {
  showPicker.value = false
  for (const asset of assets) { if (departed) break; await s.addAssetReference(asset) }
}
async function abandonLocal() {
  if (!await confirmDialog({ title: '放弃本地草稿', message: '清除本次本地文字与参考选择？已创建的服务端草稿仍可在创作记录中查看或删除。', confirmText: '放弃本地草稿' })) return
  s.first.clear(0)
  s.state.attachments = []
  idea.value = ''
  void nextTick(grow)
}

const EXAMPLES = [
  '做一条 30 秒的咖啡科普短视频，轻松一点。',
  '用 45 秒讲一个温暖的睡前小故事，竖屏。',
  '介绍一款保温杯的卖点，30 秒，图文配音即可。',
]

// ===== 「试试」智能推荐：读「选题雷达」沉淀的选题库（memory type=topics），零新端点零计费 =====
// 无选题沉淀 / 接口失败 / 解析为空 → 静默回退静态 EXAMPLES（不编造原则）。
// 推荐以「短标题 + 形态标签」卡片展示，点击才把完整一句话填入输入台（避免长句胶囊换行乱）。
type TopicChip = { title: string; tag: string; sentence: string }
const FALLBACK_CHIPS: TopicChip[] = EXAMPLES.map((e) => ({ title: e, tag: '示例', sentence: e }))
const topicPool = ref<TopicChip[]>([])
const hasTopics = ref(false)
const chips = ref<TopicChip[]>([...FALLBACK_CHIPS])
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

/** 选题 → 推荐卡片：短标题 + 形态标签；完整一句话保留在 sentence（点击填入，句式与原契约一致） */
function topicChip(t: { title: string; format: string }): TopicChip {
  const full = t.title.length > 48 ? `${t.title.slice(0, 48)}…` : t.title
  const title = t.title.length > 36 ? `${t.title.slice(0, 36)}…` : t.title
  const f = t.format
  if (f.startsWith('drama') || f.startsWith('anime'))
    return { title, tag: '短剧 · 45秒 · 竖屏', sentence: `用 45 秒把「${full}」拍成有故事感的短剧视频，竖屏。` }
  if (f.startsWith('talking'))
    return { title, tag: '口播 · 30秒', sentence: `口播一条 30 秒的短视频：「${full}」，轻松一点。` }
  if (f === 'article' || f === 'note')
    return { title, tag: '图文 · 30秒', sentence: `把「${full}」做成 30 秒短视频，图文配音即可。` }
  return { title, tag: '视频 · 30秒 · 竖屏', sentence: `做一条 30 秒的短视频：「${full}」，竖屏，轻松一点。` }
}

/** 点击推荐卡：把完整一句话填入输入台 */
function useChip(t: TopicChip): void {
  idea.value = t.sentence
  void nextTick(grow)
}

/** 从候选池随机取 3 条（不足全取）；池为空则回退静态示例 */
function rollChips(): void {
  const pool = topicPool.value
  if (!pool.length) {
    chips.value = [...FALLBACK_CHIPS]
    return
  }
  const idx = pool.map((_, i) => i).sort(() => Math.random() - 0.5)
  chips.value = idx.slice(0, Math.min(3, pool.length)).map((i) => pool[i]!)
  rollSeq.value++
}

async function loadTopicChips(): Promise<void> {
  try {
    const res = await memoryApi.list('?type=topics&limit=3')
    const seen = new Set<string>()
    const list: TopicChip[] = []
    for (const mem of res.items ?? []) {
      for (const t of parseTopicLines(mem.content ?? '')) {
        const c = topicChip(t)
        if (seen.has(c.sentence)) continue
        seen.add(c.sentence)
        list.push(c)
        if (list.length >= 12) break
      }
      if (list.length >= 12) break
    }
    if (list.length) {
      topicPool.value = list
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
  s.enterHome()
  idea.value = s.first.state.ticket?.content ?? ''
  void nextTick(grow)
  void s.loadSessions()
  void loadTopicChips()
  void loadPresets()
})

async function go(): Promise<void> {
  const text = idea.value.trim()
  if (!text || s.first.busy.value || departed) return
  const id = await s.startIdea(text)
  if (id && !departed) {
    handoffPath = `/create/${id}`
    const failed = await router.push(handoffPath)
    if (failed) { s.first.pause(); s.state.error = '草稿已创建，请从创作记录进入并手动继续。' }
  }
}

// idea debounce → 模板推荐提示（仅展示，不预选、不路由）
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
  grow()
  if (ideaRecTimer) clearTimeout(ideaRecTimer)
  ideaRecTimer = setTimeout(() => void fireIdeaRecommend(idea.value), 800)
}

// 状态 → 卡片左侧强调条 + 徽标色（走共享 creationStatusTone；started 控制态按 run 真实状态派生已完成/失败/取消）

// ===== 删除创作记录：未立项时一并回收影子项目，已立项只删对话（项目保留） =====
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

    <!-- ===== Prompt 卡：Composer 一体式输入台 ===== -->
    <section class="prompt panel">
      <label class="hl" for="idea">
        <Icon name="wand" :size="15" /> 描述你想要的视频
      </label>

      <div class="composer">
        <div class="field">
          <textarea
            id="idea"
            ref="areaEl"
            v-model="idea"
            rows="3"
            :maxlength="6000"
            :disabled="s.first.locked.value"
            placeholder="例如：做一条 30 秒的咖啡科普短视频，轻松一点。"
            @input="onIdeaInput"
            @keydown.enter.exact.prevent="go"
          />
          <span class="count mono">{{ idea.length }} / 6000</span>
        </div>

        <AttachmentTray v-if="s.state.attachments.length" :s="s" />

        <div class="crow">
          <div class="crow-tools">
            <!-- [batch5] 风格 / 角色预设：工具行胶囊 + 向上展开勾选面板（软提示基线，零计费、不进幂等） -->
            <details ref="stylePopEl" class="pop" :class="{ on: selStyle.length }" @toggle="exclusivePop(stylePopEl, castPopEl)">
              <summary class="pop-btn" aria-label="选择画风预设（可多选，作为画风基线）" @click="guardLocked">
                <Icon name="palette" :size="14" /> 画风
                <span class="pop-cnt mono">{{ selStyle.length }}/{{ MAX_STYLE }}</span>
              </summary>
              <div class="pop-panel">
                <label v-for="p in styleOptions" :key="p.id" class="pop-opt" :title="p.description || p.snippet">
                  <input type="checkbox" :value="String(p.id)" v-model="selStyle" :disabled="s.first.locked.value || (!selStyle.includes(String(p.id)) && selStyle.length >= MAX_STYLE)" />
                  <span class="pop-name">{{ p.name }}</span>
                </label>
                <p v-if="!styleOptions.length" class="pop-empty muted">暂无启用的画风预设，可在工作台创建</p>
                <p class="pop-tip muted">软提示：作为画风基线喂给规划模型，可在其上细化，不会凭空替换风格。</p>
              </div>
            </details>
            <details ref="castPopEl" class="pop" :class="{ on: selCast.length }" @toggle="exclusivePop(castPopEl, stylePopEl)">
              <summary class="pop-btn" aria-label="选择可复用角色（可多选，作为角色基线）" @click="guardLocked">
                <Icon name="users" :size="14" /> 角色
                <span class="pop-cnt mono">{{ selCast.length }}/{{ MAX_CAST }}</span>
              </summary>
              <div class="pop-panel">
                <label v-for="c in castOptions" :key="c.id" class="pop-opt">
                  <input type="checkbox" :value="String(c.id)" v-model="selCast" :disabled="s.first.locked.value || (!selCast.includes(String(c.id)) && selCast.length >= MAX_CAST)" />
                  <span class="pop-name">{{ c.name }}</span>
                </label>
                <p v-if="!castOptions.length" class="pop-empty muted">暂无角色，可先在工作台新建</p>
                <p class="pop-tip muted">软提示：作为角色基线喂给规划模型，不会丢弃已选角色特征。</p>
              </div>
            </details>
            <input ref="fileInput" type="file" accept="image/*,video/*,audio/*" multiple hidden @change="onFiles" />
            <button class="btn ghost" type="button" :disabled="s.attachmentsLocked.value" @click="fileInput?.click()"><Icon name="upload" :size="14" /> 添加参考</button>
            <button class="btn ghost" type="button" :disabled="s.attachmentsLocked.value" @click="showPicker = true"><Icon name="arrange" :size="14" /> 从素材选取</button>
            <button v-if="s.first.state.ticket" class="btn ghost" type="button" :disabled="s.first.busy.value" @click="abandonLocal">放弃本地草稿</button>
          </div>
          <button
            class="cta"
            type="button"
            :disabled="s.first.busy.value || !idea.trim()"
            @click="go"
          >
            <Icon name="bolt" :size="15" />
            {{ s.first.busy.value ? '创建草稿中…' : '生成方案' }}
          </button>
        </div>

        <details class="notes">
          <summary><Icon name="alert" :size="12" /> 费用与立项说明</summary>
          <p>参考仅保存在本地托盘，点击「生成方案」后才上传；上传中本批输入会锁定。</p>
          <p>上传不计模型费用；规划及参考视频解析可能计费。确认方案前不生成媒体、不立项；点「开始制作」才转为正式项目。</p>
        </details>
      </div>

      <p v-if="s.first.state.warning" class="muted" role="status">{{ s.first.state.warning }}</p>
      <div v-if="s.state.error" class="err-text" role="alert">{{ s.state.error }}</div>

      <!-- 创意→模板推荐提示（零成本 embedding，仅展示不预选不自动路由） -->
      <div v-if="ideaRec" class="idea-rec" role="status">
        <Icon name="sparkles" :size="13" />
        <span>
          此创意接近模板「<b>{{ ideaRec.name }}</b>」（score
          {{ ideaRec.score.toFixed(2) }}）——仅供参考，不会自动选用该模板。
        </span>
      </div>

      <!-- 选题推荐：短标题 + 形态标签卡片，点击填入完整一句话 -->
      <div class="topics">
        <div class="topics-h">
          <span class="ex-l muted"
            ><Icon :name="hasTopics ? 'sparkles' : 'chat'" :size="13" />
            {{ hasTopics ? '选题库推荐' : '试试' }}</span
          >
          <button
            v-if="hasTopics"
            class="roll"
            type="button"
            title="从选题库再随机换一批"
            @click="rollChips"
          >
            <Icon name="refresh" :size="12" /> 换一批
          </button>
        </div>
        <div class="topic-grid">
          <button
            v-for="(t, i) in chips"
            :key="`${rollSeq}-${i}`"
            class="topic-card"
            type="button"
            :title="
              hasTopics
                ? `${t.sentence}\n（来自「选题雷达」沉淀的选题库，点击填入）`
                : '点击填入'
            "
            :disabled="s.first.locked.value"
            @click="useChip(t)"
          >
            <span class="t-tag">{{ t.tag }}</span>
            <span class="t-title">{{ t.title }}</span>
          </button>
        </div>
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
    <AssetPickerModal v-if="showPicker" @close="showPicker = false" @pick="onPickAssets" />
  </div>
</template>

<style scoped src="./easy-create-home.css"></style>
