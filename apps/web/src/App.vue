<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getSocket } from './lib/socket'
import Icon from './components/common/Icon.vue'
import ConfirmHost from './components/common/ConfirmHost.vue'
import CommandPalette from './components/common/CommandPalette.vue'
import { pending, refreshPending, startPendingWatcher } from './lib/pending'
import { initNotify } from './lib/notify'
import { bindHotkey, initHotkeys } from './lib/hotkeys'
import { NAVS } from './lib/nav'

const route = useRoute()
const router = useRouter()
let stopPendingWatcher: (() => void) | null = null

// [M21] 全局命令面板（Ctrl/Cmd+K 经 lib/hotkeys 单例注册；批 2 已迁移统一键盘流）
const paletteOpen = ref(false)
let unbindPaletteKey: (() => void) | null = null

// 侧栏折叠：偏好持久化到 localStorage（不可用时静默降级为展开）
const SIDE_KEY = 'agencys.side.collapsed'
const collapsed = ref(false)
try {
  collapsed.value = localStorage.getItem(SIDE_KEY) === '1'
} catch {
  /* 隐私模式等场景忽略 */
}

function toggleSide() {
  collapsed.value = !collapsed.value
  try {
    localStorage.setItem(SIDE_KEY, collapsed.value ? '1' : '0')
  } catch {
    /* 持久化失败不影响折叠 */
  }
}

// 主导航（定义于 lib/nav.ts，与命令面板共享；「项目」含全局待审阅角标）

onMounted(() => {
  // 全局单连接：先连接便于页面级 join room（重复 connect 由 io 单例避免）
  const s = getSocket()
  if (!s.connected) s.connect()
  // 全局待审阅角标：首拉 + 30s 轮询 + 可见性恢复
  stopPendingWatcher = startPendingWatcher()
  // [M21] 浏览器通知（run 终态 / 闸门 / 批次收敛；不可用静默降级）
  initNotify(router)
  // [M21] 全局快捷键：唯一文档级监听 + Ctrl/Cmd+K 切换命令面板
  initHotkeys()
  unbindPaletteKey = bindHotkey({ key: 'k', ctrlOrMeta: true }, () => {
    paletteOpen.value = !paletteOpen.value
  })
})

// 路由切换时刷新待审阅角标（导航后数据可能已过期；并发合并避免重复请求）
watch(
  () => route.fullPath,
  () => void refreshPending(),
)

onBeforeUnmount(() => {
  // 不主动断开：单页内多个视图共享连接
  stopPendingWatcher?.()
  unbindPaletteKey?.()
})
</script>

<template>
  <div class="layout">
    <aside class="side" :class="{ collapsed }">
      <div class="logo">
        <span class="mark" aria-label="百工工作室">
          <!-- 品牌 mark「榫卯拼块」：紫→靛台面 + 深色卯槽 + 悬停翠绿公件 -->
          <svg viewBox="0 0 84 84" aria-hidden="true">
            <defs>
              <linearGradient id="mkbg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="#8b5cf6" />
                <stop offset=".62" stop-color="#6366f1" />
                <stop offset="1" stop-color="#4f46e5" />
              </linearGradient>
              <linearGradient id="mkg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#4ade80" />
                <stop offset="1" stop-color="#22c55e" />
              </linearGradient>
            </defs>
            <rect width="84" height="84" rx="19" fill="url(#mkbg)" />
            <rect x="22" y="33" width="13" height="24" rx="3.5" fill="#0d1730" />
            <rect x="22" y="33" width="6.5" height="24" rx="3" fill="#16224a" />
            <rect x="41.5" y="28.5" width="25" height="33" rx="8.5" fill="url(#mkg)" />
            <rect x="34.5" y="38" width="7" height="14" rx="2.4" fill="url(#mkg)" />
          </svg>
        </span>
        <span class="lt">
          百工工作室
          <small>模板化流水线工作台</small>
        </span>
      </div>
      <button
        class="search-btn"
        type="button"
        aria-label="搜索（Ctrl K）"
        :title="collapsed ? '搜索（Ctrl K）' : undefined"
        @click="paletteOpen = true"
      >
        <Icon name="search" :size="15" />
        <span class="lb">搜索</span>
        <kbd>Ctrl K</kbd>
      </button>
      <nav id="side-nav" class="navs">
        <RouterLink
          v-for="n in NAVS"
          :key="n.to"
          class="nav"
          :to="n.to"
          :title="collapsed ? n.label : undefined"
        >
          <Icon :name="n.icon" :size="16" />
          <span class="lb">{{ n.label }}</span>
          <span
            v-if="n.to === '/' && pending.total > 0"
            class="nbadge"
            :title="`${pending.total} 项待审阅`"
            :aria-label="`${pending.total} 项待审阅`"
          >{{ pending.total }}</span>
        </RouterLink>
      </nav>
      <button
        class="collapse"
        type="button"
        :aria-expanded="!collapsed"
        aria-controls="side-nav"
        :aria-label="collapsed ? '展开侧栏菜单' : '折叠侧栏菜单'"
        :title="collapsed ? '展开侧栏菜单' : '折叠侧栏菜单'"
        @click="toggleSide"
      >
        <Icon :name="collapsed ? 'chevron-right' : 'chevron-left'" :size="16" />
      </button>
      <div class="foot">
        agencys · 本地单机<br />
        模板 · 资产 · 闸门
      </div>
    </aside>
    <main class="main">
      <RouterView />
    </main>
    <!-- 全局命令式确认弹窗（confirmDialog()）宿主 -->
    <ConfirmHost />
    <!-- [M21] 全局命令面板（搜索直达；Ctrl/Cmd+K 或侧栏按钮打开） -->
    <CommandPalette v-if="paletteOpen" @close="paletteOpen = false" />
  </div>
</template>
