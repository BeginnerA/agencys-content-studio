<script setup lang="ts">
// 日期 / 日期时间选择（Dark Studio 主题）：触发器 + 弹出日历，替换原生 input[type=date] / datetime-local。
// - v-model 默认为 'YYYY-MM-DD'；withTime 模式下为 'YYYY-MM-DDTHH:mm'
// - withTime：时/分用下拉选择，选日或改时间即时提交 v-model，「确定」收起面板
// - 配色全量取自品牌 token：触发面卯槽深 · 选中品牌渐变 · hover 靛弱底 · 今天靛描边
// - 键盘：←/→/↑/↓ 移动焦点日 · Enter/空格 选中 · PgUp/PgDn 翻月 · Esc 收起（不透传给 Modal）
// - 触发按钮：Enter/空格/↓ 打开；点击外部收起；空间不足自动上翻
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from './Icon.vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    ariaLabel?: string
    /** 开启后 v-model 格式变为 'YYYY-MM-DDTHH:mm'，面板底部显示时间选择 */
    withTime?: boolean
  }>(),
  { placeholder: '选择日期', ariaLabel: '选择日期', withTime: false },
)
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const rootEl = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)
const triggerEl = ref<HTMLButtonElement | null>(null)

const open = ref(false)
/** 空间不足时向上展开 */
const up = ref(false)
/** 面板当前浏览的年月 */
const viewY = ref(0)
const viewM = ref(0)
/** 键盘焦点日（roving tabindex） */
const focusKey = ref('')

// ---------- 时间状态（withTime 模式草稿；选值即提交） ----------
const timeH = ref('09')
const timeM = ref('00')

// ---------- 日期工具（本地时区；手工解析避免 UTC 偏移坑） ----------
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 时间下拉选项（00-23 时 / 00-59 分） */
const HOURS = Array.from({ length: 24 }, (_, i) => pad2(i))
const MINUTES = Array.from({ length: 60 }, (_, i) => pad2(i))
function toKey(y: number, m: number, d: number): string {
  return `${y}-${pad2(m + 1)}-${pad2(d)}`
}
function parseKey(s: string): { y: number; m: number; d: number } | null {
  // 兼容 withTime 模式：截取前 10 位日期部分
  const mm = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!mm) return null
  const [, ys, ms, ds] = mm
  if (!ys || !ms || !ds) return null
  const y = Number(ys)
  const m = Number(ms) - 1
  const d = Number(ds)
  const dt = new Date(y, m, d)
  return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d ? { y, m, d } : null
}

const NOW = new Date()
const todayKey = toKey(NOW.getFullYear(), NOW.getMonth(), NOW.getDate())
const WEEK = ['日', '一', '二', '三', '四', '五', '六']

const sel = computed(() => parseKey(props.modelValue))
const displayText = computed(() => {
  const s = sel.value
  if (!s) return ''
  const base = `${s.y}年${s.m + 1}月${s.d}日`
  if (!props.withTime) return base
  // 从 modelValue 提取时间部分
  const tm = /T(\d{2}):(\d{2})/.exec(props.modelValue)
  return tm ? `${base} ${tm[1]}:${tm[2]}` : `${base} ${timeH.value}:${timeM.value}`
})
const viewLabel = computed(() => `${viewY.value}年${viewM.value + 1}月`)

interface Cell {
  key: string
  y: number
  m: number
  d: number
  inMonth: boolean
  isToday: boolean
  isSel: boolean
}

/** 日历网格：周日开头，行数按当月自适应（5 或 6 行） */
const cells = computed<Cell[]>(() => {
  const lead = new Date(viewY.value, viewM.value, 1).getDay()
  const days = new Date(viewY.value, viewM.value + 1, 0).getDate()
  const total = Math.ceil((lead + days) / 7) * 7
  const s = sel.value
  const out: Cell[] = []
  for (let i = 0; i < total; i++) {
    const dt = new Date(viewY.value, viewM.value, 1 - lead + i)
    const y = dt.getFullYear()
    const m = dt.getMonth()
    const d = dt.getDate()
    const key = toKey(y, m, d)
    out.push({
      key,
      y,
      m,
      d,
      inMonth: m === viewM.value,
      isToday: key === todayKey && m === viewM.value,
      isSel: !!s && s.y === y && s.m === m && s.d === d,
    })
  }
  return out
})

const rows = computed<Cell[][]>(() => {
  const out: Cell[][] = []
  for (let i = 0; i < cells.value.length; i += 7) out.push(cells.value.slice(i, i + 7))
  return out
})

// ---------- 开合 ----------
function focusCell() {
  void nextTick(() => {
    panelEl.value?.querySelector<HTMLElement>(`[data-key="${focusKey.value}"]`)?.focus()
  })
}

function openPanel() {
  const s = sel.value
  viewY.value = s ? s.y : NOW.getFullYear()
  viewM.value = s ? s.m : NOW.getMonth()
  focusKey.value = s ? toKey(s.y, s.m, s.d) : todayKey
  // withTime：草稿时间与 modelValue 对齐（无时间部分时回默认 09:00）
  if (props.withTime) {
    const tm = /T(\d{2}):(\d{2})/.exec(props.modelValue)
    timeH.value = tm ? tm[1]! : '09'
    timeM.value = tm ? tm[2]! : '00'
  }
  open.value = true
  void nextTick(() => {
    // 按实测面板高度与视口空间选择展开方向
    const box = triggerEl.value?.getBoundingClientRect()
    if (box) {
      const need = (panelEl.value?.offsetHeight ?? 330) + 8
      const below = window.innerHeight - box.bottom - 12
      const above = box.top - 12
      up.value = above > below && below < need
    }
    focusCell()
  })
}

function closePanel(refocusTrigger = false) {
  open.value = false
  if (refocusTrigger) triggerEl.value?.focus()
}

function toggle() {
  if (open.value) closePanel()
  else openPanel()
}

/** 组装输出值：withTime 模式拼接 T{HH}:{mm} */
function buildValue(dateKey: string): string {
  return props.withTime ? `${dateKey}T${timeH.value}:${timeM.value}` : dateKey
}

// ---------- 选择 ----------
function pick(y: number, m: number, d: number) {
  emit('update:modelValue', buildValue(toKey(y, m, d)))
  if (!props.withTime) closePanel(true)
}

function pickToday() {
  emit('update:modelValue', buildValue(todayKey))
  if (!props.withTime) closePanel(true)
}

function clear() {
  emit('update:modelValue', '')
  closePanel(true)
}

/** 时间下拉变化：已有选中日期时即时提交（避免收起面板后丢失时间改动） */
function commitTime() {
  const s = sel.value
  if (!s) return
  emit('update:modelValue', buildValue(toKey(s.y, s.m, s.d)))
}

// ---------- 键盘 ----------
function moveFocus(days: number) {
  const f = parseKey(focusKey.value) ?? { y: viewY.value, m: viewM.value, d: 1 }
  const dt = new Date(f.y, f.m, f.d + days)
  focusKey.value = toKey(dt.getFullYear(), dt.getMonth(), dt.getDate())
  // 焦点行跨月时视图跟随
  viewY.value = dt.getFullYear()
  viewM.value = dt.getMonth()
  focusCell()
}

function shiftMonth(delta: number) {
  const dt = new Date(viewY.value, viewM.value + delta, 1)
  viewY.value = dt.getFullYear()
  viewM.value = dt.getMonth()
  // 焦点「日」保持不变，超出当月收敛到月末
  const f = parseKey(focusKey.value)
  if (f) {
    const maxD = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate()
    focusKey.value = toKey(dt.getFullYear(), dt.getMonth(), Math.min(f.d, maxD))
  }
  focusCell()
}

function onTriggerKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (!open.value) openPanel()
  }
  // Enter/空格走按钮默认 click → toggle
}

function onPanelKey(e: KeyboardEvent) {
  // 时间行 / 底栏控件自行处理键盘（仅 Esc 仍收起面板，不透传给 Modal）
  if ((e.target as HTMLElement | null)?.closest('.dp-time-row, .dp-foot')) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      closePanel(true)
    }
    return
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault()
    moveFocus(-1)
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    moveFocus(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveFocus(-7)
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveFocus(7)
  } else if (e.key === 'PageUp') {
    e.preventDefault()
    shiftMonth(-1)
  } else if (e.key === 'PageDown') {
    e.preventDefault()
    shiftMonth(1)
  } else if (e.key === 'Escape') {
    // 仅收起面板，不透传给 Modal 的 Esc 关闭
    e.stopPropagation()
    closePanel(true)
  }
  // Enter/空格在格子按钮上触发 click → pick
}

function onRootFocusOut(e: FocusEvent) {
  if (!open.value) return
  const to = e.relatedTarget as Node | null
  if (to && rootEl.value?.contains(to)) return
  closePanel()
}

// ---------- 点击外部收起（捕获阶段，先于面板内 click 判定） ----------
function onDocPointerDown(e: PointerEvent) {
  if (!open.value) return
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) closePanel()
}

onMounted(() => document.addEventListener('pointerdown', onDocPointerDown, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown, true))
</script>

<template>
  <div ref="rootEl" class="dp" @focusout="onRootFocusOut">
    <button
      ref="triggerEl"
      type="button"
      class="dp-trigger"
      :class="{ open, empty: !displayText }"
      :aria-label="ariaLabel"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click="toggle"
      @keydown="onTriggerKey"
    >
      <span class="dp-text">{{ displayText || placeholder }}</span>
      <Icon name="calendar" :size="14" class="dp-ic" />
    </button>

    <div
      v-if="open"
      ref="panelEl"
      class="dp-panel"
      :class="{ up }"
      role="dialog"
      :aria-label="ariaLabel"
      @keydown="onPanelKey"
    >
      <div class="dp-head">
        <button type="button" class="dp-nav" aria-label="上一月" @click="shiftMonth(-1)">
          <Icon name="chevron-left" :size="13" :stroke-width="2.1" />
        </button>
        <span class="dp-title" aria-live="polite">{{ viewLabel }}</span>
        <button type="button" class="dp-nav" aria-label="下一月" @click="shiftMonth(1)">
          <Icon name="chevron-right" :size="13" :stroke-width="2.1" />
        </button>
      </div>

      <div class="dp-week" aria-hidden="true">
        <span v-for="w in WEEK" :key="w">{{ w }}</span>
      </div>

      <div class="dp-grid" role="grid" :aria-label="`${viewLabel}日历`">
        <div v-for="(row, ri) in rows" :key="ri" class="dp-row" role="row">
          <button
            v-for="c in row"
            :key="c.key"
            type="button"
            class="dp-cell"
            role="gridcell"
            :class="{ out: !c.inMonth, today: c.isToday, sel: c.isSel }"
            :data-key="c.key"
            :tabindex="c.key === focusKey ? 0 : -1"
            :aria-selected="c.isSel"
            :aria-current="c.isToday ? 'date' : undefined"
            :aria-label="`${c.y}年${c.m + 1}月${c.d}日${c.isToday ? '，今天' : ''}`"
            @click="pick(c.y, c.m, c.d)"
            @focus="focusKey = c.key"
          >
            {{ c.d }}
          </button>
        </div>
      </div>

      <div v-if="withTime" class="dp-time-row">
        <span class="dp-time-label">时间</span>
        <div class="dp-time">
          <select v-model="timeH" class="dp-tsel" aria-label="时" @change="commitTime">
            <option v-for="h in HOURS" :key="h" :value="h">{{ h }}</option>
          </select>
          <span class="dp-tsep" aria-hidden="true">:</span>
          <select v-model="timeM" class="dp-tsel" aria-label="分" @change="commitTime">
            <option v-for="m in MINUTES" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
      </div>

      <div class="dp-foot">
        <div class="dp-foot-l">
          <button type="button" class="dp-link" @click="pickToday">今天</button>
          <button type="button" class="dp-link dim" @click="clear">清除</button>
        </div>
        <button v-if="withTime" type="button" class="dp-done" @click="closePanel(true)">确定</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dp {
  position: relative;
}

/* ---------- 触发器：与全局输入框同款承接口（卯槽深） ---------- */
.dp-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--code-bg);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.dp-trigger:hover {
  border-color: rgb(99 102 241 / 45%);
}

.dp-trigger.open {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgb(99 102 241 / 26%);
}

.dp-trigger.empty .dp-text {
  color: var(--text-3);
}

.dp-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.dp-ic {
  color: var(--text-3);
  transition: color 0.15s;
}

.dp-trigger:hover .dp-ic,
.dp-trigger.open .dp-ic {
  color: #a5b4fc;
}

/* ---------- 弹出面板 ---------- */
.dp-panel {
  position: absolute;
  z-index: 40;
  top: calc(100% + 4px);
  right: 0;
  width: 100%;
  min-width: 258px;
  padding: 10px 12px 8px;
  background: var(--panel-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  animation: dp-in 0.15s ease-out;
}

.dp-panel.up {
  top: auto;
  bottom: calc(100% + 4px);
  animation-name: dp-in-up;
}

@keyframes dp-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}

@keyframes dp-in-up {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}

/* ---------- 头部：翻月 ---------- */
.dp-head {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
}

.dp-title {
  flex: 1;
  text-align: center;
  font-size: 13.5px;
  font-weight: 600;
  color: #fff;
  letter-spacing: 0.2px;
}

.dp-nav {
  width: 26px;
  height: 26px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  border-radius: 7px;
  color: var(--text-2);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.dp-nav:hover {
  background: var(--hover);
  color: #fff;
}

/* ---------- 星期行与日期网格 ---------- */
.dp-week,
.dp-row {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.dp-week {
  padding-bottom: 4px;
}

.dp-week span {
  text-align: center;
  font-size: 11px;
  line-height: 22px;
  color: var(--text-3);
}

.dp-grid {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dp-cell {
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  border-radius: 7px;
  color: var(--text);
  font-size: 12.5px;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: background 0.12s, color 0.12s, box-shadow 0.12s;
}

.dp-cell:hover {
  background: var(--accent-weak);
  color: #fff;
}

.dp-cell.out {
  color: var(--text-3);
  opacity: 0.55;
}

/* 今天：靛描边（选中态覆盖时让位） */
.dp-cell.today {
  color: #a5b4fc;
  font-weight: 600;
  box-shadow: inset 0 0 0 1px rgb(99 102 241 / 55%);
}

/* 选中：品牌渐变底（同主按钮） */
.dp-cell.sel {
  background: var(--grad-brand);
  color: #fff;
  font-weight: 600;
  box-shadow: 0 4px 12px -5px rgb(79 70 229 / 65%);
}

.dp-cell.sel:hover {
  filter: brightness(1.08);
}

/* ---------- 底栏：今天 / 清除 ---------- */
.dp-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.dp-foot-l {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* withTime 模式「确定」：选值已即时提交，仅收起面板 */
.dp-done {
  border: none;
  padding: 4px 12px;
  border-radius: 7px;
  background: var(--grad-brand);
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: filter 0.15s;
}

.dp-done:hover {
  filter: brightness(1.08);
}

/* ---------- 时间选择（withTime 模式：时/分下拉；width:auto 抵消全局 select 的 100%） ---------- */
.dp-time-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.dp-time-label {
  font-size: 12px;
  color: var(--text-3);
}

.dp-time {
  display: flex;
  align-items: center;
  gap: 4px;
}

.dp-tsel {
  width: auto;
  height: 26px;
  padding: 0 4px 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--code-bg);
  color: var(--text);
  font-size: 12.5px;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  outline: none;
  color-scheme: dark;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.dp-tsel:hover {
  border-color: rgb(99 102 241 / 45%);
}

.dp-tsel:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgb(99 102 241 / 26%);
}

.dp-tsep {
  color: var(--text-2);
  font-weight: 600;
  font-size: 13px;
}

/* 时间行已有分隔线，底栏不再重复画线 */
.dp-time-row + .dp-foot {
  margin-top: 4px;
  padding-top: 0;
  border-top: none;
}

.dp-link {
  border: none;
  background: none;
  padding: 2px 4px;
  border-radius: 6px;
  font-size: 12px;
  font-family: inherit;
  color: var(--accent-h);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.dp-link:hover {
  color: #a5b4fc;
}

.dp-link.dim {
  color: var(--text-3);
}

.dp-link.dim:hover {
  color: var(--text-2);
}

@media (prefers-reduced-motion: reduce) {
  .dp-panel {
    animation: none;
  }

  .dp-trigger,
  .dp-ic,
  .dp-nav,
  .dp-cell,
  .dp-link,
  .dp-tsel,
  .dp-done {
    transition: none;
  }
}
</style>
