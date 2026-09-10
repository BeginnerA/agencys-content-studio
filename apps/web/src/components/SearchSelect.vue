<script setup lang="ts">
// 可搜索下拉（combobox）：候选过多时输入即过滤。
// - 聚焦未输入时展示完整候选（当前值高亮）；输入后按子串过滤
// - 键盘：↑/↓ 导航 · Enter 选择 · Esc 回退并收起（不透传给 Modal）
// - creatable：输入不在候选内的值可直接提交（列表顶部出现「使用「xxx」」行）
// - 超大目录保护：仅渲染前 maxRender 条并提示继续输入
// - 失焦收尾：精确匹配则提交，否则回退到已提交值（防半截输入误提交）
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import Icon from './Icon.vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    /** 候选列表（保持传入顺序，如预置置顶） */
    options: string[]
    placeholder?: string
    /** 提供时：输入为空时列表顶部固定「空值」项（如：使用供应商默认模型） */
    blankLabel?: string
    /** 允许直接提交输入框中的自定义值 */
    creatable?: boolean
    /** 渲染保护：匹配数超过则截断并提示 */
    maxRender?: number
    ariaLabel?: string
  }>(),
  { placeholder: '搜索…', blankLabel: '', creatable: true, maxRender: 300, ariaLabel: '' },
)
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const listId = `ss-${useId()}`

const rootEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const dropEl = ref<HTMLElement | null>(null)

const open = ref(false)
/** 空间不足时向上展开 */
const up = ref(false)
/** 下拉最大高度（按展开侧可视空间自适应，避免被弹窗裁剪） */
const dropMax = ref(248)
/** 本次聚焦后是否输入过（未输入展示完整列表） */
const dirty = ref(false)
/** 输入框草稿（未提交） */
const query = ref(props.modelValue)
/** 键盘高亮行下标 */
const hi = ref(-1)

interface Row {
  key: string
  label: string
  value: string
  kind: 'blank' | 'option' | 'custom'
}

/** 候选池：当前值不在目录时补一条（编辑场景目录刷新前仍可见） */
const pool = computed(() => {
  const out: string[] = []
  const cur = props.modelValue
  if (cur && !props.options.includes(cur)) out.push(cur)
  for (const o of props.options) if (!out.includes(o)) out.push(o)
  return out
})

const q = computed(() => query.value.trim())
const filtering = computed(() => dirty.value && q.value !== '')

const matched = computed(() => {
  if (!filtering.value) return pool.value
  const f = q.value.toLowerCase()
  return pool.value.filter((o) => o.toLowerCase().includes(f))
})

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  if (!q.value && props.blankLabel) {
    out.push({ key: '__blank__', label: props.blankLabel, value: '', kind: 'blank' })
  }
  const hasExact = pool.value.some((o) => o.toLowerCase() === q.value.toLowerCase())
  if (props.creatable && filtering.value && !hasExact) {
    out.push({ key: '__custom__', label: q.value, value: q.value, kind: 'custom' })
  }
  for (const m of matched.value.slice(0, props.maxRender)) {
    out.push({ key: `m:${m}`, label: m, value: m, kind: 'option' })
  }
  return out
})

const hiddenCount = computed(() => Math.max(0, matched.value.length - props.maxRender))

// 父组件更新值（如编辑回填 / 重置）时同步草稿
watch(
  () => props.modelValue,
  (v) => {
    query.value = v
  },
)

// 候选异步到达时收敛越界高亮
watch(rows, (r) => {
  if (open.value && hi.value >= r.length) hi.value = r.length ? 0 : -1
})

/** 最近的纵向滚动祖先（用于判断展开方向；找不到时退化为视口） */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let n = el?.parentElement ?? null
  while (n) {
    if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n
    n = n.parentElement
  }
  return null
}

function scrollHi() {
  void nextTick(() => {
    dropEl.value?.querySelector<HTMLElement>(`[data-idx="${hi.value}"]`)?.scrollIntoView({ block: 'nearest' })
  })
}

function openList() {
  open.value = true
  dirty.value = false
  query.value = props.modelValue
  const i = rows.value.findIndex((r) => r.kind === 'option' && r.value === props.modelValue)
  hi.value = i >= 0 ? i : rows.value.length ? 0 : -1
  void nextTick(() => {
    const box = inputEl.value?.getBoundingClientRect()
    if (box) {
      // 按最近滚动容器的可视空间选择展开方向，并自适应高度
      const sp = scrollParent(rootEl.value)
      const sb = sp?.getBoundingClientRect()
      const below = (sb ? sb.bottom : window.innerHeight) - box.bottom - 8
      const above = box.top - (sb ? sb.top : 0) - 8
      up.value = above > below && below < 248
      dropMax.value = Math.max(160, Math.min(248, up.value ? above : below))
    }
    scrollHi()
  })
}

function close() {
  open.value = false
  dirty.value = false
  hi.value = -1
}

/** 收起并回退到已提交值 */
function cancel() {
  query.value = props.modelValue
  close()
}

function commit(v: string) {
  query.value = v
  emit('update:modelValue', v)
  close()
}

/** 失焦收尾：精确匹配提交，否则回退（防半截输入误提交） */
function settle() {
  const exact = pool.value.find((o) => o.toLowerCase() === q.value.toLowerCase())
  if (exact !== undefined && exact !== props.modelValue) commit(exact)
  else cancel()
}

function onInput(e: Event) {
  query.value = (e.target as HTMLInputElement).value
  dirty.value = true
  if (!open.value) open.value = true
  const blankIdx = rows.value.findIndex((r) => r.kind === 'blank')
  const exact = rows.value.findIndex((r) => r.kind === 'option' && r.value.toLowerCase() === q.value.toLowerCase())
  const first = rows.value.findIndex((r) => r.kind === 'option')
  hi.value =
    q.value === '' && blankIdx >= 0 ? blankIdx : exact >= 0 ? exact : first >= 0 ? first : rows.value.length ? 0 : -1
  scrollHi()
}

function onKeydown(e: KeyboardEvent) {
  if (e.isComposing) return // 输入法组字中不拦截
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (!open.value) {
      openList()
      return
    }
    if (!rows.value.length) return
    const dir = e.key === 'ArrowDown' ? 1 : -1
    hi.value = (hi.value + dir + rows.value.length) % rows.value.length
    scrollHi()
  } else if (e.key === 'Enter') {
    const row = open.value && hi.value >= 0 ? rows.value[hi.value] : undefined
    if (row) {
      e.preventDefault()
      commit(row.value)
    } else if (!open.value && props.creatable && q.value && q.value !== props.modelValue) {
      e.preventDefault()
      commit(q.value)
    }
  } else if (e.key === 'Escape') {
    if (open.value) {
      e.stopPropagation() // 仅收起下拉，不透传给 Modal 的 Esc 关闭
      cancel()
    }
  } else if (e.key === 'Tab') {
    if (open.value) settle()
  }
}

function onDocPointerDown(e: PointerEvent) {
  if (!open.value) return
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) settle()
}

onMounted(() => document.addEventListener('pointerdown', onDocPointerDown, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown, true))
</script>

<template>
  <div ref="rootEl" class="ss" :class="{ open }">
    <div class="box">
      <Icon name="search" :size="14" class="lead" />
      <input
        ref="inputEl"
        type="text"
        :value="query"
        :placeholder="placeholder"
        :aria-label="ariaLabel || undefined"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="open"
        :aria-controls="listId"
        :aria-activedescendant="open && hi >= 0 ? `${listId}-${hi}` : undefined"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        @focus="openList"
        @input="onInput"
        @keydown="onKeydown"
        @click="!open && openList()"
      />
      <Icon name="chevron-down" :size="14" class="caret" />
    </div>
    <div v-if="open" ref="dropEl" class="drop" :class="{ up }" :style="{ maxHeight: dropMax + 'px' }">
      <div :id="listId" role="listbox" :aria-label="ariaLabel || '候选列表'">
        <div
          v-for="(r, i) in rows"
          :id="`${listId}-${i}`"
          :key="r.key"
          class="opt"
          :class="{
            hi: i === hi,
            cur: r.kind === 'option' && r.value === modelValue,
            blank: r.kind === 'blank',
            custom: r.kind === 'custom',
          }"
          role="option"
          :aria-selected="r.kind === 'option' && r.value === modelValue"
          :data-idx="i"
          :title="r.kind === 'option' ? r.value : undefined"
          @mouseenter="hi = i"
          @click="commit(r.value)"
        >
          <span class="ck">
            <Icon
              v-if="(r.kind === 'option' && r.value === modelValue) || (r.kind === 'blank' && modelValue === '')"
              name="check"
              :size="12"
              :stroke-width="2.2"
            />
          </span>
          <span class="lb">
            <template v-if="r.kind === 'custom'">使用「<b>{{ r.value }}</b>」</template>
            <template v-else-if="r.kind === 'blank'">{{ r.label }}</template>
            <template v-else
              >{{ r.value }}<span v-if="r.value === modelValue" class="sfx">（当前）</span></template
            >
          </span>
        </div>
      </div>
      <div v-if="!rows.length" class="hint">无匹配模型，可直接输入模型 ID</div>
      <div v-if="hiddenCount > 0" class="hint">
        共 {{ matched.length }} 个匹配，仅显示前 {{ maxRender }} 个 — 继续输入以缩小范围
      </div>
    </div>
  </div>
</template>

<style scoped>
.ss {
  position: relative;
}

.box {
  position: relative;
  display: flex;
  align-items: center;
}

.box input {
  padding-left: 31px;
  padding-right: 28px;
}

.lead {
  position: absolute;
  left: 10px;
  color: var(--text-3);
  pointer-events: none;
}

.caret {
  position: absolute;
  right: 10px;
  color: var(--text-3);
  pointer-events: none;
  transition: transform 0.16s ease, color 0.16s ease;
}

.ss.open .caret {
  transform: rotate(180deg);
  color: var(--text-2);
}

.drop {
  position: absolute;
  z-index: 40;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 248px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px;
  background: var(--panel-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lg);
  animation: ss-in 0.12s ease-out;
}

.drop.up {
  top: auto;
  bottom: calc(100% + 4px);
}

@keyframes ss-in {
  from {
    opacity: 0;
  }
}

.opt {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 12.5px;
  font-family: var(--mono);
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
}

.opt .ck {
  width: 14px;
  height: 14px;
  flex: none;
  display: inline-flex;
  align-items: center;
  color: var(--accent-h);
}

.opt .lb {
  overflow: hidden;
  text-overflow: ellipsis;
}

.opt.hi {
  background: var(--accent-weak);
}

.opt.cur {
  color: #fff;
}

.opt.blank {
  font-family: inherit;
  color: var(--text-3);
}

.opt.custom {
  color: var(--accent-h);
}

.opt.custom b {
  font-weight: 600;
}

.opt .sfx {
  color: var(--text-3);
}

.hint {
  padding: 7px 8px;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.5;
}

@media (prefers-reduced-motion: reduce) {
  .drop {
    animation: none;
  }

  .caret {
    transition: none;
  }
}
</style>
