<script lang="ts">
export interface ActionMenuItem {
  id: string
  label: string
  icon?: string
  detail?: string
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  separator?: boolean
  action: () => unknown
}
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import Icon from './Icon.vue'

const props = withDefaults(
  defineProps<{
    label: string
    icon?: string
    items: ActionMenuItem[]
    disabled?: boolean
    align?: 'start' | 'end'
  }>(),
  { align: 'start' },
)
const menuId = `action-menu-${useId()}`
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const open = ref(false)
const position = ref({
  left: '0px',
  top: '0px',
  visibility: 'hidden' as 'hidden' | 'visible',
})

function close(restoreFocus = false): void {
  open.value = false
  if (restoreFocus) trigger.value?.focus()
}

function enabledButtons(): HTMLButtonElement[] {
  return Array.from(
    menu.value?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    ) ?? [],
  )
}

async function show(last = false): Promise<void> {
  if (props.disabled) return
  open.value = true
  position.value.visibility = 'hidden'
  await nextTick()
  if (!open.value || !trigger.value || !menu.value) return
  const anchor = trigger.value.getBoundingClientRect()
  const box = menu.value.getBoundingClientRect()
  const x = props.align === 'end' ? anchor.right - box.width : anchor.left
  const below = anchor.bottom + 6
  const y =
    below + box.height > window.innerHeight - 8
      ? anchor.top - box.height - 6
      : below
  position.value = {
    left: `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`,
    top: `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`,
    visibility: 'visible',
  }
  // 等待浮层真正可见后再聚焦，避免 visibility:hidden 吞掉焦点。
  await nextTick()
  if (!open.value) return
  const buttons = enabledButtons()
  const target = (last ? buttons.at(-1) : buttons[0]) ?? menu.value
  target?.focus()
}

function pick(item: ActionMenuItem): void {
  if (props.disabled || item.disabled) return
  close(true)
  void item.action()
}

function onMenuKey(event: KeyboardEvent): void {
  // 菜单内按键不触发画布的删除、全选或方向键微移。
  event.stopPropagation()
  if (event.key === 'Escape') {
    event.preventDefault()
    close(true)
    return
  }
  if (event.key === 'Tab') {
    close(true)
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = enabledButtons()
  if (!buttons.length) return
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
          buttons.length
  buttons[next]?.focus()
}

function onOutside(event: Event): void {
  const target = event.target
  if (
    open.value &&
    target instanceof Node &&
    !menu.value?.contains(target) &&
    !trigger.value?.contains(target)
  )
    close()
}
function onScroll(event: Event): void {
  if (!(event.target instanceof Node) || !menu.value?.contains(event.target))
    close()
}
function onResize(): void {
  close()
}
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) close()
  },
)
onMounted(() => {
  document.addEventListener('pointerdown', onOutside, true)
  document.addEventListener('click', onOutside, true)
  document.addEventListener('focusin', onOutside)
  window.addEventListener('resize', onResize)
  window.addEventListener('scroll', onScroll, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onOutside, true)
  document.removeEventListener('click', onOutside, true)
  document.removeEventListener('focusin', onOutside)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('scroll', onScroll, true)
})
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="btn action-menu-trigger"
    :class="{ 'is-open': open }"
    :disabled="disabled"
    :aria-expanded="open"
    aria-haspopup="menu"
    :aria-controls="open ? menuId : undefined"
    @click="open ? close() : show()"
    @keydown.space.stop
    @keydown.down.stop.prevent="show()"
    @keydown.up.stop.prevent="show(true)"
    @keydown.esc.stop.prevent="close(true)"
  >
    <Icon v-if="icon" :name="icon" :size="15" />
    <span>{{ label }}</span>
    <Icon name="chevron-down" :size="11" />
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      :id="menuId"
      ref="menu"
      class="action-menu panel"
      role="menu"
      tabindex="-1"
      :aria-label="label"
      :style="position"
      @keydown="onMenuKey"
      @pointerdown.stop
      @dblclick.stop
    >
      <template v-for="item in items" :key="item.id">
        <div
          v-if="item.separator"
          class="action-menu-separator"
          role="separator"
        />
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          class="action-menu-item"
          :class="{ danger: item.danger }"
          :disabled="item.disabled"
          @click="pick(item)"
        >
          <Icon v-if="item.icon" :name="item.icon" :size="16" />
          <span class="action-menu-copy"
            ><span>{{ item.label }}</span
            ><small v-if="item.detail">{{ item.detail }}</small></span
          >
          <kbd v-if="item.shortcut">{{ item.shortcut }}</kbd>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.action-menu-trigger {
  min-height: 36px;
  padding: 7px 10px;
  white-space: nowrap;
  font-family: inherit;
}
.action-menu-trigger.is-open {
  border-color: var(--accent);
  background: var(--accent-weak);
}
.action-menu {
  position: fixed;
  z-index: 100;
  width: 272px;
  max-width: calc(100vw - 16px);
  max-height: calc(100dvh - 16px);
  overflow-y: auto;
  padding: 6px;
  border-color: var(--border-strong);
  box-shadow: var(--shadow-lg);
}
.action-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 40px;
  padding: 9px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  text-align: left;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.action-menu-item:hover:not(:disabled),
.action-menu-item:focus-visible {
  background: var(--raised);
}
.action-menu-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.action-menu-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.action-menu-item.danger {
  color: var(--bad);
}
.action-menu-item.danger:hover:not(:disabled) {
  background: var(--bad-weak);
}
.action-menu-copy {
  display: grid;
  gap: 3px;
  flex: 1;
  min-width: 0;
}
.action-menu-copy small {
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.5;
}
.action-menu-item kbd {
  color: var(--text-2);
  font: 11px var(--mono);
  white-space: nowrap;
}
.action-menu-separator {
  height: 1px;
  margin: 5px 6px;
  background: var(--border);
}
@media (pointer: coarse) {
  .action-menu-trigger,
  .action-menu-item {
    min-height: 44px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .action-menu-trigger {
    transition: none;
  }
}
</style>
