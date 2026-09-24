<script setup lang="ts">
/**
 * 全局命令面板（Ctrl/Cmd+K 或侧栏搜索按钮打开）
 * 分区：导航（9 主导航页）/ 搜索结果（关键词 + 语义）/ 操作（全局新建 + 当前页上下文动作）。
 * 键盘流：输入即过滤；↑↓ 循环选择 / Enter 执行 / Esc 关闭（esc-layer 仲裁）；鼠标悬停同步高亮。
 * 操作类动作（取消运行 / 取消批次）走 confirmDialog(danger) 二次确认；用户取消确认 → 面板保持打开。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { batchApi, runApi, searchApi } from '../../lib/api'
import type { SearchResult } from '../../lib/types'
import { registerEscLayer } from '../../lib/esc-layer'
import { confirmDialog } from '../../lib/confirm'
import { NAVS } from '../../lib/nav'
import Icon from './Icon.vue'

const emit = defineEmits<{ close: [] }>()
const router = useRouter()
const route = useRoute()

// 嵌套覆盖层仲裁：仅最顶层响应 Esc（对齐 Modal 惯例）
const escLayer = registerEscLayer()

// ---- 条目模型（分组渲染 + 扁平选择序） ----
interface Entry {
  key: string
  title: string
  subtitle?: string
  icon?: string
  /** 相似度（0-1，仅语义命中有值） */
  score?: number
  danger?: boolean
  /** 直达条目：关闭面板后路由跳转 */
  url?: string
  /** 动作条目：返回 true = 已执行（关闭面板），false = 用户中止（保持打开） */
  act?: () => Promise<boolean>
}

type IndexedEntry = Entry & { idx: number }

const q = ref('')
const loading = ref(false)
const errorMsg = ref('')
const result = ref<SearchResult | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const activeIdx = ref(0)
const executing = ref(false)
/** 当前页上下文动作（打开时按 route 解析：run 页取消运行 / batch 页取消批次） */
const ctxEntries = ref<Entry[]>([])

// 请求竞态：仅最后一次响应生效（连续输入时旧响应丢弃）
let seq = 0
let timer: number | null = null

function scheduleSearch() {
  if (timer !== null) window.clearTimeout(timer)
  const query = q.value.trim()
  if (!query) {
    seq += 1 // 使在途响应失效
    loading.value = false
    errorMsg.value = ''
    result.value = null
    return
  }
  loading.value = true
  timer = window.setTimeout(() => void runSearch(query), 250)
}

async function runSearch(query: string) {
  const my = ++seq
  try {
    const r = await searchApi.search(query)
    if (my !== seq) return
    result.value = r
    errorMsg.value = ''
  } catch (err) {
    if (my !== seq) return
    result.value = null
    errorMsg.value =
      err instanceof Error && err.message ? err.message : '搜索失败'
  } finally {
    if (my === seq) loading.value = false
  }
}

watch(q, scheduleSearch)

// ---- 静态条目：导航 + 全局动作 ----
const navEntries: Entry[] = NAVS.map((n) => ({
  key: `nav:${n.to}`,
  title: n.label,
  icon: n.icon,
  url: n.to,
}))

const globalActions: Entry[] = [
  {
    key: 'act:new-project',
    title: '新建项目',
    subtitle: '项目页打开创建弹窗',
    icon: 'plus',
    url: '/?new=1',
  },
  {
    key: 'act:new-schedule',
    title: '新建排产计划',
    subtitle: '统计 · 排产 Tab 打开新建表单',
    icon: 'calendar',
    url: '/stats?tab=schedule&new=1',
  },
]

function filterEntries(list: Entry[], kw: string): Entry[] {
  return list.filter(
    (e) =>
      e.title.toLowerCase().includes(kw) ||
      (e.subtitle ?? '').toLowerCase().includes(kw),
  )
}

// ---- 分组组装（idx 即扁平选择序） ----
const groups = computed<Array<{ label: string; items: IndexedEntry[] }>>(() => {
  const kw = q.value.trim().toLowerCase()
  const out: Array<{ label: string; items: IndexedEntry[] }> = []
  let idx = 0
  const push = (label: string, items: Entry[]): void => {
    if (!items.length) return
    out.push({ label, items: items.map((it) => ({ ...it, idx: idx++ })) })
  }
  if (kw) {
    const sr = result.value
    if (sr) {
      for (const g of sr.groups) {
        push(
          g.label,
          g.items.map((it) => ({
            key: `s:${g.domain}:${it.id}`,
            title: it.title,
            subtitle: it.subtitle ?? undefined,
            url: it.url,
          })),
        )
      }
      push(
        '语义',
        sr.semantic.hits.map((h) => ({
          key: `sm:${h.entity}:${h.id}`,
          title: h.title,
          subtitle: h.snippet || (h.entity === 'memory' ? '记忆' : '文本资产'),
          score: h.score,
          url: h.url,
        })),
      )
    }
    push('导航', filterEntries(navEntries, kw))
    push('操作', filterEntries([...globalActions, ...ctxEntries.value], kw))
  } else {
    push('导航', navEntries)
    push('操作', [...globalActions, ...ctxEntries.value])
  }
  return out
})

const flatEntries = computed<Entry[]>(() =>
  groups.value.flatMap((g) => g.items),
)
const flatCount = computed(() => flatEntries.value.length)

// 结果集变化 → 高亮归零
watch(groups, () => {
  activeIdx.value = 0
})

// ---- 执行 ----
function goto(url: string): void {
  emit('close')
  void router.push(url)
}

async function runEntry(entry: Entry): Promise<void> {
  if (executing.value) return
  if (entry.url) {
    goto(entry.url)
    return
  }
  if (!entry.act) return
  executing.value = true
  errorMsg.value = ''
  try {
    const done = await entry.act()
    if (done) emit('close')
  } catch (e) {
    errorMsg.value = e instanceof Error && e.message ? e.message : '操作失败'
  } finally {
    executing.value = false
  }
}

function scrollActiveIntoView(): void {
  void nextTick(() => {
    document
      .querySelector(`.cp-item[data-idx="${activeIdx.value}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  })
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (escLayer.isTop()) emit('close')
    return
  }
  if (e.isComposing) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const n = flatCount.value
    if (!n) return
    e.preventDefault()
    activeIdx.value =
      e.key === 'ArrowDown'
        ? (activeIdx.value + 1) % n
        : (activeIdx.value - 1 + n) % n
    scrollActiveIntoView()
    return
  }
  if (e.key === 'Enter') {
    const entry = flatEntries.value[activeIdx.value]
    if (entry) void runEntry(entry)
  }
}

// ---- 上下文动作（打开时按当前路由解析） ----
async function loadContextActions(): Promise<void> {
  const runId = route.name === 'run' ? Number(route.params.id) : 0
  const batchId = route.name === 'batch' ? Number(route.params.id) : 0
  if (Number.isInteger(runId) && runId > 0) {
    let status = ''
    try {
      status = (await runApi.detail(runId)).run.status
    } catch {
      return // 拉取失败：不展示上下文动作
    }
    if (!['running', 'queued', 'waiting_input'].includes(status)) return
    ctxEntries.value = [
      {
        key: `ctx:cancel-run-${runId}`,
        title: `取消运行 #${runId}`,
        subtitle: '运行置为已取消；已产出内容保留',
        icon: 'stop',
        danger: true,
        act: async () => {
          const ok = await confirmDialog({
            title: '取消运行',
            message: `确认取消运行 #${runId}？正在执行的步骤将停止，已产出内容保留。`,
            confirmText: '取消运行',
            danger: true,
          })
          if (!ok) return false
          await runApi.cancel(runId)
          return true
        },
      },
    ]
    return
  }
  if (Number.isInteger(batchId) && batchId > 0) {
    let status = ''
    try {
      status = (await batchApi.detail(batchId)).batch.status
    } catch {
      return
    }
    if (status !== 'running') return
    ctxEntries.value = [
      {
        key: `ctx:cancel-batch-${batchId}`,
        title: `取消批次 #${batchId}`,
        subtitle: '批内进行中与排队的运行一并停止',
        icon: 'stop',
        danger: true,
        act: async () => {
          const ok = await confirmDialog({
            title: '取消批次',
            message: `确认取消批次 #${batchId}？批内进行中与排队的运行将一并停止。`,
            confirmText: '取消批次',
            danger: true,
          })
          if (!ok) return false
          await batchApi.cancel(batchId)
          return true
        },
      },
    ]
  }
}

onMounted(() => {
  escLayer.hold()
  window.addEventListener('keydown', onKey)
  inputEl.value?.focus()
  void loadContextActions()
})
onBeforeUnmount(() => {
  escLayer.release()
  window.removeEventListener('keydown', onKey)
  if (timer !== null) window.clearTimeout(timer)
})
</script>

<template>
  <Teleport to="body">
    <div class="cp-mask" @click.self="emit('close')">
      <div
        class="cp panel"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
      >
        <div class="cp-input">
          <Icon name="search" :size="15" />
          <input
            ref="inputEl"
            v-model="q"
            type="text"
            placeholder="搜索或输入命令：项目 / 运行 / 资产 / 实体 / 画布 …"
            aria-label="搜索关键词或命令"
          />
          <kbd>Esc</kbd>
        </div>
        <div class="cp-body">
          <div v-if="errorMsg" class="cp-hint err">{{ errorMsg }}</div>
          <section v-for="g in groups" :key="g.label">
            <div class="cp-group">{{ g.label }}</div>
            <button
              v-for="it in g.items"
              :key="it.key"
              class="cp-item"
              :class="{ active: it.idx === activeIdx, danger: it.danger }"
              :data-idx="it.idx"
              type="button"
              @click="runEntry(it)"
              @mouseenter="activeIdx = it.idx"
            >
              <Icon v-if="it.icon" :name="it.icon" :size="14" class="ico" />
              <span class="mid">
                <span class="row">
                  <span class="t">{{ it.title }}</span>
                  <span v-if="it.score !== undefined" class="score mono"
                    >{{ Math.round(it.score * 100) }}%</span
                  >
                </span>
                <span v-if="it.subtitle" class="s">{{ it.subtitle }}</span>
              </span>
            </button>
          </section>
          <div v-if="q.trim() && loading && !flatCount" class="cp-hint">
            搜索中…
          </div>
          <div v-else-if="!loading && !flatCount" class="cp-empty">
            {{ q.trim() ? '无匹配结果' : '输入关键词搜索，或浏览下方命令' }}
          </div>
        </div>
        <div class="cp-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 执行</span>
          <span><kbd>Esc</kbd> 关闭</span>
          <span v-if="q.trim() && result?.semantic.indexing" class="sem"
            >语义索引构建中…</span
          >
          <span
            v-else-if="q.trim() && result && !result.semantic.available"
            class="sem"
            >语义搜索不可用（关键词不受影响）</span
          >
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cp-mask {
  position: fixed;
  inset: 0;
  background: rgb(3 6 14 / 45%);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  z-index: 90;
  animation: cp-fade 0.12s ease-out;
}

.cp {
  width: min(92vw, 640px);
  max-height: 62vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: cp-pop 0.16s ease-out;
}

@keyframes cp-fade {
  from {
    opacity: 0;
  }
}

@keyframes cp-pop {
  from {
    opacity: 0;
    transform: translateY(-8px) scale(0.985);
  }
}

.cp-input {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  color: var(--text-3);
  flex: none;
}

.cp-input input {
  flex: 1;
  border: none;
  background: transparent;
  padding: 0;
  font-size: 14px;
  color: var(--text);
}

.cp-input input:focus {
  outline: none;
}

.cp-input kbd {
  font-size: 10.5px;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  padding: 1px 5px;
  color: var(--text-3);
  font-family: var(--mono);
}

.cp-body {
  overflow-y: auto;
  padding: 6px 6px 8px;
  min-height: 120px;
}

.cp-group {
  font-size: 11px;
  color: var(--text-3);
  padding: 8px 9px 3px;
}

.cp-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  text-align: left;
  border: none;
  background: none;
  border-radius: 8px;
  padding: 7px 9px;
  cursor: pointer;
  color: var(--text);
  transition: background 0.1s;
}

.cp-item .ico {
  flex: none;
  color: var(--text-3);
}

.cp-item .mid {
  flex: 1;
  min-width: 0;
}

.cp-item.active {
  background: var(--hover);
}

.cp-item.active .ico {
  color: var(--text-2);
}

.cp-item.danger .t {
  color: var(--bad);
}

.cp-item:focus-visible {
  outline: none;
  background: var(--hover);
}

.cp-item .t {
  font-size: 13px;
}

.cp-item .row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.cp-item .row .t {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cp-item .score {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
  flex: none;
}

.cp-item .s {
  display: block;
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cp-hint {
  font-size: 11.5px;
  color: var(--text-3);
  padding: 6px 9px;
}

.cp-hint.err {
  color: var(--bad);
}

.cp-empty {
  font-size: 12.5px;
  color: var(--text-3);
  padding: 26px 16px;
  text-align: center;
}

.cp-foot {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 7px 14px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-3);
  flex: none;
}

.cp-foot kbd {
  font-size: 10px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  padding: 0 4px;
  font-family: var(--mono);
}

.cp-foot .sem {
  margin-left: auto;
}
</style>
